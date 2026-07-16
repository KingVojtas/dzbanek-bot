import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Nothing is playing.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ok = subscription.pause();
    await interaction.reply({
      embeds: [buildInfoEmbed(ok ? '⏸️ Paused.' : 'Already paused or could not pause.')],
    });
  },
};
