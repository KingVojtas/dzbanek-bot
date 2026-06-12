import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueueEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || (!subscription.current && subscription.queue.length === 0)) {
      await interaction.reply({ content: '📭 The queue is empty.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      embeds: [buildQueueEmbed(subscription.current, subscription.queue)],
    });
  },
};
