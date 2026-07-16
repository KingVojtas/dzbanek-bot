import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume the paused track.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Nothing is playing.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ok = subscription.resume();
    await interaction.reply({
      embeds: [buildInfoEmbed(ok ? '▶️ Resumed.' : 'Not paused or could not resume.')],
    });
  },
};
