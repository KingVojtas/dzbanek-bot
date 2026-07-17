export interface SpotifyTrackMetadata {
  title: string;
  artist?: string;
  /** Album / cover art URL (og:image or API). */
  image?: string;
  durationSec?: number;
  /** Canonical open.spotify.com track URL. */
  spotifyUrl?: string;
  albumName?: string;
}

export interface SpotifyCollectionTrack {
  title: string;
  artist?: string;
  durationSec?: number;
  /** Album or playlist name, helps make YouTube searches more precise */
  contextName?: string;
  /** Cover art URL when available from the Spotify API. */
  image?: string;
  /** open.spotify.com track URL when known. */
  spotifyUrl?: string;
}

export class SpotifySource {
  canResolve(input: string): boolean {
    return isSpotifyUrl(input);
  }

  async resolveSearchQuery(input: string): Promise<string> {
    const metadata = await this.resolveTrackMetadata(input);
    return spotifyMetadataToSearchQuery(metadata);
  }

  /** Full track metadata for the music player panel (art, artist, duration). */
  async resolveTrackMetadata(input: string): Promise<SpotifyTrackMetadata> {
    const creds = this.getSpotifyCreds();
    if (creds) {
      try {
        return await this.fetchTrackViaApi(input, creds.clientId, creds.clientSecret);
      } catch (err) {
        console.warn('[Spotify] API track resolve failed, falling back to og: tags:', err);
      }
    }
    return fetchSpotifyTrackMetadata(input);
  }

