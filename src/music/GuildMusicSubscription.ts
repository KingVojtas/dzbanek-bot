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
import type { Track, TrackSource } from '../core/types';

/**
 * Owns the voice connection, audio player, and queue for a single guild.
 * Advancing the queue is driven by the player's Idle event; when the queue
 * drains, an idle timer disconnects the bot after a grace period.
 */
export class GuildMusicSubscription {
  readonly queue: Track[] = [];
  current: Track | null = null;

  private readonly player: AudioPlayer;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    readonly connection: VoiceConnection,
    private readonly source: TrackSource,
    private readonly logger: Logger,
    private readonly idleTimeoutSec: number,
    private readonly onDestroy: () => void,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.current = null;
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
    this.player.stop(true);
    this.destroy();
  }

  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    const next = this.queue.shift();
    if (!next) {
      this.startIdleTimer();
      return;
    }

    try {
      const stream = await this.source.stream(next);
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
      this.current = next;
      this.player.play(resource);
    } catch (error) {
      this.logger.error(`Failed to play "${next.title}":`, error);
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
