import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Logger } from '../core/logger';
import type { LoopMode, Track, TrackSource } from '../core/types';

export type OnTrackStart = (track: Track) => void | Promise<void>;

/**
 * Owns the voice connection, audio player, and queue for a single guild.
 * Advancing the queue is driven by the player's Idle event; when the queue
 * drains, an idle timer disconnects the bot after a grace period.
 */
export class GuildMusicSubscription {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loopMode: LoopMode = 'off';

  private readonly player: AudioPlayer;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

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
      const finished = this.current;
      this.current = null;

      if (finished && this.loopMode === 'track') {
        // Re-queue the finished track immediately for repeat
        this.queue.unshift(finished);
      }

      void this.processQueue();
    });
    this.player.on('error', (error) => {
      this.logger.error('Audio player error:', error);
      this.current = null;
      void this.processQueue();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  enqueue(tracks: Track[]): void {
    this.queue.push(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
  }

  /** Skip the current track; returns the track that will play next, if any. */
  skip(): Track | null {
    this.player.stop(true); // triggers Idle -> processQueue plays the next track
    return this.queue[0] ?? null;
  }

  /** Stop playback, clear the queue, and leave the voice channel. */
  stop(): void {
    this.queue.length = 0;
    this.queueSnapshot = [];
    this.loopMode = 'off';
    this.player.stop(true);
    this.destroy();
  }

  /** Pause current playback (returns true if action taken). */
  pause(): boolean {
    if (!this.current) return false;
    const ok = this.player.pause();
    if (ok) this.clearIdleTimer(); // don't idle while paused
    return ok;
  }

  /** Resume if paused. */
  resume(): boolean {
    if (!this.current) return false;
    const ok = this.player.unpause();
    if (ok) this.clearIdleTimer();
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

  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    const next = this.queue.shift();
    if (!next) {
      // Handle queue loop: restore from snapshot if available
      if (this.loopMode === 'queue' && this.queueSnapshot.length > 0) {
        this.queue.push(...this.queueSnapshot);
        // continue to play next iteration
        const requeued = this.queue.shift();
        if (requeued) {
          return this.playTrack(requeued);
        }
      }
      this.startIdleTimer();
      return;
    }

    return this.playTrack(next);
  }

  private async playTrack(track: Track): Promise<void> {
    if (this.destroyed) return;
    try {
      const stream = await this.source.stream(track);
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
      this.current = track;
      this.player.play(resource);
      // Count stats when audio actually starts, not when the track is only queued.
      if (this.onTrackStart) {
        void Promise.resolve(this.onTrackStart(track)).catch((err: unknown) =>
          this.logger.debug('onTrackStart failed:', err),
        );
      }
    } catch (error) {
      this.logger.error(`Failed to play "${track.title}":`, error);
      void this.processQueue(); // skip the broken track
    }
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
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroy();
  }
}
