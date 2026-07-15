interface SpotifyTrackMetadata {
  title: string;
  artist?: string;
}

export interface SpotifyCollectionTrack {
  title: string;
  artist?: string;
  durationSec?: number;
  /** Album or playlist name, helps make YouTube searches more precise */
  contextName?: string;
}

export class SpotifySource {
  canResolve(input: string): boolean {
    return isSpotifyUrl(input);
  }

  async resolveSearchQuery(input: string): Promise<string> {
    const metadata = await fetchSpotifyTrackMetadata(input);
    return spotifyMetadataToSearchQuery(metadata);
  }

  async resolveSpotifyCollection(input: string): Promise<SpotifyCollectionTrack[]> {
    if (!isSpotifyPlaylistUrl(input) && !isSpotifyAlbumUrl(input)) {
      throw new Error('Not a Spotify playlist or album URL');
    }

    // Prefer the official Spotify Web API (requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET in env).
    // This is the only reliable way to get the full track list for albums/playlists.
    const creds = this.getSpotifyCreds();
    if (creds) {
      try {
        const tracks = await this.fetchCollectionViaApi(input, creds.clientId, creds.clientSecret);
        if (tracks.length > 0) {
          return tracks;
        }
      } catch (err) {
        console.warn('[Spotify] API resolve failed for collection:', err);
      }
    } else {
      console.warn(
        '[Spotify] No SPOTIFY_CLIENT_ID/SECRET configured – Spotify playlists/albums will only return a single track (name search fallback). Set the env vars for full support.',
      );
    }

    // Fallback: we cannot reliably extract the full tracklist from the Spotify web page without the API.
    // This produces a single pseudo-track (the collection title) which typically results in only one song.
    const meta = await fetchSpotifyCollectionMetadata(input);
    console.warn('[Spotify] Falling back to single album/playlist name search for', input);
    return [{ title: meta.title, artist: meta.artist }];
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
        tracks?: {
          items?: Array<{
            name?: string;
            artists?: Array<{ name?: string }>;
            duration_ms?: number;
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

      nextUrl = `https://api.spotify.com/v1/playlists/${parsed.id}/tracks?limit=50&fields=items(track(name,artists(name),duration_ms)),next`;
      while (nextUrl) {
        const res = await fetch(nextUrl, { headers });
        if (!res.ok) {
          throw new Error(`Spotify playlist tracks API error ${res.status}`);
        }
        const data = (await res.json()) as {
          items?: Array<{
            track?: {
              name?: string;
              artists?: Array<{ name?: string }>;
              duration_ms?: number;
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
  const response = await fetch(url, { headers: { Accept: 'text/html' } });

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

  return {
    title: decodeHtmlEntities(title),
    artist: artist ? decodeHtmlEntities(artist) : undefined,
  };
}

async function fetchSpotifyCollectionMetadata(input: string): Promise<SpotifyTrackMetadata> {
  // Normalize to https url
  let url = input;
  if (input.startsWith('spotify:')) {
    const parts = input.split(':');
    if (parts.length === 3) {
      const type = parts[1];
      const id = parts[2];
      url = `https://open.spotify.com/${type}/${id}`;
    }
  }

  const response = await fetch(url, { headers: { Accept: 'text/html' } });

  if (!response.ok) {
    throw new Error(`Spotify returned HTTP ${response.status} for collection ${url}.`);
  }

  const html = await response.text();
  const ogTitle = readMetaContent(html, 'og:title') ?? readTitle(html);
  if (!ogTitle) throw new Error('Could not extract album/playlist title from Spotify page.');

  // og:title for collections is often "Name • Artist" or "Name"
  let title = ogTitle;
  let artist: string | undefined;

  if (ogTitle.includes(' • ')) {
    const parts = ogTitle.split(' • ');
    title = parts[0];
    artist = parts[1];
  }

  const description = readMetaContent(html, 'og:description');
  if (!artist && description) {
    // sometimes artist in desc
    artist = description.split('·')[0]?.trim();
  }

  return {
    title: decodeHtmlEntities(title),
    artist: artist ? decodeHtmlEntities(artist) : undefined,
  };
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

function isSpotifyTrackUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'spotify:') return input.startsWith('spotify:track:');
    if (url.hostname !== 'open.spotify.com') return false;
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
