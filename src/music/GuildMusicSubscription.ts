import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, VoiceConnection } from '@discordjs/voice';
import { MessageFlags, type Message, type SendableChannels } from 'discord.js';
import { buildMusicPlayerDisplay } from '../core/display';
import type { Logger } from '../core/logger';
import type { LoopMode, Track, TrackSource } from '../core/types';

export type OnTrackStart = (track: Track) => void | Promise<void>;

const HISTORY_MAX = 25;
/** How often to edit the now-playing panel (ms). 1s feels live; Discord allows ~5 edits/5s/channel. */
const PROGRESS_TICK_MS = 1_000;

/**
 * Owns the voice connection, audio player, and queue for a single guild.
 * Advancing the queue is driven by the player's Idle event; when the queue
 * drains, an idle timer disconnects the bot after a grace period.
 */
export class GuildMusicSubscription {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loopMode: LoopMode = 'off';
  /** Last stream/play failure message (for /play to surface to the user). */
  lastError: string | null = null;

  /** Vote-skip state for the current track (user ids). */
  private skipVotes = new Set<string>();
  private skipVoteTrackKey: string | null = null;

  /** Recently finished / skipped tracks for the Previous control. */
  private history: Track[] = [];
  /** Active audio resource — used for playback position (progress bar). */
  private currentResource: AudioResource | null = null;
  /** When true, Idle should not auto-advance (used by previous/restart). */
  private suppressIdleAdvance = false;

  /**
   * Live “Music Player” message in the text channel (Components V2).
   * On each new track we delete the old message and post a fresh one.
   * Edited every second so the progress bar tracks real playback time.
   */
  private nowPlayingMessage: Message | null = null;
  /** Text channel used to post now-playing panels (from /play or last NP message). */
  private announceChannel: SendableChannels | null = null;
  /** Bumps on each announce so overlapping track starts don't restore a stale panel. */
  private announceSerial = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressEditInFlight = false;
  private lastPostedPosSec = -1;
  private lastPostedPaused: boolean | null = null;
  private lastPostedTrackKey: string | null = null;

  private readonly player: AudioPlayer;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private playGeneration = 0;
  /** Consecutive stream failures — stop burning the queue when the music bridge dies. */
  private consecutiveStreamFailures = 0;
  /** Prevent overlapping processQueue runners (Idle + explicit skip can race). */
  private queuePumpRunning = false;

  private queueSnapshot: Track[] = []; // used for 'queue' loop mode

  constructor(
    readonly connection: VoiceConnection,
    private readonly source: TrackSource,
    private readonly logger: Logger,
    private readonly idleTimeoutSec: number,
    private readonly onDestroy: () => void,
    private readonly onTrackStart?: OnTrackStart,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.suppressIdleAdvance) {
        this.suppressIdleAdvance = false;
        return;
      }
      const finished = this.current;
      this.current = null;
      this.currentResource = null;
      this.lastPostedPosSec = -1;

      if (finished) {
        if (this.loopMode === 'track') {
          // Re-queue the finished track immediately for repeat (don't pollute history)
          this.queue.unshift(finished);
        } else {
          this.pushHistory(finished);
        }
      }

