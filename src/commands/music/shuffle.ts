import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || subscription.queue.length < 2) {
      await interaction.reply({
        content: '🔇 Not enough tracks in queue to shuffle.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    subscription.shuffle();
    await interaction.reply('🔀 Queue shuffled.');
  },
};