  private async fetchTrackViaApi(
    input: string,
    clientId: string,
    clientSecret: string,
  ): Promise<SpotifyTrackMetadata> {
    const trackId = extractSpotifyTrackId(input);
    if (!trackId) throw new Error('Unable to parse Spotify track ID');
    const token = await this.fetchSpotifyAccessToken(clientId, clientSecret);
    const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Spotify track API error ${res.status}`);
    const json = (await res.json()) as {
      name?: string;
      artists?: Array<{ name?: string }>;
      duration_ms?: number;
      external_urls?: { spotify?: string };
      album?: { name?: string; images?: Array<{ url?: string }> };
    };
    if (!json.name) throw new Error('Spotify track API missing name');
    const image =
      json.album?.images?.find((i) => i.url)?.url || json.album?.images?.[0]?.url || undefined;
    return {
      title: json.name,
      artist:
        json.artists
          ?.map((a) => a.name)
          .filter(Boolean)
          .join(', ') || undefined,
      image,
      durationSec:
        typeof json.duration_ms === 'number' ? Math.floor(json.duration_ms / 1000) : undefined,
      spotifyUrl: json.external_urls?.spotify || `https://open.spotify.com/track/${trackId}`,
      albumName: json.album?.name,
    };
  }

  async resolveSpotifyCollection(input: string): Promise<SpotifyCollectionTrack[]> {
    if (!isSpotifyPlaylistUrl(input) && !isSpotifyAlbumUrl(input)) {
      throw new Error('Not a Spotify playlist or album URL');
    }

    // Official Spotify Web API is required for full album/playlist track lists.
    const creds = this.getSpotifyCreds();
    if (!creds) {
      throw new Error(
        'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required for Spotify playlists and albums. Set them in .env (https://developer.spotify.com/dashboard). Single track URLs work without credentials.',
      );
    }

    try {
      const tracks = await this.fetchCollectionViaApi(input, creds.clientId, creds.clientSecret);
      if (tracks.length > 0) {
        return tracks;
      }
      throw new Error('Spotify API returned no tracks for that playlist/album.');
    } catch (err) {
      if (err instanceof Error && err.message.includes('SPOTIFY_CLIENT')) {
        throw err;
      }
      console.warn('[Spotify] API resolve failed for collection:', err);
      throw new Error(
        err instanceof Error
          ? `Failed to resolve Spotify collection: ${err.message}`
          : 'Failed to resolve Spotify collection.',
        { cause: err },
      );
    }
  }

  private getSpotifyCreds(): { clientId: string; clientSecret: string } | null {
    const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
    return null;
  }

  private extractSpotifyId(input: string): { id: string; type: 'album' | 'playlist' } | null {
    try {
      if (input.startsWith('spotify:')) {
        const parts = input.split(':');
        const type = parts[1];
        const id = parts[2];
        if ((type === 'album' || type === 'playlist') && id) {
          return { id, type: type as 'album' | 'playlist' };
        }
      }
      const u = new URL(input);
      const segments = u.pathname.split('/').filter(Boolean);
      const typeIndex = segments.findIndex((s) => s === 'album' || s === 'playlist');
      if (typeIndex !== -1) {
        const type = segments[typeIndex] as 'album' | 'playlist';
        const idPart = segments[typeIndex + 1];
        if (idPart) {
          const id = idPart.split('?')[0].split('#')[0];
          if (id) return { id, type };
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async fetchSpotifyAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`Spotify token request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new Error('Spotify token response missing access_token');
    }
    return json.access_token;
  }

  private async fetchCollectionViaApi(
    input: string,
    clientId: string,
    clientSecret: string,
  ): Promise<SpotifyCollectionTrack[]> {
    const parsed = this.extractSpotifyId(input);
    if (!parsed) {
      throw new Error('Unable to parse Spotify album/playlist ID from URL');
    }

    const token = await this.fetchSpotifyAccessToken(clientId, clientSecret);
    const headers = { Authorization: `Bearer ${token}` };

    const results: SpotifyCollectionTrack[] = [];
    let nextUrl: string | null;

    if (parsed.type === 'album') {
      // Fetch full album for the album name (great for disambiguating YouTube searches)
      // and its tracks (includes duration).
      const albumRes = await fetch(`https://api.spotify.com/v1/albums/${parsed.id}`, { headers });
      if (!albumRes.ok) {
        throw new Error(`Spotify album API error ${albumRes.status}`);
      }
      const album = (await albumRes.json()) as {
        name?: string;
        images?: Array<{ url?: string }>;
        tracks?: {
          items?: Array<{
            name?: string;
            artists?: Array<{ name?: string }>;
            duration_ms?: number;
            external_urls?: { spotify?: string };
            id?: string;
          }>;
          next?: string | null;
        };
      };
      const contextName = album.name || undefined;

      // The tracks are nested under album.tracks.items (may need paging for very large releases)
      let trackItems = album.tracks?.items ?? [];
      let tracksNext = album.tracks?.next ?? null;

      // Handle pagination for tracks if the album has >50 tracks (rare)
      while (tracksNext) {
        const moreRes = await fetch(tracksNext, { headers });
        if (!moreRes.ok) break;
        const more = (await moreRes.json()) as {
          items?: Array<Record<string, unknown>>;
          next?: string | null;
        };
        trackItems = trackItems.concat(more.items ?? []);
        tracksNext = more.next ?? null;
      }

      const albumImage = album.images?.[0]?.url;
      for (const item of trackItems) {
        if (item?.name) {
          results.push({
            title: item.name,
            artist:
              item.artists
                ?.map((a) => a?.name)
                .filter(Boolean)
                .join(', ') || undefined,
            durationSec:
              typeof item.duration_ms === 'number'
                ? Math.floor(item.duration_ms / 1000)
                : undefined,
            contextName,
            image: albumImage,
            spotifyUrl:
              item.external_urls?.spotify ||
              (item.id ? `https://open.spotify.com/track/${item.id}` : undefined),
          });
        }
      }
    } else {
      // playlist: structure differs (items[].track)
      // Also fetch playlist name for search context
      const plRes = await fetch(`https://api.spotify.com/v1/playlists/${parsed.id}?fields=name`, {
        headers,
      });
      const plName = plRes.ok ? ((await plRes.json()) as { name?: string }).name : undefined;

      nextUrl = `https://api.spotify.com/v1/playlists/${parsed.id}/tracks?limit=50&fields=items(track(id,name,artists(name),duration_ms,external_urls,album(images))),next`;
      while (nextUrl) {
        const res = await fetch(nextUrl, { headers });
        if (!res.ok) {
          throw new Error(`Spotify playlist tracks API error ${res.status}`);
        }
        const data = (await res.json()) as {
          items?: Array<{
            track?: {
              id?: string;
              name?: string;
              artists?: Array<{ name?: string }>;
              duration_ms?: number;
              external_urls?: { spotify?: string };
              album?: { images?: Array<{ url?: string }> };
            } | null;
          }>;
          next?: string | null;
        };
        for (const wrapper of data.items ?? []) {
          const t = wrapper?.track;
          if (t?.name) {
            results.push({
              title: t.name,
              artist:
                t.artists
                  ?.map((a) => a?.name)
                  .filter(Boolean)
                  .join(', ') || undefined,
              durationSec:
                typeof t.duration_ms === 'number' ? Math.floor(t.duration_ms / 1000) : undefined,
              contextName: plName,
              image: t.album?.images?.[0]?.url,
              spotifyUrl:
                t.external_urls?.spotify ||
                (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
            });
          }
        }
        nextUrl = data.next ?? null;
      }
    }

    return results;
  }
}

function isSpotifyUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'spotify:') return true;
    return (
      url.hostname === 'open.spotify.com' ||
      url.hostname.endsWith('.spotify.com') ||
      url.hostname === 'spotify.link' ||
      url.hostname.endsWith('.spotify.link')
    );
  } catch {
    return input.startsWith('spotify:');
  }
}

