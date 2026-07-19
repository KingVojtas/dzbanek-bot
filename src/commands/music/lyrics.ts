import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command, Track } from '../../core/types';

interface LyricsResult {
  plain?: string;
  synced?: string;
  trackName?: string;
  artistName?: string;
  source?: string;
}

const UA = 'dzbanek-bot/1.0 (discord music; lyrics)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Strip common YouTube junk from titles for better lyrics matching. */
function cleanTrackTitle(raw: string): string {
  return raw
    .replace(
      /\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|audio\s*only|visuali[sz]er|remaster(?:ed)?|music\s*video|\bHD\b|\b4K\b|\bMV\b|prod\.?\s*by|ft\.?|feat\.?)\b/gi,
      ' ',
    )
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    .replace(/["“”']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQuery(query: string): { title: string; artist?: string } {
  const q = query.trim();
  const parts = q.split(/\s+[-–—|]\s+/);
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: cleanTrackTitle(parts.slice(1).join(' - ').trim()),
    };
  }
  return { title: cleanTrackTitle(q) };
}

/**
 * Build several (title, artist?) guesses from free-form text like "wtf yzomandias".
 */
function queryCandidates(query: string): Array<{ title: string; artist?: string }> {
  const parsed = parseQuery(query);
  const out: Array<{ title: string; artist?: string }> = [parsed];

  const words = cleanTrackTitle(query).split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !parsed.artist) {
    out.push({
      title: words.slice(0, -1).join(' '),
      artist: words[words.length - 1],
    });
    out.push({
      title: words.slice(1).join(' '),
      artist: words[0],
    });
    out.push({ title: words.join(' ') });
  }

  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${normalize(c.title)}|${normalize(c.artist ?? '')}`;
    if (!c.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function titleAndArtistFromTrack(track: Track): { title: string; artist?: string } {
  let title = track.title;
  let artist = track.uploader?.trim() || undefined;

  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const maybeArtist = parts[0].trim();
    const maybeTitle = parts.slice(1).join(' - ').trim();
    if (!artist) {
      artist = maybeArtist;
      title = maybeTitle;
    } else if (normalize(maybeArtist) === normalize(artist) || maybeTitle.length > 2) {
      title = maybeTitle;
    }
  }

  if (artist) {
    artist = artist
      .replace(/\s*[-–—]\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .trim();
  }

  return { title: cleanTrackTitle(title), artist };
}

function scoreHit(
  hit: { trackName?: string; artistName?: string },
  title: string,
  artist?: string,
): number {
  const ht = normalize(hit.trackName ?? '');
  const ha = normalize(hit.artistName ?? '');
  const t = normalize(title);
  const a = artist ? normalize(artist) : '';
  let score = 0;
  if (ht === t) score += 8;
  else if (ht.includes(t) || t.includes(ht)) score += 4;
  else {
    const tw = new Set(t.split(' '));
    score += ht.split(' ').filter((w) => tw.has(w)).length;
  }
  if (a) {
    if (ha === a) score += 6;
    else if (ha.includes(a) || a.includes(ha)) score += 3;
  }
  return score;
}

async function fetchJson(
  url: string,
  opts?: { retries?: number; timeoutMs?: number; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const retries = opts?.retries ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  let lastStatus = 0;
  let lastJson: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          ...opts?.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;
      const text = await res.text();
      try {
        lastJson = text ? JSON.parse(text) : null;
      } catch {
        lastJson = null;
      }
      if ((res.status === 503 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { ok: res.ok, status: res.status, json: lastJson };
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
    }
  }
  return { ok: false, status: lastStatus, json: lastJson };
}

function pickLyricsFields(row: Record<string, unknown>, source: string): LyricsResult | null {
  const plain = String(row.plainLyrics ?? row.lyrics ?? '').trim();
  const synced = String(row.syncedLyrics ?? '').trim();
  if (!plain && !synced) return null;
  return {
    plain: plain || undefined,
    synced: synced || undefined,
    trackName: row.trackName ? String(row.trackName) : row.name ? String(row.name) : undefined,
    artistName: row.artistName ? String(row.artistName) : undefined,
    source,
  };
}

/** LRCLib: exact get + ranked search (fast path for popular songs). */
async function fetchFromLrclib(
  title: string,
  artist: string | undefined,
  duration?: number,
): Promise<LyricsResult | null> {
  const params = new URLSearchParams();
  params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (duration && duration > 0) params.set('duration', String(Math.round(duration)));

  const got = await fetchJson(`https://lrclib.net/api/get?${params}`, {
    retries: 1,
    timeoutMs: 6_000,
  });
  if (got.ok && got.json && typeof got.json === 'object') {
    const hit = pickLyricsFields(got.json as Record<string, unknown>, 'lrclib');
    if (hit) return hit;
  }

  // Drop duration and retry get (wrong duration → false 404)
  if (duration && duration > 0) {
    const p2 = new URLSearchParams();
    p2.set('track_name', title);
    if (artist) p2.set('artist_name', artist);
    const got2 = await fetchJson(`https://lrclib.net/api/get?${p2}`, {
      retries: 1,
      timeoutMs: 6_000,
    });
    if (got2.ok && got2.json && typeof got2.json === 'object') {
      const hit = pickLyricsFields(got2.json as Record<string, unknown>, 'lrclib');
      if (hit) return hit;
    }
  }

  const searchParams = new URLSearchParams();
  searchParams.set('track_name', title);
  if (artist) searchParams.set('artist_name', artist);
  const search = await fetchJson(`https://lrclib.net/api/search?${searchParams}`, {
    retries: 1,
    timeoutMs: 6_000,
  });
  if (search.ok && Array.isArray(search.json)) {
    const rows = search.json as Array<Record<string, unknown>>;
    const ranked = rows
      .map((row) => ({
        row,
        score: scoreHit(
          { trackName: String(row.trackName ?? ''), artistName: String(row.artistName ?? '') },
          title,
          artist,
        ),
      }))
      .sort((a, b) => b.score - a.score);
    for (const { row, score } of ranked) {
      if (score < 2 && rows.length > 1) continue;
      const hit = pickLyricsFields(row, 'lrclib');
      if (hit) return hit;
    }
  }

  const q = [title, artist].filter(Boolean).join(' ');
  const free = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
    retries: 1,
    timeoutMs: 6_000,
  });
  if (free.ok && Array.isArray(free.json)) {
    for (const row of free.json as Array<Record<string, unknown>>) {
      const hit = pickLyricsFields(row, 'lrclib');
      if (hit) return hit;
    }
  }

  return null;
}

