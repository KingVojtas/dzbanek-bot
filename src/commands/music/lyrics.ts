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

/** Strip common YouTube junk from titles for better lyrics matching. */
function cleanTrackTitle(raw: string): string {
  return raw
    .replace(
      /\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|audio\s*only|visuali[sz]er|remaster(?:ed)?|music\s*video|\bHD\b|\b4K\b|\bMV\b|prod\.?\s*by|ft\.?|feat\.?)\b/gi,
      ' ',
    )
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    .replace(/["“”]/g, ' ')
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
  // "Artist - Title" or "Artist – Title"
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
 * LRCLib / lyrics.ovh match much better with artist + title separated.
 */
function queryCandidates(query: string): Array<{ title: string; artist?: string }> {
  const parsed = parseQuery(query);
  const out: Array<{ title: string; artist?: string }> = [parsed];

  const words = cleanTrackTitle(query).split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !parsed.artist) {
    // "title artist"  (last token = artist)  e.g. "wtf yzomandias"
    out.push({
      title: words.slice(0, -1).join(' '),
      artist: words[words.length - 1],
    });
    // "artist title"  (first token = artist)
    out.push({
      title: words.slice(1).join(' '),
      artist: words[0],
    });
    // full string as title, no artist
    out.push({ title: words.join(' ') });
  }

  // de-dupe
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${normalize(c.title)}|${normalize(c.artist ?? '')}`;
    if (!c.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function titleAndArtistFromTrack(track: Track): { title: string; artist?: string } {
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

  // Topic / VEVO channels: "Artist - Topic"
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
    // token overlap
    const tw = new Set(t.split(' '));
    const hw = ht.split(' ');
    score += hw.filter((w) => tw.has(w)).length;
  }
  if (a) {
    if (ha === a) score += 6;
    else if (ha.includes(a) || a.includes(ha)) score += 3;
  }
  return score;
}

async function fetchJson(
  url: string,
  opts?: { retries?: number; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const retries = opts?.retries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  let lastStatus = 0;
  let lastJson: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;
      const text = await res.text();
      try {
        lastJson = text ? JSON.parse(text) : null;
      } catch {
        lastJson = null;
      }
      // Retry transient LRCLib overload
      if ((res.status === 503 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1) + Math.random() * 300));
        continue;
      }
      return { ok: res.ok, status: res.status, json: lastJson };
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
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

/** LRCLib: exact get, then ranked search. */
async function fetchFromLrclib(
  title: string,
  artist: string | undefined,
  duration?: number,
): Promise<LyricsResult | null> {
  // 1) Exact get (no duration first — wrong duration causes false 404s)
  {
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    const got = await fetchJson(`https://lrclib.net/api/get?${params}`, { retries: 3 });
    if (got.ok && got.json && typeof got.json === 'object') {
      const hit = pickLyricsFields(got.json as Record<string, unknown>, 'lrclib');
      if (hit) return hit;
    }
  }

  // 2) Get with duration (helps when multiple versions exist)
  if (duration && duration > 0) {
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    params.set('duration', String(Math.round(duration)));
    const got = await fetchJson(`https://lrclib.net/api/get?${params}`, { retries: 2 });
    if (got.ok && got.json && typeof got.json === 'object') {
      const hit = pickLyricsFields(got.json as Record<string, unknown>, 'lrclib');
      if (hit) return hit;
    }
  }

  // 3) Structured search
  {
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    const search = await fetchJson(`https://lrclib.net/api/search?${params}`, { retries: 3 });
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
  }

  // 4) Free-text search
  {
    const q = [title, artist].filter(Boolean).join(' ');
    const search = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      retries: 3,
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
      for (const { row } of ranked) {
        const hit = pickLyricsFields(row, 'lrclib');
        if (hit) return hit;
      }
    }
  }

  return null;
}

/** lyrics.ovh: suggest → v1 lyrics. */
async function fetchFromLyricsOvh(
  title: string,
  artist: string | undefined,
): Promise<LyricsResult | null> {
  const q = [title, artist].filter(Boolean).join(' ');
  let resolvedTitle = title;
  let resolvedArtist = artist;

  // Suggest improves free-form queries ("wtf yzomandias" → Yzomandias / WTF)
  const suggest = await fetchJson(`https://api.lyrics.ovh/suggest/${encodeURIComponent(q)}`, {
    retries: 1,
    timeoutMs: 10_000,
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
    { retries: 1, timeoutMs: 12_000 },
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

async function fetchLyrics(
  title: string,
  artist: string | undefined,
  duration?: number,
): Promise<LyricsResult | null> {
  // Try LRCLib first (synced + plain), then lyrics.ovh.
  const lrclib = await fetchFromLrclib(title, artist, duration);
  if (lrclib) return lrclib;

  const ovh = await fetchFromLyricsOvh(title, artist);
  if (ovh) return ovh;

  return null;
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
      // Only use playing track duration when query looks like the same song
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
      // Also try full raw title in case clean-up over-stripped
      if (current.title && cleanTrackTitle(current.title) !== fromTrack.title) {
        rawCandidates.push(...queryCandidates(current.title));
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

    // Deduplicate candidates after track expansion
    const seen = new Set<string>();
    const candidates = rawCandidates.filter((c) => {
      const key = `${normalize(c.title)}|${normalize(c.artist ?? '')}`;
      if (!c.title || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let result: LyricsResult | null = null;
    let triedLabel = candidates[0]?.title ?? query;

    for (const c of candidates) {
      triedLabel = c.artist ? `${c.title} — ${c.artist}` : c.title;
      result = await fetchLyrics(c.title, c.artist, duration);
      if (result && (result.plain || result.synced)) break;
      // If first attempt had artist, also try title-only once inside candidate list
    }

    if (!result || (!result.plain && !result.synced)) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `No lyrics found for **${triedLabel}**.\n\n` +
              `• Try \`/lyrics query: Artist - Title\` (example: \`Yzomandias - WTF\`)\n` +
              `• Many Czech/underground tracks aren’t in free lyric databases yet\n` +
              `• Popular international songs work best`,
            'Lyrics not found',
          ),
        ],
      });
      return;
    }

    // Prefer plain for reading; synced is dense with timestamps
    const body = (result.plain || result.synced || '').trim();
    // Strip LRC timestamps if we only have synced
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

    const footerBits = [result.source ? `via ${result.source}` : null].filter(Boolean);

    const embed = buildInfoEmbed(text, `Lyrics · ${header}`);
    if (footerBits.length) embed.setFooter({ text: footerBits.join(' · ') });

    await interaction.editReply({ embeds: [embed] });
  },
};
