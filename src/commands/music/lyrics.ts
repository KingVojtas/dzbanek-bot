import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

interface LyricsResult {
  plain?: string;
  synced?: string;
  trackName?: string;
  artistName?: string;
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

    let title = interaction.options.getString('query') || '';
    let artist: string | undefined;

    const sub = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    const current = sub?.current;

    if (!title && current) {
      title = current.title;
      // crude artist split if "Artist - Title"
      const parts = title.split(' - ');
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
    }

    if (!title) {
      await interaction.editReply('Provide a query or play a track first.');
      return;
    }

    const result = await fetchLyrics(title, artist, current?.durationSec);

    if (!result || (!result.plain && !result.synced)) {
      await interaction.editReply(`No lyrics found for "${title}".`);
      return;
    }

    const text = (result.synced || result.plain || '').slice(0, 1800);
    const header = result.trackName
      ? `${result.trackName} — ${result.artistName || ''}`.trim()
      : title;

    await interaction.editReply({
      content: `**Lyrics for ${header}**\n\n${text}${result.synced ? '\n_(synced lyrics)_' : ''}`,
    });
  },
};
