import youtubeDl from 'youtube-dl-exec';
import type { Readable } from 'node:stream';
import type { Track, TrackSource } from '../../core/types';

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

/**
 * Resolves and streams audio from YouTube using yt-dlp (via youtube-dl-exec).
 * yt-dlp is the most resilient option against YouTube's frequent changes; if it
 * ever breaks, update the binary or swap this class for another `TrackSource`.
 */
export class YouTubeSource implements TrackSource {
  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const isUrl = /^https?:\/\//i.test(input);

    const raw: unknown = await youtubeDl(input, {
      dumpSingleJson: true,
      flatPlaylist: true,
      // A bare search term resolves to the single best match; a URL resolves directly.
      defaultSearch: 'ytsearch1',
      noPlaylist: !isUrl,
      ...COMMON_FLAGS,
    });

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
