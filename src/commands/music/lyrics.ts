import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command, Track } from '../../core/types';

interface LyricsResult {
  plain?: string;
  synced?: string;
  trackName?: string;
  artistName?: string;
}

/** Strip common YouTube junk from titles for better lyrics matching. */
function cleanTrackTitle(raw: string): string {
  return raw
    .replace(
      /\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|audio\s*only|visuali[sz]er|remaster(?:ed)?|music\s*video|\bHD\b|\b4K\b|\bMV\b)\b/gi,
      ' ',
    )
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQuery(query: string): { title: string; artist?: string } {
  const q = query.trim();
  // "Artist - Title" or "Artist – Title"
  const parts = q.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: cleanTrackTitle(parts.slice(1).join(' - ').trim()),
    };
  }
  return { title: cleanTrackTitle(q) };
}

function titleAndArtistFromTrack(track: Track): { title: string; artist?: string } {
  let title = track.title;
  let artist = track.uploader?.trim() || undefined;

  // Prefer uploader as artist; if title is "Artist - Song", split when uploader missing
  // or when title clearly encodes both.
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const maybeArtist = parts[0].trim();
    const maybeTitle = parts.slice(1).join(' - ').trim();
    if (!artist) {
      artist = maybeArtist;
      title = maybeTitle;
    } else if (normalize(maybeArtist) === normalize(artist) || maybeTitle.length > 2) {
      // Title starts with same artist or classic "Artist - Title" form
      title = maybeTitle;
    }
  }

  return { title: cleanTrackTitle(title), artist };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function fetchLyrics(
  title: string,
  artist: string | undefined,
  duration?: number,
): Promise<LyricsResult | null> {
  const params = new URLSearchParams();
  params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  if (duration && Number.isFinite(duration)) params.set('duration', String(Math.round(duration)));

  try {
    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: { 'User-Agent': 'dzbanek-bot/1.0 (https://github.com/example/dzbanek-bot)' },
    });
    if (!res.ok) {
      // fallback to search
      const q = encodeURIComponent(title + (artist ? ' ' + artist : ''));
      const searchRes = await fetch(`https://lrclib.net/api/search?q=${q}`);
      if (searchRes.ok) {
        const arr = (await searchRes.json()) as Array<Record<string, unknown>>;
        if (arr.length > 0) {
          const best = arr[0];
          return {
            plain: String(best.plainLyrics ?? ''),
            synced: String(best.syncedLyrics ?? ''),
            trackName: String(best.trackName ?? ''),
            artistName: String(best.artistName ?? ''),
          };
        }
      }
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      plain: String(json.plainLyrics ?? ''),
      synced: String(json.syncedLyrics ?? ''),
      trackName: String(json.trackName ?? ''),
      artistName: String(json.artistName ?? ''),
    };
  } catch {
    return null;
  }
}

export const lyrics: Command = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics for the current or specified track.')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song title or "artist - title"').setRequired(false),
    ),

  async execute(interaction, services) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const query = interaction.options.getString('query')?.trim() || '';
    const sub = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    const current = sub?.current;

    let title: string;
    let artist: string | undefined;
    let duration: number | undefined;

    if (query) {
      ({ title, artist } = parseQuery(query));
      duration = current?.durationSec;
    } else if (current) {
      ({ title, artist } = titleAndArtistFromTrack(current));
      duration = current.durationSec;
    } else {
      await interaction.editReply({
        embeds: [buildInfoEmbed('Provide a query or play a track first.')],
      });
      return;
    }

    if (!title) {
      await interaction.editReply({
        embeds: [buildInfoEmbed('Provide a query or play a track first.')],
      });
      return;
    }

    let result = await fetchLyrics(title, artist, duration);

    // Retry without artist if the first lookup missed (uploader often isn't the song artist).
    if ((!result || (!result.plain && !result.synced)) && artist) {
      result = await fetchLyrics(title, undefined, duration);
    }

    if (!result || (!result.plain && !result.synced)) {
      await interaction.editReply({
        embeds: [buildInfoEmbed(`No lyrics found for "${title}"${artist ? ` by ${artist}` : ''}.`)],
      });
      return;
    }

    const text = (result.synced || result.plain || '').slice(0, 3800);
    const header = result.trackName
      ? `${result.trackName} — ${result.artistName || ''}`.trim()
      : artist
        ? `${title} — ${artist}`
        : title;

    const embed = buildInfoEmbed(
      `${text}${result.synced ? '\n\n_(synced lyrics)_' : ''}`,
      `Lyrics for ${header}`,
    );

    await interaction.editReply({ embeds: [embed] });
  },
};
