import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed, buildRankEmbed } from '../../core/embeds';
import { progressBar } from '../../leveling/formulas';
import type { Command } from '../../core/types';

export const rank: Command = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your (or another member’s) XP level and progress.')
    .addUserOption((o) =>
      o.setName('user').setDescription('Member to check (default: you)').setRequired(false),
    ),

  async execute(interaction, services) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Rank is only available in servers.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!services.leveling) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Leveling is not available.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const settings = await services.leveling.getSettings(interaction.guildId);
    if (!settings.enabled) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Leveling is **disabled** in this server. An admin can enable it in the web dashboard.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = interaction.options.getUser('user') ?? interaction.user;
    const row = await services.leveling.getMember(interaction.guildId, target.id);
    const progress = services.leveling.progress(row.xp);
    const rankPos = await services.leveling.getRank(interaction.guildId, row.xp);
    const bar = progressBar(progress.intoLevel, progress.need, 10);

    await interaction.reply({
      embeds: [
        buildRankEmbed({
          displayName: target.globalName || target.username,
          avatarUrl: target.displayAvatarURL({ size: 256 }),
          level: progress.level,
          rank: rankPos,
          totalXp: row.xp,
          intoLevel: progress.intoLevel,
          need: progress.need,
          bar,
        }),
      ],
    });
  },
};
