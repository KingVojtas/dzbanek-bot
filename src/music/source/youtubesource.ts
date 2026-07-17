import type { Readable } from 'node:stream';
import { PassThrough, Readable as NodeReadable } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import { Innertube, UniversalCache } from 'youtubei.js';
import type { Track, TrackSource } from '../../core/types';
import {
  invalidateYtDlpCookies,
  isCookiePoisonError,
  ytCookieHeaderFromJar,
  ytDlpCookieFlags,
} from '../ytdlp-cookies';
import { createYtProxyFetch, ytDlpProxyFlags } from '../ytdlp-proxy';
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

/**
 * Cookie-free clients that still return real media URLs (probed 2026-07).
 * Order matters: yt-dlp tries left→right. Skip pure `tv` (often DRM false-positive).
 */
const COOKIE_FREE_CLIENTS =
  process.env.YTDLP_PLAYER_CLIENTS_NOCOOKIE?.trim() ||
  'android_vr,tv_simply,mweb,web_embedded,android,tv_embedded';

/** Clients that work with a real logged-in cookie jar. */
const COOKIE_CLIENTS =
  process.env.YTDLP_PLAYER_CLIENTS_COOKIE?.trim() || 'web,mweb,web_safari,tv_simply';

/** youtubei.js clients for download fallback (independent of yt-dlp). */
const INNERTUBE_STREAM_CLIENTS = [
  'IOS',
  'ANDROID',
  'TV_EMBEDDED',
  'WEB_EMBEDDED',
  'MWEB',
  'TV',
  'WEB',
] as const;

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
 * yt-dlp flags.
 *
 * CRITICAL (2026 yt-dlp):
 * - `android_vr` does NOT support cookies (yt-dlp skips it when --cookies is set).
 * - With cookies: use `web` (+ friends) + Deno EJS + progressive `18` fallback.
 * - Without cookies: multi-client chain (android_vr, mweb, web_embedded, …).
 * - On cloud IPs prefer cookies first when a jar is configured (cookie-free almost always fails).
 * - Stale cookies can make bot-check worse — only then fall back to cookie-free clients.
 * - `--get-url` then Node fetch often 403s; pipe yt-dlp stdout instead.
 */
/** Runtime flags for youtube-dl-exec (its published Flags type is incomplete). */
type YtFlags = Record<string, string | boolean | number | undefined>;

