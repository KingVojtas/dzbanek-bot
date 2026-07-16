import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Cycle or set the loop mode (off / track / queue).')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Desired loop mode')
        .addChoices(
          { name: 'off', value: 'off' },
          { name: 'track', value: 'track' },
          { name: 'queue', value: 'queue' },
        ),
    ),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 No active music session.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requested = interaction.options.getString('mode') as 'off' | 'track' | 'queue' | null;
    if (requested) {
      subscription.setLoopMode(requested);
    } else {
      // cycle
      const modes: ('off' | 'track' | 'queue')[] = ['off', 'track', 'queue'];
      const idx = modes.indexOf(subscription.loopMode);
      const next = modes[(idx + 1) % modes.length];
      subscription.setLoopMode(next);
    }

    await interaction.reply({
      embeds: [buildInfoEmbed(`🔁 Loop mode: **${subscription.loopMode}**`)],
    });
  },
};
