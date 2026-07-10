import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue by its position (1-based).')
    .addIntegerOption((opt) =>
      opt
        .setName('position')
        .setDescription('Position in queue (1 = next)')
        .setRequired(true)
        .setMinValue(1),
    ),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || subscription.queue.length === 0) {
      await interaction.reply({
        content: '📭 The queue is empty.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pos = interaction.options.getInteger('position', true);
    const idx = pos - 1; // 0-based
    const removed = subscription.remove(idx);
    if (!removed) {
      await interaction.reply({
        content: `❌ Invalid position ${pos}. Queue has ${subscription.queue.length} track(s).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply(`🗑️ Removed **${removed.title}** from position ${pos}.`);
  },
};
