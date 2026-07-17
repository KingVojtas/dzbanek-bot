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
      if (/403/.test(detail)) {
        throw new Error(
          'Spotify blocked that collection request (HTTP 403). ' +
            'Playlists are loaded via Spotify’s public embed (API track lists are often forbidden even when the playlist is Public). ' +
            'If this keeps failing, try an **album** URL or individual track links. ' +
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
    // Strip optional surrounding quotes (common when pasting into Railway UI)
    const clean = (v: string | undefined) =>
      v
        ?.trim()
        .replace(/^['"]|['"]$/g, '')
        .trim() || '';
    const clientId = clean(process.env.SPOTIFY_CLIENT_ID);
    const clientSecret = clean(process.env.SPOTIFY_CLIENT_SECRET);
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
    // Playlist metadata still works with client credentials; the /tracks listing
    // endpoint is widely 403 as of 2026 even for public playlists.
    const plRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}?market=${encodeURIComponent(market)}`,
      { headers },
    );
    if (!plRes.ok) {
      const body = await plRes.text().catch(() => '');
      throw new Error(
        `Spotify playlist API error ${plRes.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
      );
    }
    const pl = (await plRes.json()) as {
      name?: string;
      images?: Array<{ url?: string }>;
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
    const plImage = pl.images?.[0]?.url;

    const results: SpotifyCollectionTrack[] = [];

    // Rare case: Spotify still embeds a first page of tracks on the playlist object
    for (const wrapper of pl.tracks?.items ?? []) {
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
        image: t.album?.images?.[0]?.url || plImage,
        spotifyUrl:
          t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
      });
    }

    // If we got a full first page and there is no next, we're done
    if (results.length > 0 && !pl.tracks?.next) {
      return results;
    }

    // Primary path (2026): scrape track IDs from the public embed page, then
    // hydrate each via GET /v1/tracks/{id} (batch ids= is 403; singles work).
    const trackIds = await scrapePlaylistTrackIds(playlistId);
    if (trackIds.length === 0 && results.length === 0) {
      throw new Error(
        'Could not read tracks from that Spotify playlist (API blocked track listing). ' +
          'Try an **album** URL, or paste individual track links.',
      );
    }

    // Avoid re-fetching tracks we already have from the playlist object
    const have = new Set(
      results
        .map((r) => r.spotifyUrl?.match(/track\/([a-zA-Z0-9]{22})/)?.[1])
        .filter(Boolean) as string[],
    );
    const missing = trackIds.filter((id) => !have.has(id));

    const hydrated = await mapPool(missing, 6, async (trackId) => {
      try {
        return await this.fetchTrackById(trackId, headers, market, plName);
      } catch (err) {
        console.warn(`[Spotify] track hydrate failed ${trackId}:`, err);
        return null;
      }
    });

    for (const t of hydrated) {
      if (t) results.push(t);
    }

    // Preserve playlist order from scraped IDs when possible
    const byId = new Map<string, SpotifyCollectionTrack>();
    for (const t of results) {
      const id = t.spotifyUrl?.match(/track\/([a-zA-Z0-9]{22})/)?.[1];
      if (id) byId.set(id, t);
    }
    const ordered: SpotifyCollectionTrack[] = [];
    for (const id of trackIds) {
      const t = byId.get(id);
      if (t) ordered.push(t);
    }
    // Append any leftovers
    for (const t of results) {
      if (!ordered.includes(t)) ordered.push(t);
    }

    console.log(
      `[Spotify] playlist ${playlistId}: ${ordered.length} track(s) via embed+hydrate` +
        (plName ? ` (“${plName}”)` : ''),
    );
    return ordered;
  }

  private async fetchTrackById(
    trackId: string,
    headers: Record<string, string>,
    market: string,
    contextName?: string,
  ): Promise<SpotifyCollectionTrack | null> {
    const res = await fetch(
      `https://api.spotify.com/v1/tracks/${trackId}?market=${encodeURIComponent(market)}`,
      { headers },
    );
    if (!res.ok) return null;
    const t = (await res.json()) as {
      id?: string;
      name?: string;
      artists?: Array<{ name?: string }>;
      duration_ms?: number;
      external_urls?: { spotify?: string };
      album?: { name?: string; images?: Array<{ url?: string }> };
    };
    if (!t.name) return null;
    return {
      title: t.name,
      artist:
        t.artists
          ?.map((a) => a?.name)
          .filter(Boolean)
          .join(', ') || undefined,
      durationSec: typeof t.duration_ms === 'number' ? Math.floor(t.duration_ms / 1000) : undefined,
      contextName: contextName || t.album?.name,
      image: t.album?.images?.[0]?.url,
      spotifyUrl: t.external_urls?.spotify || `https://open.spotify.com/track/${trackId}`,
    };
  }
}

/**
 * Spotify blocked GET /playlists/{id}/tracks (403) for many apps in 2026.
 * The public embed page still embeds `spotify:track:…` IDs we can scrape.
 */
async function scrapePlaylistTrackIds(playlistId: string): Promise<string[]> {
  const urls = [
    `https://open.spotify.com/embed/playlist/${playlistId}`,
    `https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator`,
  ];
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const m of html.matchAll(/spotify:track:([A-Za-z0-9]{22})/g)) {
        const id = m[1];
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (ids.length > 0) {
        console.log(`[Spotify] scraped ${ids.length} track id(s) from embed`);
        return ids;
      }
    } catch (err) {
      console.warn('[Spotify] embed scrape failed:', err);
    }
  }
  return ids;
}

/** Simple concurrency pool (local to this module). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
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
