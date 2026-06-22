interface SpotifyTrackMetadata {
  title: string;
  artist?: string;
}

export class SpotifySource {
  canResolve(input: string): boolean {
    return isSpotifyUrl(input);
  }

  async resolveSearchQuery(input: string): Promise<string> {
    const metadata = await fetchSpotifyTrackMetadata(input);
    return spotifyMetadataToSearchQuery(metadata);
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
