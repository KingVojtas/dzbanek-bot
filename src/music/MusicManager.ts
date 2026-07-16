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

    // One-shot probe so Railway logs show whether android_vr URL extract works here.
    void this.probeYoutubeExtract().catch(() => {});
  }

  private async probeYoutubeExtract(): Promise<void> {
    const sample = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    // 1) youtubei.js (same path used first at stream time)
    try {
      const { Innertube, UniversalCache } = await import('youtubei.js');
      const yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
      });
      const info = await yt.getBasicInfo('jNQXAC9IVRw', { client: 'IOS' });
      const formats =
        (info.streaming_data?.adaptive_formats?.length ?? 0) +
        (info.streaming_data?.formats?.length ?? 0);
      if (info.playability_status?.status === 'OK' && formats > 0) {
        this.logger.info(`YouTube probe OK (youtubei.js IOS, formats=${formats})`);
        return;
      }
      this.logger.warn(
        `YouTube probe youtubei.js: status=${info.playability_status?.status} formats=${formats}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`YouTube probe youtubei.js failed: ${msg.slice(0, 200)}`);
    }

    // 2) yt-dlp cookie-free multi-client (prefer this over stale cookies)
    try {
      const youtubeDl = (await import('youtube-dl-exec')).default;
      const freeClients =
        process.env.YTDLP_PLAYER_CLIENTS_NOCOOKIE?.trim() ||
        'android_vr,tv_simply,mweb,web_embedded,android,tv_embedded';
      const raw = await youtubeDl(sample, {
        getUrl: true,
        format: 'bestaudio/best/18',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        jsRuntimes: process.env.YTDLP_JS_RUNTIME?.trim() || 'deno',
        remoteComponents: 'ejs:github',
        ...({ extractorArgs: `youtube:player_client=${freeClients}` } as object),
      } as Parameters<typeof youtubeDl>[1]);
      const url = String(raw)
        .trim()
        .split(/\r?\n/)
        .find((l) => /^https?:\/\//i.test(l.trim()));
      if (url) {
        this.logger.info(`YouTube probe OK (yt-dlp cookie-free multi-client)`);
        return;
      }
      this.logger.warn('YouTube probe: yt-dlp get-url returned no URL (cookie-free)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`YouTube probe yt-dlp cookie-free failed: ${msg.slice(0, 200)}`);
    }

    // 3) Cookie jar (only if configured)
    try {
      const youtubeDl = (await import('youtube-dl-exec')).default;
      const { ytDlpCookieFlags } = await import('./ytdlp-cookies');
      const cookieFlags = ytDlpCookieFlags();
      if (Object.keys(cookieFlags).length === 0) {
        this.logger.warn(
          'YouTube probe FAILED — no working extract path. Set fresh YTDLP_COOKIES_BASE64 or YTDLP_IGNORE_COOKIES=1.',
        );
        return;
      }
      const cookieClients =
        process.env.YTDLP_PLAYER_CLIENTS_COOKIE?.trim() || 'web,mweb,web_safari,tv_simply';
      const raw = await youtubeDl(sample, {
        getUrl: true,
        format: '18/bestaudio/best',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        jsRuntimes: process.env.YTDLP_JS_RUNTIME?.trim() || 'deno',
        remoteComponents: 'ejs:github',
        ...({ extractorArgs: `youtube:player_client=${cookieClients}`, ...cookieFlags } as object),
      } as Parameters<typeof youtubeDl>[1]);
      const url = String(raw)
        .trim()
        .split(/\r?\n/)
        .find((l) => /^https?:\/\//i.test(l.trim()));
      this.logger.info(
        url
          ? 'YouTube probe OK (yt-dlp + cookies)'
          : 'YouTube probe: cookie get-url returned no URL',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `YouTube probe FAILED (playback may be blocked on this host): ${msg.slice(0, 300)}`,
      );
    }
  }

  /** The shared track source (used by commands to resolve queries). */
  get trackSource(): TrackSource {
    return this.source;
  }

  get(guildId: string): GuildMusicSubscription | undefined {
    return this.subscriptions.get(guildId);
  }

  /**
   * Public website “now playing” — first guild that currently has a track.
   * No guild IDs in the payload.
   */
  getPublicNowPlaying(): {
    title: string;
    artist: string;
    albumArtUrl: string | null;
  } | null {
    for (const sub of this.subscriptions.values()) {
      const track = sub.current;
      if (!track?.title) continue;
      return {
        title: track.title,
        artist: track.uploader?.trim() || '',
        albumArtUrl: track.thumbnail?.trim() || null,
      };
    }
    return null;
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
        { cause: err },
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
        void this.stats
          .recordPlay(guildId, track.requestedById, track)
          .catch((e: unknown) => this.logger.debug('Failed to record play stats:', e));
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
