import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 I am not playing anything.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    subscription.stop();
    await interaction.reply({
      embeds: [buildInfoEmbed('⏹️ Stopped playback and left the voice channel.')],
    });
  },
};
