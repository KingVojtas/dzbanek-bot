import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed, buildLeaderboardEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const leaderboard: Command = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 members by XP in this server.'),

  async execute(interaction, services) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Leaderboard is only available in servers.')],
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

    // Defer before any DB so we never hit Discord's 3s reply limit.
    await interaction.deferReply();

    const settings = await services.leveling.getSettings(interaction.guildId);
    if (!settings.enabled) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            'Leveling is **disabled** in this server. An admin can enable it in the web dashboard.',
          ),
        ],
      });
      return;
    }

    const top = await services.leveling.getTop(interaction.guildId, 10);
    const entries = await Promise.all(
      top.map(async (row, i) => {
        let label = `<@${row.userId}>`;
        try {
          const member =
            interaction.guild!.members.cache.get(row.userId) ??
            (await interaction.guild!.members.fetch(row.userId).catch(() => null));
          if (member) {
            label = member.displayName;
          } else {
            const user = await interaction.client.users.fetch(row.userId).catch(() => null);
            if (user) label = user.globalName || user.username;
          }
        } catch {
          // keep mention fallback
        }
        return {
          place: i + 1,
          label,
          level: row.level,
          xp: row.xp,
        };
      }),
    );

    const self = await services.leveling.getMember(interaction.guildId, interaction.user.id);
    const invokerRank =
      self.xp > 0 || top.some((t) => t.userId === interaction.user.id)
        ? await services.leveling.getRank(interaction.guildId, self.xp)
        : null;

    await interaction.editReply({
      embeds: [buildLeaderboardEmbed(interaction.guild.name, entries, invokerRank)],
    });
  },
};