export function isSpotifyPlaylistUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'spotify:')
      return input.includes('playlist:') || input.includes('playlist/');
    const path = url.pathname.toLowerCase();
    return (
      (url.hostname.includes('spotify.com') || url.hostname.includes('spotify.link')) &&
      path.includes('/playlist/')
    );
  } catch {
    return input.toLowerCase().includes('playlist:') || input.toLowerCase().includes('/playlist/');
  }
}

export function isSpotifyAlbumUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'spotify:') return input.includes('album:') || input.includes('album/');
    const path = url.pathname.toLowerCase();
    return (
      (url.hostname.includes('spotify.com') || url.hostname.includes('spotify.link')) &&
      path.includes('/album/')
    );
  } catch {
    return input.toLowerCase().includes('album:') || input.toLowerCase().includes('/album/');
  }
}

async function fetchSpotifyTrackMetadata(input: string): Promise<SpotifyTrackMetadata> {
  const url = toSpotifyTrackUrl(input);
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify returned HTTP ${response.status} while resolving ${url}.`);
  }

  if (!isSpotifyTrackUrl(response.url)) {
    throw new Error('Only Spotify track URLs are supported.');
  }

  const html = await response.text();
  const title = readMetaContent(html, 'og:title') ?? readTitle(html);
  if (!title) throw new Error('Spotify track metadata did not include a title.');

  const description = readMetaContent(html, 'og:description');
  const artist = description?.split('\u00b7')[0]?.trim();
  const image = readMetaContent(html, 'og:image') ?? undefined;

  return {
    title: decodeHtmlEntities(title),
    artist: artist ? decodeHtmlEntities(artist) : undefined,
    image: image ? decodeHtmlEntities(image) : undefined,
    spotifyUrl: response.url.split('?')[0],
  };
}

function extractSpotifyTrackId(input: string): string | null {
  try {
    if (input.startsWith('spotify:track:')) {
      return input.split(':')[2] || null;
    }
    const u = new URL(toSpotifyTrackUrl(input));
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('track');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].split('?')[0];
  } catch {
    /* ignore */
  }
  return null;
}

function toSpotifyTrackUrl(input: string): string {
  if (input.startsWith('spotify:track:')) {
    const id = input.split(':')[2];
    if (id) return `https://open.spotify.com/track/${id}`;
  }

  if (!isSpotifyTrackUrl(input) && !isSpotifyUrl(input)) {
    throw new Error('Only Spotify track URLs are supported.');
  }

  return input;
}

export function isSpotifyTrackUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'spotify:') return input.startsWith('spotify:track:');
    if (!url.hostname.includes('spotify.com') && !url.hostname.includes('spotify.link')) {
      return false;
    }
    return url.pathname.split('/').includes('track');
  } catch {
    return input.startsWith('spotify:track:');
  }
}

function spotifyMetadataToSearchQuery(metadata: SpotifyTrackMetadata): string {
  return [metadata.artist, metadata.title, 'official audio'].filter(Boolean).join(' ');
}

function readMetaContent(html: string, property: string): string | undefined {
  const marker = `<meta property="${property}" content="`;
  return readBetween(html, marker, '"');
}

function readTitle(html: string): string | undefined {
  const title = readBetween(html, '<title>', '</title>');
  return title
    ?.replace(/\s+\|\s+Spotify$/, '')
    .replace(/\s+-\s+song.*$/, '')
    .trim();
}

function readBetween(input: string, start: string, end: string): string | undefined {
  const startIndex = input.indexOf(start);
  if (startIndex === -1) return undefined;

  const valueStart = startIndex + start.length;
  const endIndex = input.indexOf(end, valueStart);
  if (endIndex === -1) return undefined;

  return input.slice(valueStart, endIndex);
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';

    const radix = entity.toLowerCase().startsWith('#x') ? 16 : 10;
    const codePoint = parseInt(entity.replace(/^#x?/i, ''), radix);
    return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
  });
}
