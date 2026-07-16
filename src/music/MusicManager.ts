import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { update as updateYoutubeDl } from 'youtube-dl-exec';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { TrackSource } from '../core/types';
import type { StatsStore } from '../stats/StatsStore';
import { GuildMusicSubscription } from './GuildMusicSubscription';
import { YouTubeSource } from './source/youtubesource';
import { ensureYtDlpCookies } from './ytdlp-cookies';

const JOIN_TIMEOUT_MS = 45_000;

/** Tracks one music subscription per guild and creates voice connections on demand. */
export class MusicManager {
  private readonly subscriptions = new Map<string, GuildMusicSubscription>();
  private readonly source: TrackSource = new YouTubeSource();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly stats?: StatsStore,
  ) {
    // Cloud hosts (Railway) need cookies when YouTube shows "not a bot" challenges.
    ensureYtDlpCookies(this.logger);

    // Proactively self-update the vendored yt-dlp binary on startup.
    void updateYoutubeDl()
      .then(() => this.logger.debug('yt-dlp self-update check complete.'))
      .catch((err: unknown) => this.logger.debug('yt-dlp update check (non-fatal):', err));
  }

  /** The shared track source (used by commands to resolve queries). */
  get trackSource(): TrackSource {
    return this.source;
  }

  get(guildId: string): GuildMusicSubscription | undefined {
    return this.subscriptions.get(guildId);
  }

  /** Join `channel` (or return the existing healthy subscription for the guild). */
  async join(channel: VoiceBasedChannel): Promise<GuildMusicSubscription> {
    const guildId = channel.guild.id;

    const existing = this.subscriptions.get(guildId);
    if (existing) {
      const status = existing.connection.state.status;
      const sameChannel = existing.connection.joinConfig.channelId === channel.id;
      if (sameChannel && status === VoiceConnectionStatus.Ready) {
        return existing;
      }
      // Dead / wrong channel / stuck — tear down and recreate.
      this.logger.warn(
        `Replacing voice subscription for ${guildId} (status=${status}, sameChannel=${sameChannel})`,
      );
      try {
        existing.stop();
      } catch {
        /* ignore */
      }
      this.subscriptions.delete(guildId);
      try {
        getVoiceConnection(guildId)?.destroy();
      } catch {
        /* ignore */
      }
    } else {
      // Orphan connection from a previous process/crash
      try {
        getVoiceConnection(guildId)?.destroy();
      } catch {
        /* ignore */
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.attachVoiceDebug(guildId, connection);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (err) {
      const status = connection.state.status;
      this.logger.error(
        `Voice join failed for guild ${guildId} channel ${channel.id} (status=${status}):`,
        err,
      );
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
      throw new Error(
        'Could not connect to the voice channel in time. ' +
          'Make sure the bot has **Connect** and **Speak** in that channel, ' +
          'the channel is not full, and try `/play` again. ' +
          `(voice status: ${status})`,
      );
    }

    const subscription = new GuildMusicSubscription(
      connection,
      this.source,
      this.logger,
      this.config.music.idleTimeoutSec,
      () => this.subscriptions.delete(guildId),
      (track) => {
        if (!this.stats || !track.requestedById) return;
        void this.stats.recordPlay(guildId, track.requestedById, track).catch((e: unknown) =>
          this.logger.debug('Failed to record play stats:', e),
        );
      },
    );
    this.subscriptions.set(guildId, subscription);
    this.logger.info(`Voice ready in guild ${guildId} → #${channel.name} (${channel.id})`);
    return subscription;
  }

  private attachVoiceDebug(guildId: string, connection: VoiceConnection): void {
    connection.on('stateChange', (oldState, newState) => {
      this.logger.info(`Voice ${guildId}: ${oldState.status} → ${newState.status}`);
      // Surface networking/DAVE errors if present on the new state
      const ns = newState as { closeCode?: number; reason?: string };
      if (typeof ns.closeCode === 'number') {
        this.logger.warn(`Voice ${guildId} closeCode=${ns.closeCode} reason=${ns.reason ?? ''}`);
      }
    });
    connection.on('error', (error) => {
      this.logger.error(`Voice connection error ${guildId}:`, error);
    });
  }
}
