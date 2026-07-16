import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { buildInfoEmbed, buildTrackEmbed } from '../../core/embeds';
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

    const label = wasIdle ? '🎮 Now playing soundtrack' : '🎮 Added soundtrack to queue';
    const embed = buildTrackEmbed(track, label);
    embed.setFooter({ text: `Soundtrack for ${query}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('music:pause').setLabel('⏯️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music:skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  },
};
