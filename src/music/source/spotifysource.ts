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
    // Follow spotify.link / short redirects so /album vs /playlist is correct.
    const resolvedInput = await expandSpotifyUrl(input);
    if (!isSpotifyPlaylistUrl(resolvedInput) && !isSpotifyAlbumUrl(resolvedInput)) {
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
      const tracks = await this.fetchCollectionViaApi(
        resolvedInput,
        creds.clientId,
        creds.clientSecret,
      );
      if (tracks.length > 0) {
        return tracks;
      }
      throw new Error('Spotify API returned no tracks for that playlist/album.');
    } catch (err) {
      if (err instanceof Error && err.message.includes('SPOTIFY_CLIENT')) {
        throw err;
      }
      console.warn('[Spotify] API resolve failed for collection:', err);
      const detail = err instanceof Error ? err.message : String(err);
      // Surface actionable 403 hints (private playlist / bad app credentials)
      if (/403/.test(detail)) {
        throw new Error(
          'Spotify denied access (HTTP 403). For playlists, the list must be **Public**. ' +
            'For albums, check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET on the bot host. ' +
            `(${detail})`,
          { cause: err },
        );
      }
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
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const market = process.env.SPOTIFY_MARKET?.trim() || 'US';

    if (parsed.type === 'album') {
      return this.fetchAlbumTracks(parsed.id, headers, market);
    }
    return this.fetchPlaylistTracks(parsed.id, headers, market);
  }

  private async fetchAlbumTracks(
    albumId: string,
    headers: Record<string, string>,
    market: string,
  ): Promise<SpotifyCollectionTrack[]> {
    // Album metadata (name + cover)
    const albumRes = await fetch(
      `https://api.spotify.com/v1/albums/${albumId}?market=${encodeURIComponent(market)}`,
      { headers },
    );
    if (!albumRes.ok) {
      const body = await albumRes.text().catch(() => '');
      throw new Error(
        `Spotify album API error ${albumRes.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
      );
    }
    const album = (await albumRes.json()) as {
      name?: string;
      images?: Array<{ url?: string }>;
    };
    const contextName = album.name || undefined;
    const albumImage = album.images?.[0]?.url;

    // Dedicated tracks endpoint is more reliable than nested album.tracks paging
    const results: SpotifyCollectionTrack[] = [];
    let nextUrl: string | null =
      `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50&market=${encodeURIComponent(market)}`;

    while (nextUrl) {
      const res = await fetch(nextUrl, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Spotify album tracks API error ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
        );
      }
      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          name?: string;
          artists?: Array<{ name?: string }>;
          duration_ms?: number;
          external_urls?: { spotify?: string };
        } | null>;
        next?: string | null;
      };

      for (const item of data.items ?? []) {
        if (!item?.name) continue;
        results.push({
          title: item.name,
          artist:
            item.artists
              ?.map((a) => a?.name)
              .filter(Boolean)
              .join(', ') || undefined,
          durationSec:
            typeof item.duration_ms === 'number' ? Math.floor(item.duration_ms / 1000) : undefined,
          contextName,
          image: albumImage,
          spotifyUrl:
            item.external_urls?.spotify ||
            (item.id ? `https://open.spotify.com/track/${item.id}` : undefined),
        });
      }
      nextUrl = data.next ?? null;
    }

    return results;
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    headers: Record<string, string>,
    market: string,
  ): Promise<SpotifyCollectionTrack[]> {
    // Full playlist object first (name); avoid over-filtered fields that some apps reject
    const plRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}?market=${encodeURIComponent(market)}`,
      { headers },
    );
    if (!plRes.ok) {
      const body = await plRes.text().catch(() => '');
      if (plRes.status === 403 || plRes.status === 404) {
        throw new Error(
          `Spotify playlist API error ${plRes.status} — playlist must be **Public** ` +
            `(private/collaborative lists need user OAuth). ${body.slice(0, 120)}`,
        );
      }
      throw new Error(
        `Spotify playlist API error ${plRes.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
      );
    }
    const pl = (await plRes.json()) as {
      name?: string;
      tracks?: {
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
    };
    const plName = pl.name || undefined;

    const results: SpotifyCollectionTrack[] = [];
    const pushItems = (
      items: Array<{
        track?: {
          id?: string;
          name?: string;
          artists?: Array<{ name?: string }>;
          duration_ms?: number;
          external_urls?: { spotify?: string };
          album?: { images?: Array<{ url?: string }> };
        } | null;
      }>,
    ) => {
      for (const wrapper of items) {
        const t = wrapper?.track;
        if (!t?.name) continue;
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
    };

    // First page may already be embedded
    if (pl.tracks?.items?.length) {
      pushItems(pl.tracks.items);
    }

    let nextUrl: string | null =
      pl.tracks?.next ??
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&market=${encodeURIComponent(market)}`;

    // If we already took embedded page and next is set, continue; if we used fallback URL
    // and already pushed embedded items that match the first page, skip duplicate first fetch
    // when tracks.next was present we only continue from next.
    if (pl.tracks?.items?.length && pl.tracks.next) {
      nextUrl = pl.tracks.next;
    } else if (pl.tracks?.items?.length && !pl.tracks.next) {
      nextUrl = null;
    }

    while (nextUrl) {
      const res = await fetch(nextUrl, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 403 || res.status === 404) {
          throw new Error(
            `Spotify playlist tracks API error ${res.status} — list must be **Public**. ${body.slice(0, 120)}`,
          );
        }
        throw new Error(
          `Spotify playlist tracks API error ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
        );
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
      pushItems(data.items ?? []);
      nextUrl = data.next ?? null;
    }

    return results;
  }
}

/** Resolve spotify.link / short URLs to open.spotify.com so type detection works. */
async function expandSpotifyUrl(input: string): Promise<string> {
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    const needsExpand =
      u.hostname === 'spotify.link' ||
      u.hostname.endsWith('.spotify.link') ||
      u.hostname === 'spotify.app.link' ||
      (u.hostname.includes('spotify.com') && u.pathname.includes('/redirect'));
    if (!needsExpand && u.hostname.includes('spotify.com')) {
      return trimmed;
    }
    if (!needsExpand && !u.hostname.includes('spotify')) {
      return trimmed;
    }
  } catch {
    return trimmed;
  }

  try {
    const res = await fetch(trimmed, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(12_000),
    });
    // final URL after redirects
    if (res.url && res.url !== trimmed) {
      console.log(`[Spotify] expanded ${trimmed} → ${res.url}`);
      return res.url.split('?')[0] || res.url;
    }
  } catch (err) {
    console.warn('[Spotify] URL expand failed, using original:', err);
  }
  return trimmed;
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
