import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueuePageRow } from '../../core/display';
import { buildInfoEmbed, buildQueueEmbed, queueTotalPages } from '../../core/embeds';
import type { Command } from '../../core/types';

export const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || (!subscription.current && subscription.queue.length === 0)) {
      await interaction.reply({
        embeds: [buildInfoEmbed('📭 The queue is empty.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const page = 0;
    const totalPages = queueTotalPages(subscription.queue.length);
    const components =
      totalPages > 1 || subscription.queue.length > 0
        ? [buildQueuePageRow(page, subscription.queue.length)]
        : [];

    await interaction.reply({
      embeds: [buildQueueEmbed(subscription.current, subscription.queue, page)],
      components,
    });
  },
};
