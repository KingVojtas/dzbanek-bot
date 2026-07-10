import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { buildTrackEmbed } from '../../core/embeds';
import type { Command, Track } from '../../core/types';

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play from YouTube, Spotify, or SoundCloud (URL or search).')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A YouTube/Spotify URL or search terms')
        .setRequired(true),
    ),

  async execute(interaction, services) {
    const member = interaction.member;
    const voiceChannel = member instanceof GuildMember ? member.voice.channel : null;
    if (!voiceChannel) {
      await interaction.reply({
        content: '🔇 You need to be in a voice channel to play music.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    let tracks: Track[];
    try {
      tracks = await services.music.trackSource.resolve(query, interaction.user.username);
    } catch (error) {
      services.logger.error('Failed to resolve track:', error);
      await interaction.editReply('❌ Could not load that track. Try a different URL or search.');
      return;
    }

    if (tracks.length === 0) {
      await interaction.editReply('🔍 No results found for your query.');
      return;
    }

    const subscription = await services.music.join(voiceChannel);
    const wasIdle = !subscription.current && subscription.queue.length === 0;

    const room = services.config.music.maxQueueSize - subscription.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) {
      await interaction.editReply('⚠️ The queue is full. Try again once some tracks have played.');
      return;
    }
    subscription.enqueue(accepted);

    if (services.stats && interaction.guildId) {
      for (const t of accepted) {
        services.stats.recordPlay(interaction.guildId, interaction.user.id, t);
      }
      services.stats.save();
    }

    if (accepted.length === 1) {
      const label = wasIdle ? '▶️ Now playing' : '➕ Added to queue';
      const embed = buildTrackEmbed(accepted[0], label);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('music:pause').setLabel('⏯️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('music:skip')
          .setLabel('⏭️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('music:shuffle')
          .setLabel('🔀')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('music:loop')
          .setLabel('🔁')
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
    } else {
      await interaction.editReply(`➕ Added **${accepted.length}** tracks to the queue.`);
    }
  },
};
