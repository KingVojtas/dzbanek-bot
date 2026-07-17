import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildMusicPlayerDisplay } from '../../core/display';
import { buildInfoEmbed } from '../../core/embeds';
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

    const display = buildMusicPlayerDisplay({
      track: subscription.current,
      positionSec: subscription.getPlaybackPositionSec(),
      queueLength: subscription.queue.length,
      paused: subscription.paused,
      loopMode: subscription.loopMode,
      label: subscription.paused ? 'Paused' : 'Now Playing',
    });

    await interaction.reply({
      components: display.components,
      flags: display.flags,
    });
  },
};
