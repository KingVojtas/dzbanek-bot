import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        content: '🔇 Nothing is playing to skip.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const skipped = subscription.current;
    const next = subscription.skip();
    await interaction.reply(
      next
        ? `⏭️ Skipped **${skipped.title}**. Up next: **${next.title}**.`
        : `⏭️ Skipped **${skipped.title}**. The queue is now empty.`,
    );
  },
};