/** lyrics.ovh suggest + v1. */
async function fetchFromLyricsOvh(
  title: string,
  artist: string | undefined,
): Promise<LyricsResult | null> {
  const q = [title, artist].filter(Boolean).join(' ');
  let resolvedTitle = title;
  let resolvedArtist = artist;

  const suggest = await fetchJson(`https://api.lyrics.ovh/suggest/${encodeURIComponent(q)}`, {
    retries: 0,
    timeoutMs: 6_000,
  });
  if (suggest.ok && suggest.json && typeof suggest.json === 'object') {
    const data = (suggest.json as { data?: Array<Record<string, unknown>> }).data ?? [];
    const ranked = data
      .map((row) => {
        const t = String(row.title ?? '');
        const a =
          typeof row.artist === 'object' && row.artist
            ? String((row.artist as { name?: string }).name ?? '')
            : '';
        return {
          title: t,
          artist: a,
          score: scoreHit({ trackName: t, artistName: a }, title, artist),
        };
      })
      .sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 2) {
      resolvedTitle = ranked[0].title;
      resolvedArtist = ranked[0].artist || resolvedArtist;
    }
  }

  if (!resolvedArtist) return null;

  const lyricsRes = await fetchJson(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(resolvedArtist)}/${encodeURIComponent(resolvedTitle)}`,
    { retries: 0, timeoutMs: 8_000 },
  );
  if (!lyricsRes.ok || !lyricsRes.json || typeof lyricsRes.json !== 'object') return null;
  const lyrics = String((lyricsRes.json as { lyrics?: string }).lyrics ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!lyrics || /not found/i.test(lyrics)) return null;

  return {
    plain: lyrics,
    trackName: resolvedTitle,
    artistName: resolvedArtist,
    source: 'lyrics.ovh',
  };
}

function htmlToLyricsText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/?(a|span|i|b|em|strong|div)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Genius search + page scrape — works for Czech / underground tracks missing from LRCLib.
 * Uses public Genius web API (no token) + lyrics containers on the song page.
 */
async function fetchFromGenius(
  title: string,
  artist: string | undefined,
): Promise<LyricsResult | null> {
  const q = [artist, title].filter(Boolean).join(' ').trim() || title;
  const search = await fetchJson(`https://genius.com/api/search?q=${encodeURIComponent(q)}`, {
    retries: 1,
    timeoutMs: 10_000,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!search.ok || !search.json || typeof search.json !== 'object') return null;

  const hits =
    (
      search.json as {
        response?: { hits?: Array<{ type?: string; result?: Record<string, unknown> }> };
      }
    ).response?.hits ?? [];

  const ranked = hits
    .filter((h) => h.type === 'song' && h.result)
    .map((h) => {
      const r = h.result!;
      const trackName = String(r.title ?? r.title_with_featured ?? '');
      const artistName = String(r.artist_names ?? '');
      return {
        trackName,
        artistName,
        url: String(r.url ?? ''),
        score: scoreHit({ trackName, artistName }, title, artist),
      };
    })
    .filter((h) => h.url && h.score >= 2)
    .sort((a, b) => b.score - a.score);

  // If scoring is strict for short titles like "WTF", relax for top hit with artist match
  let pick = ranked[0];
  if (!pick && hits[0]?.result) {
    const r = hits[0].result;
    const trackName = String(r.title ?? '');
    const artistName = String(r.artist_names ?? '');
    const url = String(r.url ?? '');
    if (url && (!artist || normalize(artistName).includes(normalize(artist)))) {
      pick = {
        trackName,
        artistName,
        url,
        score: 2,
      };
    }
  }
  if (!pick?.url) return null;

  try {
    const page = await fetch(pick.url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!page.ok) return null;
    const html = await page.text();

    const re = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi;
    const chunks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) chunks.push(m[1]);
    if (chunks.length === 0) return null;

    let text = htmlToLyricsText(chunks.join('\n'));
    // Drop "12 ContributorsSong Name Lyrics" header noise
    text = text
      .replace(/^\d+\s*Contributors.*?(Lyrics)\s*/i, '')
      .replace(/^.*?Lyrics\s*\n+/i, '')
      .trim();
    if (text.length < 40) return null;

    return {
      plain: text,
      trackName: pick.trackName,
      artistName: pick.artistName,
      source: 'genius',
    };
  } catch {
    return null;
  }
}