function ytCommonFlags(opts?: { useCookies?: boolean }): YtFlags {
  const useCookies = opts?.useCookies === true && hasCookieConfig();
  // Override wins for debugging; else multi-client chains (not single android_vr / web).
  const extractorArgs =
    process.env.YTDLP_EXTRACTOR_ARGS?.trim() ||
    (useCookies
      ? `youtube:player_client=${COOKIE_CLIENTS}`
      : `youtube:player_client=${COOKIE_FREE_CLIENTS}`);

  return {
    noWarnings: true,
    noCheckCertificates: true,
    noPart: true,
    noContinue: true,
    geoBypass: true,
    // Web client needs JS challenge solving for real media (not storyboard).
    jsRuntimes: process.env.YTDLP_JS_RUNTIME?.trim() || 'deno',
    remoteComponents: 'ejs:github',
    extractorArgs,
    // Residential proxy when set (YTDLP_PROXY / HTTPS_PROXY) — main fix for Railway bot-check.
    ...ytDlpProxyFlags(),
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

/** If a cookie-backed attempt failed with bot-check / expired, stop using the jar. */
function maybePoisonCookies(err: unknown, usedCookies: boolean): void {
  if (!usedCookies || !hasCookieConfig()) return;
  const text = errText(err);
  if (isCookiePoisonError(text)) {
    invalidateYtDlpCookies(text.slice(0, 200));
  }
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

/**
 * YouTube resolve via youtubei.js + stream via yt-dlp pipe.
 * Streaming: cookies + web client + Deno EJS (android_vr cannot use cookies).
 */
export class YouTubeSource implements TrackSource {
  private readonly spotify = new SpotifySource();
  private innertube: Innertube | null = null;
  private innertubeInit: Promise<Innertube> | null = null;

  private async getInnertube(): Promise<Innertube> {
    if (this.innertube) return this.innertube;
    if (!this.innertubeInit) {
      const proxyFetch = createYtProxyFetch();
      // Cookie jar optional — cookie-free Innertube is the default “engine” path.
      const cookie = hasCookieConfig() ? ytCookieHeaderFromJar() : undefined;
      this.innertubeInit = Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        ...(cookie ? { cookie } : {}),
        ...(proxyFetch ? { fetch: proxyFetch } : {}),
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

    // Prefer home worker for resolve when configured — Railway cloud IPs fail bot-check
    // on yt-dlp metadata just like streaming.
    if (process.env.MUSIC_WORKER_URL?.trim()) {
      try {
        const fromWorker = await this.resolveViaMusicWorker(target, requestedBy);
        if (fromWorker.length > 0) return fromWorker;
      } catch (err) {
        console.error('[YouTube] worker resolve failed:', errText(err).slice(0, 200));
      }
    }

    const isUrl = /^https?:\/\//i.test(target);
    if (!isUrl) {
      try {
        const found = await this.searchViaInnertube(target, requestedBy);
        if (found.length > 0) return found;
      } catch {
        /* fall through */
      }
      // Avoid yt-dlp search on cloud when worker is set (it just bot-checks)
      if (process.env.MUSIC_WORKER_URL?.trim()) {
        throw new Error(
          'Could not resolve search (music worker failed). Is the home worker + tunnel running?',
        );
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
      // oEmbed works without bot-check for title/thumbnail (no duration)
      try {
        const track = await this.resolveViaOembed(videoId, requestedBy);
        return [track];
      } catch {
        /* fall through */
      }
    }

    if (process.env.MUSIC_WORKER_URL?.trim()) {
      // Last resort with worker already tried above — return oembed-less stub if we have id
      if (videoId) {
        return [
          {
            title: 'YouTube video',
            url: `https://www.youtube.com/watch?v=${videoId}`,
            durationSec: 0,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            requestedBy,
            source: 'youtube',
          },
        ];
      }
      throw new Error(
        'Could not resolve track (music worker failed). Is the home worker + tunnel running?',
      );
    }

    return this.resolveViaYtDlpUrl(cleanTarget, requestedBy);
  }

  /** Metadata via YouTube oEmbed — no cookies, rarely bot-checked. */
  private async resolveViaOembed(videoId: string, requestedBy: string): Promise<Track> {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      {
        headers: { 'User-Agent': 'dzbanek-bot/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) throw new Error(`oembed HTTP ${res.status}`);
    const json = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!json.title) throw new Error('oembed missing title');
    return {
      title: json.title,
      url: watch,
      durationSec: 0,
      thumbnail: json.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      requestedBy,
      uploader: json.author_name,
      source: 'youtube',
    };
  }

  /** Resolve/search via home music worker (residential IP). */
  private async resolveViaMusicWorker(input: string, requestedBy: string): Promise<Track[]> {
    const base = process.env.MUSIC_WORKER_URL!.trim().replace(/\/$/, '');
    const secret = process.env.MUSIC_WORKER_SECRET?.trim();
    const endpoint = base.endsWith('/resolve') ? base : `${base}/resolve`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (secret) headers['x-music-worker-secret'] = secret;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`music worker resolve HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      tracks?: Array<{
        title?: string;
        url?: string;
        durationSec?: number;
        thumbnail?: string;
        uploader?: string;
        views?: number;
      }>;
    };
    const tracks = (json.tracks ?? [])
      .filter((t) => t.url && t.title)
      .map(
        (t): Track => ({
          title: t.title!,
          url: t.url!,
          durationSec: typeof t.durationSec === 'number' ? t.durationSec : 0,
          thumbnail: t.thumbnail,
          requestedBy,
          uploader: t.uploader,
          views: t.views,
          source: 'youtube',
        }),
      );
    return tracks;
  }

  private async resolveViaInnertube(videoId: string, requestedBy: string): Promise<Track> {
    const yt = await this.getInnertube();
    // Metadata only — do not require playable formats here (cloud IPs often LOGIN_REQUIRED
    // while the home music worker can still stream). Keeps /play resolve fast.
    const info = await yt.getBasicInfo(videoId, { client: 'IOS' });
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

    // If we got no useful metadata, fail so yt-dlp resolve can try.
    if (!basic?.title && !durationSec) {
      const status = info.playability_status?.status;
      const reason = info.playability_status?.reason || status || 'no metadata';
      throw new Error(`YouTube playability ${status ?? 'unknown'}: ${reason}`);
    }

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
      try {
        return await youtubeDl(target, {
          ...flags,
          ...ytCommonFlags({ useCookies: true }),
        } as Parameters<typeof youtubeDl>[1]);
      } catch (cookieErr) {
        maybePoisonCookies(cookieErr, true);
        throw cookieErr;
      }
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
    if (track.source === 'soundcloud' || isSoundCloudUrl(track.url)) {
      return this.streamViaYtDlpPipe(track.url, {
        preferCookies: false,
        formats: ['bestaudio/best', 'best'],
      });
    }

    const videoId = extractYouTubeId(track.url);
    const errors: string[] = [];
    const hasWorker = Boolean(process.env.MUSIC_WORKER_URL?.trim());

    // Home/residential worker first (and only, when configured) — avoids slow
    // multi-engine bot-check timeouts on Railway cloud IPs.
    if (hasWorker) {
      try {
        console.log('[YouTube] engine: music worker…');
        return await this.streamViaMusicWorker(track.url);
      } catch (workerErr) {
        const msg = errText(workerErr).slice(0, 300);
        console.error('[YouTube] music worker failed:', msg);
        errors.push(`worker: ${msg}`);
        // Fall through to local engines only if worker is broken
      }
    }

    // Cookie-free engine (works on residential/home IPs; cloud may bot-check).
    if (videoId) {
      try {
        console.log('[YouTube] engine: youtubei.js (cookie-free)…');
        return await this.streamViaInnertube(videoId);
      } catch (innertubeErr) {
        const msg = errText(innertubeErr).slice(0, 300);
        console.error('[YouTube] youtubei.js stream failed:', msg);
        errors.push(`innertube: ${msg}`);
        // Skip the rest of the innertube client chain is already internal;
        // if bot-check, local yt-dlp on Railway almost always fails too — bail faster.
        if (hasWorker && isYoutubeBotCheck(msg)) {
          throw new Error(
            `Sign in to confirm you're not a bot. ${errors.join(' || ')}`.slice(0, 1500),
            { cause: innertubeErr },
          );
        }
      }
    }

    try {
      console.log('[YouTube] engine: yt-dlp cookie-free multi-client…');
      return await this.streamViaYtDlpPipe(track.url, {
        preferCookies: false,
        forceNoCookies: true,
        // Fewer formats = faster fail when IP is blocked
        formats: hasWorker ? ['bestaudio/best'] : ['bestaudio/best', '18/bestaudio/best', 'best'],
      });
    } catch (noCookieErr) {
      const msg = errText(noCookieErr).slice(0, 300);
      console.error('[YouTube] cookie-free yt-dlp pipe failed:', msg);
      errors.push(`yt-dlp-nocookie: ${msg}`);
    }

    if (hasCookieConfig()) {
      try {
        console.log('[YouTube] engine: yt-dlp + cookies (fallback)…');
        return await this.streamViaYtDlpPipe(track.url, {
          preferCookies: true,
          formats: ['18/bestaudio/best', 'bestaudio/best'],
        });
      } catch (cookieErr) {
        const msg = errText(cookieErr).slice(0, 300);
        console.error('[YouTube] cookie yt-dlp pipe failed:', msg);
        errors.push(`yt-dlp-cookie: ${msg}`);
        maybePoisonCookies(cookieErr, true);
      }
    }

    // Last resort: SoundCloud (often works without bot-check; may be a different upload).
    if (track.title && track.title.trim().length >= 3) {
      try {
        const q = track.title
          .replace(/[^\p{L}\p{N}\s\-_.']/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        console.log(`[YouTube] engine: SoundCloud fallback scsearch1:${q.slice(0, 80)}…`);
        return await this.streamViaYtDlpPipe(`scsearch1:${q}`, {
          preferCookies: false,
          forceNoCookies: true,
          formats: ['bestaudio/best'],
        });
      } catch (scErr) {
        const msg = errText(scErr).slice(0, 300);
        console.error('[YouTube] SoundCloud fallback failed:', msg);
        errors.push(`soundcloud: ${msg}`);
      }
    }

    const combined = errors.join(' || ') || 'unknown stream failure';
    if (isYoutubeBotCheck(combined)) {
      throw new Error(`Sign in to confirm you're not a bot. ${combined}`.slice(0, 1500));
    }
    throw new Error(`Could not open YouTube audio stream. ${combined}`.slice(0, 1500));
  }

  /**
   * Stream via a remote worker (home PC / residential VPS) that runs yt-dlp locally.
   * POST {url} → raw audio body. Optional header x-music-worker-secret.
   */
  private async streamViaMusicWorker(url: string): Promise<Readable> {
    const base = process.env.MUSIC_WORKER_URL!.trim().replace(/\/$/, '');
    const secret = process.env.MUSIC_WORKER_SECRET?.trim();
    const endpoint = base.endsWith('/stream') ? base : `${base}/stream`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/octet-stream, audio/*, */*',
    };
    if (secret) headers['x-music-worker-secret'] = secret;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`music worker HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error('music worker returned empty body');
    }

    const nodeStream = NodeReadable.fromWeb(
      res.body as import('stream/web').ReadableStream<Uint8Array>,
    );
    // Fail faster when the home worker is down / tunnel dead
    return ensureStreamHasData(nodeStream, 12_000);
  }

  /**
   * Stream audio via youtubei.js (Innertube download → Node Readable).
   * Tries several client profiles until one returns real media bytes.
   */
  private async streamViaInnertube(videoId: string): Promise<Readable> {
    const yt = await this.getInnertube();
    let lastError: unknown;

    for (const client of INNERTUBE_STREAM_CLIENTS) {
      try {
        const info = await yt.getBasicInfo(videoId, { client: client as never });
        const status = info.playability_status?.status;
        if (status && status !== 'OK') {
          throw new Error(`playability ${status}: ${info.playability_status?.reason ?? ''}`);
        }
        const formatCount =
          (info.streaming_data?.adaptive_formats?.length ?? 0) +
          (info.streaming_data?.formats?.length ?? 0);
        if (formatCount === 0) {
          throw new Error('no streaming_data formats');
        }

        const webStream = await info.download({
          type: 'audio',
          quality: 'best',
          client: client as never,
        });

        // Node 22+: convert Web ReadableStream → Node stream for @discordjs/voice.
        const nodeStream = NodeReadable.fromWeb(
          webStream as import('stream/web').ReadableStream<Uint8Array>,
        );

        // Wait for first byte so we fail fast if the CDN 403s after open.
        const ready = await ensureStreamHasData(nodeStream, 20_000);
        console.log(`[YouTube] youtubei.js OK client=${client}`);
        return ready;
      } catch (err) {
        lastError = err;
        console.error(`[YouTube] youtubei.js client=${client} failed:`, errText(err).slice(0, 160));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('youtubei.js could not open an audio stream.');
  }

  private async streamViaYtDlpPipe(
    url: string,
    opts: {
      preferCookies: boolean;
      forceNoCookies?: boolean;
      formats: string[];
    },
  ): Promise<Readable> {
    let lastError: unknown;
    const modes: boolean[] = [];
    if (opts.forceNoCookies) {
      modes.push(false);
    } else if (opts.preferCookies && hasCookieConfig()) {
      // Prefer cookies only when caller explicitly wants the cookie path.
      modes.push(true);
    } else {
      modes.push(false);
      if (hasCookieConfig()) modes.push(true);
    }

    for (const useCookies of modes) {
      for (const format of opts.formats) {
        try {
          console.log(`[YouTube] yt-dlp pipe try cookies=${useCookies} format=${format}`);
          return await this.openAudioStream(url, format, useCookies);
        } catch (err) {
          lastError = err;
          maybePoisonCookies(err, useCookies);
          console.error(
            `[YouTube] pipe failed cookies=${useCookies} format=${format}:`,
            errText(err).slice(0, 200),
          );
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to open an audio stream for the requested track.');
  }

  private openAudioStream(url: string, format: string, useCookies: boolean): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const flags = ytCommonFlags({ useCookies });
      console.log(
        `[YouTube] spawn yt-dlp format=${format} cookies=${useCookies} extractor=${flags.extractorArgs}`,
      );
      const subprocess = youtubeDl.exec(url, {
        output: '-',
        format,
        quiet: true,
        noPlaylist: true,
        ...flags,
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
  const parts = text
    .trim()
    .split(':')
    .map((p) => Number(p));
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

/**
 * Ensure the stream actually yields media before handing it to the voice player.
 * Returns a PassThrough that includes the first chunk (nothing is lost).
 */
function ensureStreamHasData(stream: Readable, timeoutMs: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      try {
        pass.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for first audio byte (${timeoutMs}ms).`));
    }, timeoutMs);

    stream.once('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pass.write(chunk);
      stream.pipe(pass);
      stream.on('error', (err) => {
        if (!pass.destroyed) pass.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      resolve(pass);
    });

    stream.once('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    stream.once('end', () => {
      fail(new Error('Stream ended before any audio data.'));
    });
  });
}
