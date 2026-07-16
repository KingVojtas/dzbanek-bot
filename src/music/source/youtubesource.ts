import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import type { Track, TrackSource } from '../../core/types';
import { ytDlpCookieFlags } from '../ytdlp-cookies';
import {
  SpotifySource,
  isSpotifyPlaylistUrl,
  isSpotifyAlbumUrl,
  type SpotifyCollectionTrack,
} from './spotifysource';

/** Subset of the yt-dlp JSON payload we care about. */
interface YtEntry {
  id?: string;
  title?: string;
  duration?: number;
  webpage_url?: string;
  url?: string;
  thumbnail?: string;
  // Rich metadata we want to surface in embeds
  channel?: string;
  uploader?: string;
  view_count?: number;
  like_count?: number;
  upload_date?: string; // yyyymmdd
  timestamp?: number;
}

interface YtPayload extends YtEntry {
  entries?: YtEntry[];
}

/**
 * Shared yt-dlp flags.
 * YouTube now requires JS challenge solving (EJS) or only storyboard images are returned
 * → "Requested format is not available". Deno (or Node) + remote EJS scripts fix this.
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 */
function ytCommonFlags(): Record<string, string | boolean> {
  return {
    noWarnings: true,
    noCheckCertificates: true,
    noPart: true,
    noContinue: true,
    geoBypass: true,
    // Prefer Deno; fall back to Node if Deno is not on PATH (local dev).
    jsRuntimes: process.env.YTDLP_JS_RUNTIME?.trim() || 'deno,node',
    remoteComponents: 'ejs:github',
  };
}

/** How many YouTube search hits to fetch per query (scored from flat metadata only). */
const SEARCH_RESULT_LIMIT = 5;
/** Parallel Spotify→YouTube matches per album/playlist (keeps YouTube load reasonable). */
const COLLECTION_CONCURRENCY = 4;
/**
 * Score threshold for early exit: duration diff (sec) plus bonuses.
 * Lower is better; title match (−8) + official (−3) + tiny duration drift is "good enough".
 */
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
 * Resolves and streams audio from YouTube using yt-dlp (via youtube-dl-exec).
 * Spotify track links are converted into YouTube searches by `SpotifySource`.
 */
export class YouTubeSource implements TrackSource {
  private readonly spotify = new SpotifySource();

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const target = await this.resolveInput(input);

    // Special handling for Spotify playlists and albums:
    // Resolve via Spotify API (when configured) to get track list,
    // then search YouTube per-track (flat metadata only, concurrent) for playable URLs.
    const isSpotifyCollection = isSpotifyPlaylistUrl(target) || isSpotifyAlbumUrl(target);
    if (isSpotifyCollection) {
      const collectionTracks = await this.spotify.resolveSpotifyCollection(target);
      const matched = await mapPool(collectionTracks, COLLECTION_CONCURRENCY, (pt) =>
        this.resolveCollectionTrack(pt, requestedBy),
      );
      return matched.filter((t): t is Track => t != null);
    }

    const isUrl = /^https?:\/\//i.test(target);
    if (!isUrl) return this.resolveSearch(target, requestedBy);

    const cleanTarget = cleanYouTubeUrl(target);

    const raw: unknown = await this.withRetries(
      () =>
        youtubeDl(cleanTarget, {
          dumpSingleJson: true,
          noPlaylist: true,
          ...ytCommonFlags(),
          ...ytDlpCookieFlags(),
        }),
      'direct url',
    );

