import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueueManageRows, buildQueuePageRow } from '../../core/display';
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
    const components = [];
    if (totalPages > 1 || subscription.queue.length > 0) {
      components.push(buildQueuePageRow(page, subscription.queue.length));
    }
    if (subscription.queue.length > 0) {
      components.push(...buildQueueManageRows(page, subscription.queue));
    }

    await interaction.reply({
      embeds: [buildQueueEmbed(subscription.current, subscription.queue, page)],
      components,
    });
  },
};
