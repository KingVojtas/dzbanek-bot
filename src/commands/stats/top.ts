import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const top: Command = {
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Show leaderboards.')
    .addStringOption((o) =>
      o
        .setName('metric')
        .setDescription('Metric to rank by')
        .setRequired(true)
        .addChoices(
          { name: 'plays', value: 'plays' },
          { name: 'duration', value: 'duration' },
          { name: 'skips', value: 'skips' },
          { name: 'tracks', value: 'tracks' },
        ),
    )
    .addIntegerOption((o) =>
      o.setName('limit').setDescription('Top N (default 10)').setMinValue(1).setMaxValue(20),
    ),

  async execute(interaction, services) {
    if (!services.stats || !interaction.guildId) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Stats not available.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const g = await services.stats.getGuild(interaction.guildId);
    if (!g) {
      await interaction.reply({
        embeds: [buildInfoEmbed('No stats yet.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const metric = interaction.options.getString('metric', true);
    const limit = interaction.options.getInteger('limit') ?? 10;

    if (metric === 'tracks') {
      // Use already-populated topTracks from the stats repo (TrackPlay data)
      const trackEntries = Object.entries(g.topTracks || {})
        .map(([key, t]) => ({ key, plays: t.plays, title: t.title }))
        .sort((a, b) => b.plays - a.plays)
        .slice(0, limit);

      if (trackEntries.length === 0) {
        await interaction.reply({
          embeds: [buildInfoEmbed('No track play data yet.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = trackEntries.map((t, i) => `${i + 1}. **${t.title}** — ${t.plays} plays`);
      await interaction.reply({
        embeds: [buildInfoEmbed(lines.join('\n'), 'Top tracks')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let entries: Array<[string, number]> = [];
    if (metric === 'plays') {
      entries = Object.entries(g.users).map(([id, s]) => [id, s.plays]);
    } else if (metric === 'duration') {
      entries = Object.entries(g.users).map(([id, s]) => [id, s.totalDurationSec]);
    } else if (metric === 'skips') {
      entries = Object.entries(g.users).map(([id, s]) => [id, s.skips]);
    }

    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, limit);

    if (!top.length) {
      await interaction.reply({
        embeds: [buildInfoEmbed('No data.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = top.map(([uid, val], i) => {
      const valStr = metric === 'duration' ? `${Math.round(val / 60)}m` : String(val);
      return `${i + 1}. <@${uid}> — ${valStr}`;
    });

    await interaction.reply({
      embeds: [buildInfoEmbed(lines.join('\n'), `Top ${metric}`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