    return this.payloadToTracks(raw, requestedBy);
  }

  /**
   * Match one Spotify collection track to a YouTube URL using flat search only
   * (no per-candidate full extract — stream() does that at play time).
   */
  private async resolveCollectionTrack(
    pt: SpotifyCollectionTrack,
    requestedBy: string,
  ): Promise<Track | null> {
    const artist = (pt.artist || '').trim();
    const title = (pt.title || '').trim();
    const context = (pt.contextName || '').trim();

    // Primary + one fallback only (was up to 6 sequential queries).
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
        const cands = await this.flatSearch(q, requestedBy);
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
        // try next query
      }
    }

    if (best) {
      best.source = 'spotify';
      if (!best.uploader && artist) best.uploader = artist;
      return best;
    }

    // Last resort: loose single search (flat only).
    try {
      const fallback = await this.resolveSearch(title || artist, requestedBy);
      if (fallback.length > 0) {
        const t = fallback[0];
        t.source = 'spotify';
        if (!t.uploader && artist) t.uploader = artist;
        return t;
      }
    } catch {
      // give up on this track
    }
    return null;
  }

  /** Flat ytsearch — one yt-dlp spawn; entries already include title/duration/url. */
  private async flatSearch(query: string, requestedBy: string): Promise<Track[]> {
    const raw: unknown = await this.withRetries(
      () =>
        youtubeDl(query, {
          dumpSingleJson: true,
          flatPlaylist: true,
          defaultSearch: `ytsearch${SEARCH_RESULT_LIMIT}`,
          noPlaylist: true,
          ...ytCommonFlags(),
          ...ytDlpCookieFlags(),
        }),
      'search',
    );
    return this.payloadToTracks(raw, requestedBy);
  }

  private async resolveSearch(query: string, requestedBy: string): Promise<Track[]> {
    const candidates = await this.flatSearch(query, requestedBy);
    // Prefer first flat hit with a playable URL; stream() re-extracts at play time.
    const usable = candidates.find((c) => Boolean(c.url));
    return usable ? [usable] : [];
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
    let lastError: unknown;
    // Flexible selectors. yt-dlp `/` = fallback chain within one request.
    const formats = ['bestaudio/best', '140/251/250/249/18/best', 'best'];

    for (let attempt = 0; attempt < formats.length; attempt++) {
      try {
        return await this.openAudioStream(track.url, formats[attempt]);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to open an audio stream for the requested track.');
  }

  /**
   * Spawn yt-dlp writing audio to stdout. Wait until the first bytes arrive so
   * we fail fast when YouTube blocks the host (common on cloud IPs) instead of
   * returning an empty stream that goes Idle with no sound.
   */
  private openAudioStream(url: string, format: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const subprocess = youtubeDl.exec(url, {
        output: '-',
        format,
        quiet: true,
        noPlaylist: true,
        // Don't abort when a preferred format is missing — try the next in the chain.
        // (youtube-dl-exec maps this to --ignore-no-formats-error is different; keep format chain.)
        ...ytCommonFlags(),
        ...ytDlpCookieFlags(),
      });

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
            fail(
              new Error(
                errText || `yt-dlp exited without audio (format=${format}).`,
              ),
            );
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
        // For collections (playlists/albums), return original URL so we can extract multiple tracks
        return normalized;
      }
      return this.spotify.resolveSearchQuery(normalized);
    }
    if (isSoundCloudUrl(normalized)) {
      // yt-dlp handles SoundCloud URLs natively for both metadata and audio
      return normalized;
    }
    return normalized;
  }

  private toTrack(entry: YtEntry, requestedBy: string): Track {
    const url =
      entry.webpage_url ??
      (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : (entry.url ?? ''));

    // Prefer human channel name, fall back to uploader
    const uploader = entry.channel || entry.uploader;

    // Convert yyyymmdd to a readable short string when available
    let uploadedAt: string | undefined;
    if (entry.upload_date && /^\d{8}$/.test(entry.upload_date)) {
      const y = entry.upload_date.slice(0, 4);
      const m = entry.upload_date.slice(4, 6);
      const d = entry.upload_date.slice(6, 8);
      uploadedAt = `${y}-${m}-${d}`;
    }

    // Determine source from the final playable URL (works for direct SoundCloud too)
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

  /**
   * Run a yt-dlp operation with limited retries for transient failures
   * (bot checks, rate limits, temporary network, extractor blips, etc.).
   * This is the main lever for making YouTube URLs "work 100%" in practice.
   */
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
        // Only retry clear transients — not every non-zero exitCode (those often fail the same way).
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

/**
 * Score a flat-search candidate against Spotify metadata.
 * Returns null if hard-rejected; lower scores are better.
 */
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

  // Flat search usually includes duration; if missing (0), skip the filter rather than reject.
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

/** Run `fn` over `items` with at most `concurrency` in flight; preserve order. */
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
  try {
    const u = new URL(input);
    let id = u.searchParams.get('v');
    if (!id) {
      if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) {
        id = u.pathname.split('/').filter(Boolean).pop() || '';
      } else if (u.pathname.startsWith('/shorts/')) {
        id = u.pathname.split('/')[2] || '';
      }
    }
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return `https://www.youtube.com/watch?v=${id}`;
    }
    return input;
  } catch {
    return input;
  }
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
