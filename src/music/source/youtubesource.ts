import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import { Innertube, UniversalCache } from 'youtubei.js';
import type { Track, TrackSource } from '../../core/types';
import { ytDlpCookieFlags } from '../ytdlp-cookies';
import {
  SpotifySource,
  isSpotifyPlaylistUrl,
  isSpotifyAlbumUrl,
  type SpotifyCollectionTrack,
} from './spotifysource';

/** True when cookie env is present (may still be expired — we fall back without cookies). */
function hasCookieConfig(): boolean {
  return Object.keys(ytDlpCookieFlags()).length > 0;
}

/** Subset of the yt-dlp JSON payload we care about. */
interface YtEntry {
  id?: string;
  title?: string;
  duration?: number;
  webpage_url?: string;
  url?: string;
  thumbnail?: string;
  channel?: string;
  uploader?: string;
  view_count?: number;
  like_count?: number;
  upload_date?: string;
  timestamp?: number;
}

interface YtPayload extends YtEntry {
  entries?: YtEntry[];
}

/**
 * yt-dlp flags. Prefer android_vr alone (most reliable cookie-free client).
 */
/** Runtime flags for youtube-dl-exec (its published Flags type is incomplete). */
type YtFlags = Record<string, string | boolean | number | undefined>;

function ytCommonFlags(opts?: {
  useCookies?: boolean;
  forGetUrl?: boolean;
}): YtFlags {
  const useCookies = opts?.useCookies === true && hasCookieConfig();
  return {
    noWarnings: true,
    noCheckCertificates: true,
    noPart: true,
    noContinue: true,
    geoBypass: true,
    ...(opts?.forGetUrl
      ? {}
      : {
          jsRuntimes: process.env.YTDLP_JS_RUNTIME?.trim() || 'deno',
          remoteComponents: 'ejs:github',
        }),
    extractorArgs:
      process.env.YTDLP_EXTRACTOR_ARGS?.trim() || 'youtube:player_client=android_vr',
    ...(useCookies ? ytDlpCookieFlags() : {}),
  };
}

function isYoutubeBotCheck(err: unknown): boolean {
  const text = typeof err === 'string' ? err : errText(err);
  return /sign in to confirm|not a bot|cookies are no longer valid|login_required/i.test(text);
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const extra =
      typeof err === 'object' && err && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : '';
    return `${err.message} ${extra}`.trim();
  }
  if (typeof err === 'object' && err && 'stderr' in err) {
    return `${String((err as { message?: string }).message ?? err)} ${String((err as { stderr?: unknown }).stderr ?? '')}`;
  }
  return String(err ?? '');
}

async function webBodyToNodeStream(body: ReadableStream<Uint8Array>): Promise<Readable> {
  const { Readable: NodeReadable } = await import('node:stream');
  if (typeof NodeReadable.fromWeb === 'function') {
    return NodeReadable.fromWeb(body);
  }
  const pass = new PassThrough();
  const reader = body.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          pass.end();
          break;
        }
        if (value && !pass.write(Buffer.from(value))) {
          await new Promise<void>((r) => pass.once('drain', r));
        }
      }
    } catch (e) {
      pass.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return pass;
}

const SEARCH_RESULT_LIMIT = 5;
const COLLECTION_CONCURRENCY = 4;
const GOOD_ENOUGH_SCORE = 5;

const BAD_KEYWORDS = [
  'mix',
  'best of',
  'video mix',
  'hit songs',
  'full mix',
  'playlist',
  'bongo',
  'cookie$',
  'mashup',
  'live set',
  'dj set',
] as const;

/** iOS client UA — matches Innertube ClientType.IOS stream URLs. */
const IOS_UA =
  'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)';

/**
 * YouTube via youtubei.js (primary) + yt-dlp (fallback / SoundCloud).
 * Innertube iOS client returns direct audio URLs without browser cookies,
 * which is critical on Railway datacenter IPs where yt-dlp is bot-checked.
 */
export class YouTubeSource implements TrackSource {
  private readonly spotify = new SpotifySource();
  private innertube: Innertube | null = null;
  private innertubeInit: Promise<Innertube> | null = null;