/**
 * Race providers; return first good hit.
 * Genius is critical for CZ rap / tracks missing from LRCLib.
 */
/** Shared by `/lyrics` and the player Lyrics button. */
export async function fetchLyrics(
  title: string,
  artist: string | undefined,
  duration?: number,
): Promise<LyricsResult | null> {
  const providers = [
    fetchFromLrclib(title, artist, duration),
    fetchFromGenius(title, artist),
    fetchFromLyricsOvh(title, artist),
  ];

  // Prefer first success without waiting for all (Promise.any with filter)
  return await new Promise((resolve) => {
    let pending = providers.length;
    let settled = false;
    for (const p of providers) {
      void p.then(
        (hit) => {
          if (settled) return;
          if (hit && (hit.plain || hit.synced)) {
            settled = true;
            resolve(hit);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(null);
        },
        () => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) resolve(null);
        },
      );
    }
  });
}

export const lyrics: Command = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics for the current or specified track.')
    .addStringOption((o) =>
      o
        .setName('query')
        .setDescription('Song title, or "artist - title" (e.g. Yzomandias - WTF)')
        .setRequired(false),
    ),

  async execute(interaction, services) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const query = interaction.options.getString('query')?.trim() || '';
    const sub = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    const current = sub?.current;

    let duration: number | undefined;
    let rawCandidates: Array<{ title: string; artist?: string }>;

    if (query) {
      rawCandidates = queryCandidates(query);
      if (current) {
        const cur = titleAndArtistFromTrack(current);
        const qn = normalize(query);
        const cn = normalize(`${cur.artist ?? ''} ${cur.title}`);
        if (qn && cn && (cn.includes(qn) || qn.includes(normalize(cur.title)))) {
          duration = current.durationSec > 0 ? current.durationSec : undefined;
        }
      }
    } else if (current) {
      const fromTrack = titleAndArtistFromTrack(current);
      rawCandidates = [fromTrack];
      if (current.title && cleanTrackTitle(current.title) !== fromTrack.title) {
        rawCandidates.push(...queryCandidates(current.title));
      }
      // Always include artist-from-uploader + cleaned title for Topic channels
      if (fromTrack.artist && fromTrack.title) {
        rawCandidates.unshift({ title: fromTrack.title, artist: fromTrack.artist });
      }
      duration = current.durationSec > 0 ? current.durationSec : undefined;
    } else {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            'Provide a song name or play a track first.\nTip: `/lyrics query: Artist - Title`',
          ),
        ],
      });
      return;
    }

    const seen = new Set<string>();
    const candidates = rawCandidates.filter((c) => {
      const key = `${normalize(c.title)}|${normalize(c.artist ?? '')}`;
      if (!c.title || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Race top candidates (not all sequentially) for speed
    const top = candidates.slice(0, 3);
    const results = await Promise.all(top.map((c) => fetchLyrics(c.title, c.artist, duration)));
    let result = results.find((r) => r && (r.plain || r.synced)) ?? null;
    let triedLabel = top[0]
      ? top[0].artist
        ? `${top[0].title} — ${top[0].artist}`
        : top[0].title
      : query;

    // Fall through remaining candidates only if needed
    if (!result) {
      for (const c of candidates.slice(3)) {
        triedLabel = c.artist ? `${c.title} — ${c.artist}` : c.title;
        result = await fetchLyrics(c.title, c.artist, duration);
        if (result && (result.plain || result.synced)) break;
      }
    } else {
      const idx = results.findIndex((r) => r && (r.plain || r.synced));
      const c = top[idx] ?? top[0];
      if (c) triedLabel = c.artist ? `${c.title} — ${c.artist}` : c.title;
    }

    if (!result || (!result.plain && !result.synced)) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `No lyrics found for **${triedLabel}**.\n\n` +
              `• Try \`/lyrics query: Artist - Title\` (example: \`Yzomandias - WTF\`)\n` +
              `• Or run \`/lyrics\` while the song is playing\n` +
              `• Some tracks still have no public lyrics online`,
            'Lyrics not found',
          ),
        ],
      });
      return;
    }

    const body = (result.plain || result.synced || '').trim();
    const text = (
      result.plain
        ? body
        : body
            .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    ).slice(0, 3800);

    const header = result.trackName
      ? `${result.trackName}${result.artistName ? ` — ${result.artistName}` : ''}`
      : triedLabel;

    const embed = buildInfoEmbed(text, `Lyrics · ${header}`);
    if (result.source) embed.setFooter({ text: `via ${result.source}` });

    await interaction.editReply({ embeds: [embed] });
  },
};

