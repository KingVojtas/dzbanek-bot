import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildMusicPlayerDisplay } from '../../core/display';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const game: Command = {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Join your voice channel and play a game soundtrack.')
    .addStringOption((option) =>
      option.setName('query').setDescription('Game name').setRequired(true),
    ),

  async execute(interaction, services) {
    const member = interaction.member;
    const voiceChannel = member instanceof GuildMember ? member.voice.channel : null;
    if (!voiceChannel) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 You need to be in a voice channel to play a soundtrack.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    const ostQuery = `${query} official soundtrack`;
    let tracks;
    try {
      tracks = await services.music.trackSource.resolve(ostQuery, interaction.user.username);
    } catch (error) {
      services.logger.error('Failed to resolve game soundtrack:', error);
      await interaction.editReply({
        embeds: [buildInfoEmbed('❌ Could not find a soundtrack for that game.')],
      });
      return;
    }

    if (!tracks || tracks.length === 0) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            `🔍 No soundtrack found for "${query}". Try a more specific name or use /play.`,
          ),
        ],
      });
      return;
    }

    const track = tracks[0];
    track.requestedById = interaction.user.id;

    const subscription = await services.music.join(voiceChannel);
    const wasIdle = !subscription.current && subscription.queue.length === 0;

    const room = services.config.music.maxQueueSize - subscription.queue.length;
    if (room <= 0) {
      await interaction.editReply({
        embeds: [buildInfoEmbed('⚠️ The queue is full. Try again once some tracks have played.')],
      });
      return;
    }

    subscription.enqueue([track]);

    const displayTrack = wasIdle ? (subscription.current ?? track) : track;
    const display = buildMusicPlayerDisplay({
      track: displayTrack,
      positionSec: wasIdle ? subscription.getPlaybackPositionSec() : 0,
      queueLength: subscription.queue.length,
      paused: subscription.paused,
      loopMode: subscription.loopMode,
      label: wasIdle ? 'Now Playing' : 'Added to queue',
      footer: `Soundtrack for ${query}`,
    });

    await interaction.editReply({
      components: display.components,
      flags: display.flags,
    });
  },
};
