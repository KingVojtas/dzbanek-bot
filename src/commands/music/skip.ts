import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Nothing is playing to skip.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const skipped = subscription.current;
    const next = subscription.skip();

    if (services.stats && interaction.guildId) {
      await services.stats.recordSkip(interaction.guildId, interaction.user.id);
    }

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          next
            ? `⏭️ Skipped **${skipped.title}**. Up next: **${next.title}**.`
            : `⏭️ Skipped **${skipped.title}**. The queue is now empty.`,
        ),
      ],
    });
  },
};
