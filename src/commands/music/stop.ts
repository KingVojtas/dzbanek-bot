import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription) {
      await interaction.reply({
        content: '🔇 I am not playing anything.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    subscription.stop();
    await interaction.reply('⏹️ Stopped playback and left the voice channel.');
  },
};
