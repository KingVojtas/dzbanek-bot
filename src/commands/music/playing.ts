import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildMusicPlayerDisplay, sendMusicPlayerReply } from '../../core/display';
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

    if (interaction.channel?.isSendable()) {
      subscription.setAnnounceChannel(interaction.channel);
    }

    // Replace any existing live panel with a fresh one in this channel
    await subscription.publishFreshNowPlaying(subscription.current);
    // Acknowledge the slash command (panel is a separate channel message)
    if (subscription.getNowPlayingMessage()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.deleteReply().catch(() => {});
      } else {
        await interaction.reply({
          embeds: [buildInfoEmbed('🎵 Updated the now-playing panel.')],
          flags: MessageFlags.Ephemeral,
        });
      }
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

    const panel = await sendMusicPlayerReply(interaction, display);
    if (panel) subscription.setNowPlayingMessage(panel);
  },
};
