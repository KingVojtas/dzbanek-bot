import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { update as updateYoutubeDl } from 'youtube-dl-exec';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { TrackSource } from '../core/types';
import { GuildMusicSubscription } from './GuildMusicSubscription';
import { YouTubeSource } from './source/youtubesource';

/** Tracks one music subscription per guild and creates voice connections on demand. */
export class MusicManager {
  private readonly subscriptions = new Map<string, GuildMusicSubscription>();
  private readonly source: TrackSource = new YouTubeSource();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    // Proactively self-update the vendored yt-dlp binary on startup.
    // YouTube changes frequently and breaks extractors; keeping yt-dlp current
    // is the most reliable way to ensure YouTube URLs (and searches) keep working.
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

  /** Join `channel` (or return the existing subscription for the guild). */
  async join(channel: VoiceBasedChannel): Promise<GuildMusicSubscription> {
    const existing = this.subscriptions.get(channel.guild.id);
    if (existing) return existing;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      throw new Error('Could not connect to the voice channel in time.');
    }

    const subscription = new GuildMusicSubscription(
      connection,
      this.source,
      this.logger,
      this.config.music.idleTimeoutSec,
      () => this.subscriptions.delete(channel.guild.id),
    );
    this.subscriptions.set(channel.guild.id, subscription);
    return subscription;
  }
}
