import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        content: '🔇 Nothing is playing.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ok = subscription.pause();
    await interaction.reply(ok ? '⏸️ Paused.' : 'Already paused or could not pause.');
  },
};
