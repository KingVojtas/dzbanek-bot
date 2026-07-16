import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed, buildTrackEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const playing: Command = {
  data: new SlashCommandBuilder()
    .setName('playing')
    .setDescription('Show the track that is currently playing.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Nothing is playing right now.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({ embeds: [buildTrackEmbed(subscription.current, '🎵 Now playing')] });
  },
};
