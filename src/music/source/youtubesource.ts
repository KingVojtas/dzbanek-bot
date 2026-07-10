import type { Readable } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import type { Track, TrackSource } from '../../core/types';
import { SpotifySource } from './spotifysource';

/** Subset of the yt-dlp JSON payload we care about. */
interface YtEntry {
  id?: string;
  title?: string;
  duration?: number;
  webpage_url?: string;
  url?: string;
  thumbnail?: string;
}

interface YtPayload extends YtEntry {
  entries?: YtEntry[];
}

const COMMON_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  preferFreeFormats: true,
} as const;

const SEARCH_RESULT_LIMIT = 5;

/**
 * Resolves and streams audio from YouTube using yt-dlp (via youtube-dl-exec).
 * Spotify track links are converted into YouTube searches by `SpotifySource`.
 */
export class YouTubeSource implements TrackSource {
  private readonly spotify = new SpotifySource();

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const target = await this.resolveInput(input);
    const isUrl = /^https?:\/\//i.test(target);
    if (!isUrl) return this.resolveSearch(target, requestedBy);

    const raw: unknown = await youtubeDl(target, {
      dumpSingleJson: true,
      flatPlaylist: true,
      ...COMMON_FLAGS,
    });

    return this.payloadToTracks(raw, requestedBy);
  }

  private async resolveSearch(query: string, requestedBy: string): Promise<Track[]> {
    const raw: unknown = await youtubeDl(query, {
      dumpSingleJson: true,
      flatPlaylist: true,
      defaultSearch: `ytsearch${SEARCH_RESULT_LIMIT}`,
      noPlaylist: true,
      ...COMMON_FLAGS,
    });

    const candidates = this.payloadToTracks(raw, requestedBy);
    for (const candidate of candidates) {
      try {
        const playable = await this.resolveVideo(candidate.url, requestedBy);
        if (playable) return [playable];
      } catch {
        // Try the next search result; flat search can include unavailable videos.
      }
    }

    return [];
  }

  private async resolveVideo(url: string, requestedBy: string): Promise<Track | null> {
    const raw: unknown = await youtubeDl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      ...COMMON_FLAGS,
    });

    return this.payloadToTracks(raw, requestedBy)[0] ?? null;
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
    const subprocess = youtubeDl.exec(track.url, {
      output: '-',
      format: 'bestaudio[ext=webm]/bestaudio/best',
      quiet: true,
      ...COMMON_FLAGS,
    });

    // Surface failures via the audio player's 'error' event rather than as an
    // unhandled rejection on the spawned process.
    subprocess.catch(() => {});

    if (!subprocess.stdout) {
      throw new Error('Failed to open an audio stream for the requested track.');
    }
    return subprocess.stdout;
  }

  private async resolveInput(input: string): Promise<string> {
    const normalized = normalizeInput(input);
    if (this.spotify.canResolve(normalized)) {
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
    return {
      title: entry.title ?? 'Unknown title',
      url,
      durationSec: typeof entry.duration === 'number' ? entry.duration : 0,
      thumbnail: entry.thumbnail,
      requestedBy,
    };
  }
}

function normalizeInput(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
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