      void this.processQueue();
    });
    this.player.on('error', (error) => {
      this.logger.error('Audio player error:', error);
      this.current = null;
      this.currentResource = null;
      void this.processQueue();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  /** Elapsed playback time in seconds for the progress bar (0 if unknown). */
  getPlaybackPositionSec(): number {
    if (!this.currentResource) return 0;
    // playbackDuration is in milliseconds
    const ms = this.currentResource.playbackDuration;
    if (!Number.isFinite(ms) || ms < 0) return 0;
    return ms / 1000;
  }

  /**
   * Remember where to post now-playing messages (text channel of /play).
   * Required so auto-advance can post a new panel when a song changes.
   */
  setAnnounceChannel(channel: SendableChannels | null): void {
    this.announceChannel = channel;
  }

  getAnnounceChannel(): SendableChannels | null {
    return this.announceChannel;
  }

  /**
   * Attach / replace the live now-playing panel. Starts the 1s progress ticker.
   * Pass `null` to detach (timer stops). Prefer letting `publishFreshNowPlaying`
   * create panels on track start; this is used after /play or control updates.
   */
  setNowPlayingMessage(message: Message | null): void {
    const same = Boolean(message && this.nowPlayingMessage?.id === message.id);
    this.nowPlayingMessage = message;

    if (message?.channel?.isSendable()) {
      this.announceChannel = message.channel;
    }

    if (!message || !this.current) {
      this.stopProgressTimer();
      this.lastPostedPosSec = -1;
      this.lastPostedPaused = null;
      this.lastPostedTrackKey = null;
      return;
    }

    this.startProgressTimer();
    if (same) {
      // Panel already shows current state (e.g. after a button update) — avoid a double edit.
      this.lastPostedPosSec = Math.floor(this.getPlaybackPositionSec());
      this.lastPostedPaused = this.paused;
      this.lastPostedTrackKey = this.trackKey(this.current);
      return;
    }

    this.lastPostedPosSec = -1;
    this.lastPostedPaused = null;
    this.lastPostedTrackKey = null;
    // Immediate paint so UI isn’t stuck at 0:00 until the first tick
    void this.refreshNowPlayingMessage(true);
  }

  getNowPlayingMessage(): Message | null {
    return this.nowPlayingMessage;
  }

  /**
   * Delete the previous now-playing message and post a fresh player panel
   * for the track that just started. Called on every successful playTrack.
   */
  async publishFreshNowPlaying(track: Track): Promise<void> {
    if (this.destroyed) return;

    const channel = this.announceChannel;
    if (!channel) {
      // No channel yet (e.g. /play hasn't wired it) — refresh existing panel if any.
      if (this.nowPlayingMessage) {
        this.startProgressTimer();
        void this.refreshNowPlayingMessage(true);
      }
      return;
    }

    const serial = ++this.announceSerial;
    const old = this.nowPlayingMessage;
    this.nowPlayingMessage = null;
    this.stopProgressTimer();
    this.lastPostedPosSec = -1;
    this.lastPostedPaused = null;
    this.lastPostedTrackKey = null;

    if (old) {
      try {
        await old.delete();
      } catch {
        /* already deleted / missing access */
      }
    }

    if (this.destroyed || serial !== this.announceSerial) return;

    const display = buildMusicPlayerDisplay({
      track,
      positionSec: 0,
      queueLength: this.queue.length,
      paused: this.paused,
      loopMode: this.loopMode,
      label: 'Now Playing',
    });

    try {
      const msg = await channel.send({
        components: display.components,
        flags: MessageFlags.IsComponentsV2,
      });
      if (this.destroyed || serial !== this.announceSerial) {
        try {
          await msg.delete();
        } catch {
          /* ignore */
        }
        return;
      }
      // Attach without re-triggering a full repaint race
      this.nowPlayingMessage = msg;
      this.startProgressTimer();
      this.lastPostedPosSec = 0;
      this.lastPostedPaused = this.paused;
      this.lastPostedTrackKey = this.trackKey(track);
    } catch (err) {
      this.logger.debug('Failed to post now-playing message:', err);
    }
  }

  private trackKey(track: Track | null): string | null {
    if (!track) return null;
    return track.url || track.title;
  }

  private startProgressTimer(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      void this.refreshNowPlayingMessage(false);
    }, PROGRESS_TICK_MS);
    // Don't keep the Node process alive solely for UI ticks
    if (typeof this.progressTimer === 'object' && 'unref' in this.progressTimer) {
      this.progressTimer.unref();
    }
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /**
   * Edit the now-playing Components V2 message with the latest position / state.
   * @param force — update even if position second hasn’t changed (track/pause flip).
   */
  async refreshNowPlayingMessage(force = false): Promise<void> {
    const msg = this.nowPlayingMessage;
    if (!msg || this.destroyed || this.progressEditInFlight) return;

    const track = this.current;
    if (!track) {
      this.stopProgressTimer();
      return;
    }

    const posSec = Math.floor(this.getPlaybackPositionSec());
    const paused = this.paused;
    const key = this.trackKey(track);

    if (
      !force &&
      posSec === this.lastPostedPosSec &&
      paused === this.lastPostedPaused &&
      key === this.lastPostedTrackKey
    ) {
      return;
    }

    // Cap display at track duration so the bar doesn’t overshoot
    const displayPos =
      track.durationSec > 0 ? Math.min(posSec, Math.floor(track.durationSec)) : posSec;

    const display = buildMusicPlayerDisplay({
      track,
      positionSec: displayPos,
      queueLength: this.queue.length,
      paused,
      loopMode: this.loopMode,
      label: paused ? 'Paused' : 'Now Playing',
    });

    this.progressEditInFlight = true;
    try {
      await msg.edit({
        components: display.components,
        flags: MessageFlags.IsComponentsV2,
      });
      this.lastPostedPosSec = posSec;
      this.lastPostedPaused = paused;
      this.lastPostedTrackKey = key;
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: unknown }).code
          : undefined;
      // Unknown Message / Missing Access / cannot edit
      if (code === 10008 || code === 50001 || code === 50013 || code === 50005) {
        this.nowPlayingMessage = null;
        this.stopProgressTimer();
        return;
      }
      // Rate limited — skip this tick; next second will retry
      if (code === 429) {
        this.logger.debug('Now-playing progress edit rate-limited; will retry next tick');
        return;
      }
      this.logger.debug('Now-playing progress edit failed:', err);
    } finally {
      this.progressEditInFlight = false;
    }
  }

  private pushHistory(track: Track): void {
    this.history.push(track);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }
  }

  enqueue(tracks: Track[]): void {
    this.lastError = null;
    this.queue.push(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
  }

  /** Skip the current track; returns the track that will play next, if any. */
  skip(): Track | null {
    this.clearSkipVotes();
    this.player.stop(true); // triggers Idle -> processQueue plays the next track
    return this.queue[0] ?? null;
  }

  /**
   * Go to the previous track (history), or restart the current track if none.
   * Returns true when an action was taken.
   */
  previous(): boolean {
    const prev = this.history.pop();
    const cur = this.current;

    if (prev) {
      // Clear current before stop so Idle doesn't also archive it
      this.current = null;
      this.currentResource = null;
      if (cur) this.queue.unshift(cur);
      this.queue.unshift(prev);
      this.clearSkipVotes();
      this.suppressIdleAdvance = true;
      this.player.stop(true);
      void this.processQueue();
      return true;
    }

    // No history — restart current track from the beginning
    if (cur) {
      this.current = null;
      this.currentResource = null;
      this.queue.unshift(cur);
      this.clearSkipVotes();
      this.suppressIdleAdvance = true;
      this.player.stop(true);
      void this.processQueue();
      return true;
    }
    return false;
  }

  /**
   * Register a vote-skip for `userId`. Returns progress; when `skipped` is true,
   * the track was advanced (same as force skip).
   */
  voteSkip(
    userId: string,
    threshold: number,
  ): { votes: number; needed: number; skipped: boolean; alreadyVoted: boolean } {
    const track = this.current;
    if (!track) {
      return { votes: 0, needed: threshold, skipped: false, alreadyVoted: false };
    }
    const key = track.url || track.title;
    if (this.skipVoteTrackKey !== key) {
      this.skipVotes.clear();
      this.skipVoteTrackKey = key;
    }
    const alreadyVoted = this.skipVotes.has(userId);
    if (!alreadyVoted) this.skipVotes.add(userId);
    const votes = this.skipVotes.size;
    const needed = Math.max(1, threshold);
    if (votes >= needed) {
      this.skip();
      return { votes, needed, skipped: true, alreadyVoted };
    }
    return { votes, needed, skipped: false, alreadyVoted };
  }

  clearSkipVotes(): void {
    this.skipVotes.clear();
    this.skipVoteTrackKey = null;
  }

  /** Stop playback, clear the queue, and leave the voice channel. */
  stop(): void {
    this.queue.length = 0;
    this.queueSnapshot = [];
    this.history = [];
    this.loopMode = 'off';
    this.currentResource = null;
    this.stopProgressTimer();
    this.player.stop(true);
    this.destroy();
  }

  /** Pause current playback (returns true if action taken). */
  pause(): boolean {
    if (!this.current) return false;
    const ok = this.player.pause();
    if (ok) {
      this.clearIdleTimer(); // don't idle while paused
      void this.refreshNowPlayingMessage(true);
    }
    return ok;
  }

  /** Resume if paused. */
  resume(): boolean {
    if (!this.current) return false;
    const ok = this.player.unpause();
    if (ok) {
      this.clearIdleTimer();
      void this.refreshNowPlayingMessage(true);
    }
    return ok;
  }

  get paused(): boolean {
    return this.player.state.status === 'paused';
  }

  /** Shuffle the upcoming queue (in place). */
  shuffle(): void {
    if (this.queue.length < 2) return;
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /** Remove upcoming track at 0-based index. Returns removed or null. */
  remove(index: number): Track | null {
    if (index < 0 || index >= this.queue.length) return null;
    return this.queue.splice(index, 1)[0] ?? null;
  }

  /** Move track from index to another. Returns success. */
  move(from: number, to: number): boolean {
    if (from < 0 || from >= this.queue.length || to < 0 || to > this.queue.length) return false;
    if (from === to) return true;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    return true;
  }

  /** Set loop mode. 'queue' captures current upcoming for repeat. */
  setLoopMode(mode: LoopMode): void {
    this.loopMode = mode;
    if (mode === 'queue' && this.queue.length > 0) {
      this.queueSnapshot = [...this.queue];
    } else if (mode !== 'queue') {
      this.queueSnapshot = [];
    }
  }

  /**
   * Pull the next track and start it. Loops on track-specific failures so an
   * album keeps advancing; pauses the whole queue on bridge/infrastructure errors.
   */
  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    if (this.queuePumpRunning) return;
    this.queuePumpRunning = true;

    try {
      while (!this.destroyed) {
        let next = this.queue.shift();
        if (!next) {
          if (this.loopMode === 'queue' && this.queueSnapshot.length > 0) {
            this.queue.push(...this.queueSnapshot);
            next = this.queue.shift();
          }
          if (!next) {
            this.startIdleTimer();
            return;
          }
        }

        const result = await this.playTrack(next);
        if (result === 'playing') {
          // Wait for Idle / skip / stop to call processQueue again
          return;
        }
        if (result === 'paused_infra') {
          // Failed track was re-queued; stop draining the album
          return;
        }
        // 'skipped' — try the next track in the queue
      }
    } finally {
      this.queuePumpRunning = false;
    }
  }

  /**
   * Attempt to stream and play one track.
   * @returns `playing` when audio started, `skipped` to try the next item,
   *          `paused_infra` when the music bridge is down (queue preserved).
   */
  private async playTrack(track: Track): Promise<'playing' | 'skipped' | 'paused_infra'> {
    if (this.destroyed) return 'paused_infra';
    const gen = ++this.playGeneration;
    this.lastError = null;
    this.clearSkipVotes();
    this.currentResource = null;

    const maxAttempts = 3;
    let lastMsg = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.destroyed || gen !== this.playGeneration) return 'paused_infra';
      try {
        this.logger.info(
          `Starting stream for: ${track.title} (${track.url})` +
            (attempt > 1 ? ` [retry ${attempt}/${maxAttempts}]` : ''),
        );
        const stream = await this.source.stream(track);
        if (this.destroyed || gen !== this.playGeneration) return 'paused_infra';
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
        this.current = track;
        this.currentResource = resource;
        this.consecutiveStreamFailures = 0;
        this.player.play(resource);
        this.logger.info(
          `Audio player started: ${track.title} (${this.queue.length} still queued)`,
        );
        // New track → delete previous NP message and post a fresh player panel
        void this.publishFreshNowPlaying(track).catch((err: unknown) =>
          this.logger.debug('publishFreshNowPlaying failed:', err),
        );
        // Count stats when audio actually starts, not when the track is only queued.
        if (this.onTrackStart) {
          void Promise.resolve(this.onTrackStart(track)).catch((err: unknown) =>
            this.logger.debug('onTrackStart failed:', err),
          );
        }
        return 'playing';
      } catch (error) {
        lastMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to play "${track.title}" (attempt ${attempt}/${maxAttempts}):`,
          error,
        );
        // Brief backoff for tunnel/worker blips before retry
        if (attempt < maxAttempts && isTransientStreamError(lastMsg)) {
          await new Promise((r) => setTimeout(r, 1200 * attempt));
          continue;
        }
        break;
      }
    }

    this.lastError = lastMsg;
    this.current = null;
    this.currentResource = null;
    this.consecutiveStreamFailures += 1;

    // Music bridge / tunnel down: do NOT burn through the rest of the album/queue.
    if (isWorkerInfrastructureError(lastMsg) || this.consecutiveStreamFailures >= 3) {
      this.queue.unshift(track);
      this.logger.warn(
        `Stream infrastructure failed — paused queue with ${this.queue.length} track(s) remaining. ` +
          `Start the home music bridge (npm run music-bridge).`,
      );
      if (this.nowPlayingMessage) {
        void this.refreshNowPlayingMessage(true).catch(() => {});
      }
      return 'paused_infra';
    }

    this.logger.warn(`Skipping unplayable track "${track.title}" — continuing queue`);
    return 'skipped';
  }

  /** Wait until the next track starts, fails hard, or timeout (ms). */
  async waitForPlaybackAttempt(timeoutMs = 25_000): Promise<{ ok: boolean; error: string | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.current) return { ok: true, error: null };

      // Only treat errors as terminal when the pump is idle (not mid-skip of bad matches).
      if (this.lastError && !this.queuePumpRunning && !this.current) {
        const infra =
          isWorkerInfrastructureError(this.lastError) || this.consecutiveStreamFailures >= 3;
        if (infra || this.queue.length === 0) {
          return { ok: false, error: this.lastError };
        }
      }

      // Poll a bit faster so /play returns sooner once audio is ready
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.current) return { ok: true, error: null };
    return {
      ok: false,
      error: this.lastError ?? 'Timed out waiting for audio to start.',
    };
  }

  private async handleDisconnect(): Promise<void> {
    try {
      // Give the connection a moment to recover (e.g. moved channels) before giving up.
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      this.destroy();
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.destroy(), this.idleTimeoutSec * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdleTimer();
    this.stopProgressTimer();
    // Leave the last NP message in chat so people can see what played; just detach.
    this.nowPlayingMessage = null;
    this.announceChannel = null;
    this.consecutiveStreamFailures = 0;
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroy();
  }
}

/** Tunnel/worker blips worth retrying. */
function isTransientStreamError(msg: string): boolean {
  return /530|1033|tunnel|ECONNRESET|ETIMEDOUT|socket|fetch failed|music worker HTTP 5\d\d/i.test(
    msg,
  );
}

/** Home bridge is down — keep the queue instead of skipping every song. */
function isWorkerInfrastructureError(msg: string): boolean {
  return /music worker HTTP 530|music worker HTTP 502|music worker HTTP 503|Error 1033|trycloudflare|music worker failed|Is the home worker/i.test(
    msg,
  );
}