/** Resolve lyrics for a playing track (player button). */
export async function resolveLyricsForTrack(
  track: Track,
): Promise<{ text: string; header: string; source?: string } | null> {
  const fromTrack = titleAndArtistFromTrack(track);
  const rawCandidates: Array<{ title: string; artist?: string }> = [fromTrack];
  if (track.title && cleanTrackTitle(track.title) !== fromTrack.title) {
    rawCandidates.push(...queryCandidates(track.title));
  }
  if (fromTrack.artist && fromTrack.title) {
    rawCandidates.unshift({ title: fromTrack.title, artist: fromTrack.artist });
  }
  const duration = track.durationSec > 0 ? track.durationSec : undefined;

  const seen = new Set<string>();
  const candidates = rawCandidates.filter((c) => {
    const key = `${normalize(c.title)}|${normalize(c.artist ?? '')}`;
    if (!c.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const top = candidates.slice(0, 3);
  const results = await Promise.all(top.map((c) => fetchLyrics(c.title, c.artist, duration)));
  let result = results.find((r) => r && (r.plain || r.synced)) ?? null;
  let triedLabel = top[0]
    ? top[0].artist
      ? `${top[0].title} — ${top[0].artist}`
      : top[0].title
    : track.title;

  if (!result) {
    for (const c of candidates.slice(3)) {
      triedLabel = c.artist ? `${c.title} — ${c.artist}` : c.title;
      result = await fetchLyrics(c.title, c.artist, duration);
      if (result && (result.plain || result.synced)) break;
    }
  } else {
    const idx = results.findIndex((r) => r && (r.plain || r.synced));
    const c = top[idx] ?? top[0];
    if (c) triedLabel = c.artist ? `${c.title} — ${c.artist}` : c.title;
  }

  if (!result || (!result.plain && !result.synced)) return null;

  const body = (result.plain || result.synced || '').trim();
  const text = (
    result.plain
      ? body
      : body
          .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
  ).slice(0, 3800);

  const header = result.trackName
    ? `${result.trackName}${result.artistName ? ` — ${result.artistName}` : ''}`
    : triedLabel;

  return { text, header, source: result.source };
}