  private async getInnertube(): Promise<Innertube> {
    if (this.innertube) return this.innertube;
    if (!this.innertubeInit) {
      this.innertubeInit = Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
      }).then((yt) => {
        this.innertube = yt;
        return yt;
      });
    }
    return this.innertubeInit;
  }

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const target = await this.resolveInput(input);

    const isSpotifyCollection = isSpotifyPlaylistUrl(target) || isSpotifyAlbumUrl(target);
    if (isSpotifyCollection) {
      const collectionTracks = await this.spotify.resolveSpotifyCollection(target);
      const matched = await mapPool(collectionTracks, COLLECTION_CONCURRENCY, (pt) =>
        this.resolveCollectionTrack(pt, requestedBy),
      );
      return matched.filter((t): t is Track => t != null);
    }

    if (isSoundCloudUrl(target)) {
      return this.resolveViaYtDlpUrl(target, requestedBy);
    }

    const isUrl = /^https?:\/\//i.test(target);
    if (!isUrl) {
      try {
        const found = await this.searchViaInnertube(target, requestedBy);
        if (found.length > 0) return found;
      } catch {
        /* fall through to yt-dlp search */
      }
      return this.resolveSearchYtDlp(target, requestedBy);
    }

    const cleanTarget = cleanYouTubeUrl(target);
    const videoId = extractYouTubeId(cleanTarget);
    if (videoId) {
      try {
        const track = await this.resolveViaInnertube(videoId, requestedBy);
        return [track];
      } catch {
        /* fall through */
      }
    }

    return this.resolveViaYtDlpUrl(cleanTarget, requestedBy);
  }

  private async resolveViaInnertube(videoId: string, requestedBy: string): Promise<Track> {
    const yt = await this.getInnertube();
    const info = await yt.getBasicInfo(videoId, { client: 'IOS' });
    const status = info.playability_status?.status;
    if (status && status !== 'OK') {
      const reason = info.playability_status?.reason || status;
      throw new Error(`YouTube playability ${status}: ${reason}`);
    }

    const basic = info.basic_info;
    const title = basic?.title || 'Unknown title';
    const durationSec = typeof basic?.duration === 'number' ? basic.duration : 0;
    const thumbnail =
      basic?.thumbnail?.[0]?.url ||
      basic?.thumbnail?.[(basic.thumbnail?.length ?? 1) - 1]?.url ||
      undefined;
    const uploader =
      basic?.author ||
      (basic as { channel?: { name?: string } } | undefined)?.channel?.name ||
      undefined;
    const views = typeof basic?.view_count === 'number' ? basic.view_count : undefined;

    return {
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      durationSec: durationSec || 0,
      thumbnail,
      requestedBy,
      uploader,
      views,
      source: 'youtube',
    };
  }

  private async searchViaInnertube(query: string, requestedBy: string): Promise<Track[]> {
    const yt = await this.getInnertube();
    const res = await yt.search(query, { type: 'video' });
    const items = (res.results ?? res.videos ?? []).filter(
      (v: { type?: string }) => v?.type === 'Video',
    );

    const tracks: Track[] = [];
    for (const v of items.slice(0, SEARCH_RESULT_LIMIT)) {
      const id = (v as { id?: string; video_id?: string }).id || (v as { video_id?: string }).video_id;
      if (!id) continue;
      const titleNode = (v as { title?: { text?: string } | string }).title;
      const title =
        typeof titleNode === 'string' ? titleNode : (titleNode?.text ?? 'Unknown title');
      const durationSec =
        (v as { duration?: { seconds?: number } }).duration?.seconds ??
        parseDurationText((v as { duration?: { text?: string } }).duration?.text) ??
        0;
      const thumb =
        (v as { best_thumbnail?: { url?: string }; thumbnails?: Array<{ url?: string }> })
          .best_thumbnail?.url ||
        (v as { thumbnails?: Array<{ url?: string }> }).thumbnails?.[0]?.url;

      tracks.push({
        title,
        url: `https://www.youtube.com/watch?v=${id}`,
        durationSec,
        thumbnail: thumb,
        requestedBy,
        uploader: (v as { author?: { name?: string } }).author?.name,
        source: 'youtube',
      });
    }
    return tracks.length > 0 ? [tracks[0]] : [];
  }

  private async resolveCollectionTrack(
    pt: SpotifyCollectionTrack,
    requestedBy: string,
  ): Promise<Track | null> {
    const artist = (pt.artist || '').trim();
    const title = (pt.title || '').trim();
    const context = (pt.contextName || '').trim();

    const queries = [
      artist && title
        ? context
          ? `${artist} ${title} ${context} official audio`
          : `${artist} ${title} official audio`
        : '',
      artist && title ? `${artist} ${title}` : '',
      title,
    ].filter((q): q is string => !!q && q.length > 2);

    let best: Track | null = null;
    let bestScore = Infinity;

    for (const q of queries) {
      try {
        const cands = await this.flatSearchCandidates(q, requestedBy);
        for (const cand of cands) {
          if (!cand.url) continue;
          const score = scoreCandidate(cand, title, pt.durationSec);
          if (score === null) continue;
          if (score < bestScore) {
            best = cand;
            bestScore = score;
          }
          if (score <= GOOD_ENOUGH_SCORE) {
            best = cand;
            bestScore = score;
            break;
          }
        }
        if (best && bestScore <= GOOD_ENOUGH_SCORE) break;
      } catch {
        /* next query */
      }
    }

    if (best) {
      best.source = 'spotify';
      if (!best.uploader && artist) best.uploader = artist;
      return best;
    }

    try {
      const fallback = await this.resolve(title || artist, requestedBy);
      if (fallback.length > 0) {
        const t = fallback[0];
        t.source = 'spotify';
        if (!t.uploader && artist) t.uploader = artist;
        return t;
      }
    } catch {
      /* give up */
    }
    return null;
  }

  /** Multiple search hits for scoring (Spotify matching). */
  private async flatSearchCandidates(query: string, requestedBy: string): Promise<Track[]> {
    try {
      const yt = await this.getInnertube();
      const res = await yt.search(query, { type: 'video' });
      const items = (res.results ?? res.videos ?? []).filter(
        (v: { type?: string }) => v?.type === 'Video',
      );
      const out: Track[] = [];
      for (const v of items.slice(0, SEARCH_RESULT_LIMIT)) {
        const id =
          (v as { id?: string; video_id?: string }).id || (v as { video_id?: string }).video_id;
        if (!id) continue;
        const titleNode = (v as { title?: { text?: string } | string }).title;
        const title =
          typeof titleNode === 'string' ? titleNode : (titleNode?.text ?? 'Unknown title');
        const durationSec =
          (v as { duration?: { seconds?: number } }).duration?.seconds ??
          parseDurationText((v as { duration?: { text?: string } }).duration?.text) ??
          0;
        out.push({
          title,
          url: `https://www.youtube.com/watch?v=${id}`,
          durationSec,
          requestedBy,
          source: 'youtube',
        });
      }
      if (out.length > 0) return out;
    } catch {
      /* yt-dlp fallback */
    }
    return this.flatSearchYtDlp(query, requestedBy);
  }

  private async resolveSearchYtDlp(query: string, requestedBy: string): Promise<Track[]> {
    const candidates = await this.flatSearchYtDlp(query, requestedBy);
    const usable = candidates.find((c) => Boolean(c.url));
    return usable ? [usable] : [];
  }

  private async flatSearchYtDlp(query: string, requestedBy: string): Promise<Track[]> {
    const raw: unknown = await this.withRetries(
      () =>
        this.ytdlpJson(query, {
          dumpSingleJson: true,
          flatPlaylist: true,
          defaultSearch: `ytsearch${SEARCH_RESULT_LIMIT}`,
          noPlaylist: true,
        }),
      'search',
    );
    return this.payloadToTracks(raw, requestedBy);
  }

  private async resolveViaYtDlpUrl(url: string, requestedBy: string): Promise<Track[]> {
    const raw: unknown = await this.withRetries(
      () =>
        this.ytdlpJson(url, {
          dumpSingleJson: true,
          noPlaylist: true,
        }),
      'direct url',
    );
    return this.payloadToTracks(raw, requestedBy);
  }

  private async ytdlpJson(
    target: string,
    flags: Record<string, string | boolean | number>,
  ): Promise<unknown> {
    try {
      return await youtubeDl(target, {
        ...flags,
        ...ytCommonFlags({ useCookies: false }),
      } as Parameters<typeof youtubeDl>[1]);
    } catch (err) {
      if (!hasCookieConfig()) throw err;
      return await youtubeDl(target, {
        ...flags,
        ...ytCommonFlags({ useCookies: true }),
      } as Parameters<typeof youtubeDl>[1]);
    }
  }

  private payloadToTracks(raw: unknown, requestedBy: string): Track[] {
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as YtPayload;
    const entries = payload.entries ?? [payload];

    return entries
      .filter((entry): entry is YtEntry =>
        Boolean(entry && (entry.webpage_url || entry.url || entry.id)),
      )
      .map((entry) => this.toTrack(entry, requestedBy));
  }

  async stream(track: Track): Promise<Readable> {
    const videoId = extractYouTubeId(track.url);
    const isYt =
      track.source === 'youtube' ||
      track.source === 'spotify' ||
      Boolean(videoId);
    const errors: string[] = [];

    if (isYt && track.source !== 'soundcloud') {
      // 1) Best path: yt-dlp resolves a direct googlevideo URL (android_vr), then we HTTP-fetch it.
      //    Full GET works on these URLs (unlike some Innertube iOS signed URLs).
      try {
        return await this.streamViaYtDlpDirectUrl(track.url);
      } catch (err) {
        const msg = errText(err);
        errors.push(`direct-url: ${msg.slice(0, 240)}`);
        console.error('[YouTube] streamViaYtDlpDirectUrl failed:', msg.slice(0, 400));
      }

      // 2) Innertube clients (cookie-free API) + range/full fetch
      if (videoId) {
        try {
          return await this.streamViaInnertube(videoId);
        } catch (err) {
          const msg = errText(err);
          errors.push(`innertube: ${msg.slice(0, 240)}`);
          console.error('[YouTube] streamViaInnertube failed:', msg.slice(0, 400));
        }
      }

      // 3) Classic yt-dlp stdout pipe
      try {
        return await this.streamViaYtDlpPipe(track);
      } catch (err) {
        const msg = errText(err);
        errors.push(`ytdlp-pipe: ${msg.slice(0, 240)}`);
        console.error('[YouTube] streamViaYtDlpPipe failed:', msg.slice(0, 400));
      }

      const combined = errors.join(' || ');
      // Surface a bot-check shaped error so Discord shows the known hint when applicable.
      if (errors.some((e) => isYoutubeBotCheck(e))) {
        throw new Error(
          `Sign in to confirm you're not a bot. ${combined}`.slice(0, 1500),
        );
      }
      throw new Error(`Could not open YouTube audio stream. ${combined}`.slice(0, 1500));
    }

    return this.streamViaYtDlpPipe(track);
  }

  /**
   * yt-dlp --get-url (android_vr) → HTTP download of the media URL.
   * More reliable than piping yt-dlp stdout on cloud hosts.
   * Prefer cookies when configured (Railway datacenter IPs need them).
   */
  private async streamViaYtDlpDirectUrl(pageUrl: string): Promise<Readable> {
    const clients = [
      'youtube:player_client=android_vr',
      'youtube:player_client=android_vr,android',
      'youtube:player_client=web,android_vr',
      'youtube:player_client=ios,android_vr',
    ];
    // Cookies first on cloud hosts; no-cookie second (stale cookies can hurt).
    const cookieModes = hasCookieConfig() ? [true, false] : [false];

    let lastErr: unknown;
    for (const useCookies of cookieModes) {
      for (const extractorArgs of clients) {
        try {
          const raw = await youtubeDl(pageUrl, {
            getUrl: true,
            format: 'bestaudio[ext=m4a]/bestaudio/best',
            noPlaylist: true,
            ...ytCommonFlags({ useCookies, forGetUrl: true }),
            extractorArgs,
          } as Parameters<typeof youtubeDl>[1]);

          const audioUrl = String(raw)
            .trim()
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => /^https?:\/\//i.test(l));

          if (!audioUrl) {
            throw new Error('yt-dlp --get-url returned no HTTP URL');
          }

          const res = await fetch(audioUrl, {
            headers: {
              // Match android_vr client somewhat; some CDNs are picky.
              'User-Agent':
                'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12 en_US) gzip',
              Accept: '*/*',
            },
            redirect: 'follow',
          });

          if (!res.ok || !res.body) {
            throw new Error(`Direct media HTTP ${res.status}`);
          }

          console.log(
            `[YouTube] direct-url OK (cookies=${useCookies}, client=${extractorArgs})`,
          );
          return webBodyToNodeStream(
            res.body as import('node:stream/web').ReadableStream<Uint8Array>,
          );
        } catch (err) {
          lastErr = err;
          // Try next combination.
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error('yt-dlp direct URL extract failed');
  }

  /**
   * Innertube: try several clients for a direct audio URL, then stream it.
   */
  private async streamViaInnertube(videoId: string): Promise<Readable> {
    const yt = await this.getInnertube();
    const clients = ['IOS', 'WEB_EMBEDDED', 'ANDROID', 'MWEB', 'TV_EMBEDDED'] as const;
    const attempts: string[] = [];

    for (const client of clients) {
      try {
        const info = await yt.getBasicInfo(videoId, { client });
        const status = info.playability_status?.status;
        if (status && status !== 'OK') {
          attempts.push(`${client}:${status}`);
          continue;
        }

        const fmts = [
          ...(info.streaming_data?.adaptive_formats ?? []),
          ...(info.streaming_data?.formats ?? []),
        ];
        const audio = fmts
          .filter(
            (f) =>
              Boolean(f.url) &&
              f.has_audio &&
              !f.has_video &&
              String(f.mime_type || '').includes('audio'),
          )
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

        const preferred =
          audio.find((f) => f.itag === 140) ||
          audio.find((f) => f.itag === 139) ||
          audio.find((f) => String(f.mime_type || '').includes('mp4')) ||
          audio[0];

        if (!preferred?.url) {
          attempts.push(`${client}:no-audio-url`);
          continue;
        }

        // Prefer a full GET first (works for some clients / CDN combos).
        const full = await fetch(preferred.url, {
          headers: iosFetchHeaders(),
          redirect: 'follow',
        });
        if (full.ok && full.body) {
          return webBodyToNodeStream(
            full.body as import('node:stream/web').ReadableStream<Uint8Array>,
          );
        }

        // Fall back to ranged stream (iOS often only allows ~1MB ranges; still better than silence).
        const contentLength =
          typeof preferred.content_length === 'number' && preferred.content_length > 0
            ? preferred.content_length
            : await probeContentLength(preferred.url);
        return createRangedAudioStream(preferred.url, contentLength);
      } catch (err) {
        attempts.push(`${client}:${errText(err).slice(0, 80)}`);
      }
    }

    throw new Error(`Innertube failed (${attempts.join(', ') || 'no clients'})`);
  }

  private async streamViaYtDlpPipe(track: Track): Promise<Readable> {
    let lastError: unknown;
    const formats = ['bestaudio/best', '140/251/250/249/best', 'best'];

    for (const format of formats) {
      try {
        return await this.openAudioStream(track.url, format, false);
      } catch (err) {
        lastError = err;
        if (isYoutubeBotCheck(err)) break;
      }
    }

    if (hasCookieConfig()) {
      for (const format of formats) {
        try {
          return await this.openAudioStream(track.url, format, true);
        } catch (err) {
          lastError = err;
          if (isYoutubeBotCheck(err)) break;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to open an audio stream for the requested track.');
  }

  private openAudioStream(
    url: string,
    format: string,
    useCookies: boolean,
  ): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const subprocess = youtubeDl.exec(url, {
        output: '-',
        format,
        quiet: true,
        noPlaylist: true,
        ...ytCommonFlags({ useCookies, forGetUrl: false }),
      } as Parameters<typeof youtubeDl.exec>[1]);

      const stdout = subprocess.stdout;
      if (!stdout) {
        reject(new Error('yt-dlp produced no stdout stream.'));
        return;
      }

      const pass = new PassThrough();
      let settled = false;
      let gotData = false;
      const stderrChunks: Buffer[] = [];

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          pass.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(pass);
      };

      const timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for audio from yt-dlp (${format}).`));
        try {
          subprocess.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 45_000);

      subprocess.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (stderrChunks.length > 40) stderrChunks.shift();
      });

      stdout.on('data', (chunk: Buffer) => {
        if (!gotData) {
          gotData = true;
          succeed();
        }
        if (!pass.destroyed) {
          const ok = pass.write(chunk);
          if (!ok) stdout.pause();
        }
      });

      pass.on('drain', () => {
        stdout.resume();
      });

      stdout.on('end', () => {
        if (!gotData) {
          const errText = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
          fail(
            new Error(
              errText
                ? `yt-dlp ended without audio: ${errText}`
                : 'yt-dlp ended without producing audio data.',
            ),
          );
          return;
        }
        if (!pass.destroyed) pass.end();
      });

      stdout.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      pass.on('error', () => {
        /* consumer side */
      });

      void subprocess.then(
        () => {
          if (!gotData) {
            const errText = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
            fail(new Error(errText || `yt-dlp exited without audio (format=${format}).`));
          }
        },
        (err: unknown) => {
          const errText = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
          const base = err instanceof Error ? err.message : String(err);
          fail(new Error(errText ? `${base} | ${errText}` : base));
        },
      );
    });
  }

  private async resolveInput(input: string): Promise<string> {
    const normalized = normalizeInput(input);
    if (this.spotify.canResolve(normalized)) {
      if (isSpotifyPlaylistUrl(normalized) || isSpotifyAlbumUrl(normalized)) {
        return normalized;
      }
      return this.spotify.resolveSearchQuery(normalized);
    }
    if (isSoundCloudUrl(normalized)) {
      return normalized;
    }
    return normalized;
  }

  private toTrack(entry: YtEntry, requestedBy: string): Track {
    const url =
      entry.webpage_url ??
      (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : (entry.url ?? ''));

    const uploader = entry.channel || entry.uploader;

    let uploadedAt: string | undefined;
    if (entry.upload_date && /^\d{8}$/.test(entry.upload_date)) {
      const y = entry.upload_date.slice(0, 4);
      const m = entry.upload_date.slice(4, 6);
      const d = entry.upload_date.slice(6, 8);
      uploadedAt = `${y}-${m}-${d}`;
    }

    let source: Track['source'] = 'youtube';
    if (url.includes('soundcloud.com')) source = 'soundcloud';

    return {
      title: entry.title ?? 'Unknown title',
      url,
      durationSec: typeof entry.duration === 'number' ? entry.duration : 0,
      thumbnail: entry.thumbnail,
      requestedBy,
      uploader,
      views: typeof entry.view_count === 'number' ? entry.view_count : undefined,
      uploadedAt,
      source,
    };
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    _description: string,
    maxAttempts = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err: unknown) {
        lastError = err;
        const errObj = err as { message?: string; stderr?: unknown; exitCode?: number };
        const errStr = String(errObj.message ?? err ?? '');
        const stderrStr = String(errObj.stderr ?? '');
        const combined = errStr + ' ' + stderrStr;
        const isPermanentError =
          /unavailable|private video|members.only|age.restrict|this video is not available|sign in to confirm you're not a bot/i.test(
            combined,
          );
        const isTransient =
          !isPermanentError &&
          /ChildProcessError|too many requests|429|rate.?limit|temporary|timeout|ECONNRESET|socket hang up|HTTP Error 5\d\d|network/i.test(
            combined,
          );

        if (attempt < maxAttempts && isTransient) {
          const delayMs = 200 * Math.pow(2, attempt - 1) + Math.random() * 300;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }
    throw lastError;
  }
}

function scoreCandidate(
  track: Track,
  spotifyTitle: string,
  expectedDur: number | undefined,
): number | null {
  const tTitle = track.title.toLowerCase();
  const tDur = track.durationSec || 0;

  if (BAD_KEYWORDS.some((kw) => tTitle.includes(kw))) {
    return null;
  }

  let score = 0;

  if (typeof expectedDur === 'number' && expectedDur > 0 && tDur > 0) {
    const diff = Math.abs(tDur - expectedDur);
    if (diff > 30) return null;
    score += diff;
  }

  const tSimple = tTitle.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const origSimple = spotifyTitle
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .trim();
  if (origSimple && (tSimple.includes(origSimple) || origSimple.includes(tSimple))) {
    score -= 8;
  }

  if (tTitle.includes('official audio') || tTitle.includes('official video')) {
    score -= 3;
  }

  return score;
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function normalizeInput(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
}

function cleanYouTubeUrl(input: string): string {
  const id = extractYouTubeId(input);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return input;
}

function extractYouTubeId(input: string): string | null {
  try {
    const u = new URL(input);
    let id = u.searchParams.get('v');
    if (!id) {
      if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) {
        id = u.pathname.split('/').filter(Boolean).pop() || '';
      } else if (u.pathname.startsWith('/shorts/')) {
        id = u.pathname.split('/')[2] || '';
      } else if (u.pathname.startsWith('/embed/')) {
        id = u.pathname.split('/')[2] || '';
      }
    }
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    return null;
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
    return null;
  }
}

function parseDurationText(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return undefined;
}

function isSoundCloudUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.hostname === 'soundcloud.com' ||
      url.hostname.endsWith('.soundcloud.com') ||
      url.hostname === 'on.soundcloud.com'
    );
  } catch {
    return input.toLowerCase().includes('soundcloud.com');
  }
}

const RANGE_CHUNK = 256 * 1024;

function iosFetchHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': IOS_UA,
    'X-Youtube-Client-Name': '5',
    'X-Youtube-Client-Version': '19.45.4',
    Accept: '*/*',
    ...extra,
  };
}

/** HEAD/Range probe when format metadata omits content_length. */
async function probeContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: iosFetchHeaders({ Range: 'bytes=0-0' }),
      redirect: 'follow',
    });
    const cr = res.headers.get('content-range'); // bytes 0-0/12345
    const m = cr?.match(/\/(\d+)\s*$/);
    if (m) return Number(m[1]);
    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > 1) return Number(cl);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Stream googlevideo audio via sequential HTTP Range requests.
 * A single full GET is often 403; small ranges succeed.
 * Waits for the first chunk so callers fail fast on 403 instead of silent silence.
 */
async function createRangedAudioStream(
  url: string,
  knownLength: number | null,
): Promise<Readable> {
  let totalLength = knownLength;
  const firstEnd = totalLength != null ? Math.min(RANGE_CHUNK - 1, totalLength - 1) : RANGE_CHUNK - 1;

  const firstRes = await fetch(url, {
    headers: iosFetchHeaders({ Range: `bytes=0-${firstEnd}` }),
    redirect: 'follow',
  });
  if (!firstRes.ok) {
    throw new Error(`YouTube audio range HTTP ${firstRes.status} (itag stream blocked)`);
  }
  if (totalLength == null) {
    const cr = firstRes.headers.get('content-range');
    const m = cr?.match(/\/(\d+)\s*$/);
    if (m) totalLength = Number(m[1]);
  }
  const firstBuf = Buffer.from(await firstRes.arrayBuffer());
  if (firstBuf.length === 0) {
    throw new Error('YouTube audio range returned empty body.');
  }

  const pass = new PassThrough();
  let cancelled = false;
  pass.on('close', () => {
    cancelled = true;
  });

  // Push first chunk, then continue in background.
  pass.write(firstBuf);

  void (async () => {
    try {
      let start = firstBuf.length;
      while (!cancelled) {
        if (totalLength != null && start >= totalLength) break;

        const end =
          totalLength != null
            ? Math.min(start + RANGE_CHUNK - 1, totalLength - 1)
            : start + RANGE_CHUNK - 1;

        const res = await fetch(url, {
          headers: iosFetchHeaders({ Range: `bytes=${start}-${end}` }),
          redirect: 'follow',
        });

        if (!res.ok) {
          throw new Error(`YouTube audio range HTTP ${res.status} at byte ${start}`);
        }

        if (totalLength == null) {
          const cr = res.headers.get('content-range');
          const m = cr?.match(/\/(\d+)\s*$/);
          if (m) totalLength = Number(m[1]);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) break;

        if (!pass.write(buf)) {
          await new Promise<void>((resolve) => pass.once('drain', resolve));
        }

        start += buf.length;

        if (totalLength == null && buf.length < RANGE_CHUNK) break;
        if (totalLength != null && start >= totalLength) break;
      }

      pass.end();
    } catch (err) {
      pass.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return pass;
}
