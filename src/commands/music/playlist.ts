import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueueEmbed } from '../../core/embeds';
import { PlaylistRepository } from '../../db/repositories';
import type { Command, Track } from '../../core/types';

const PLAYLIST_NAME = 'Dzbanek playlist';

const playlistRepo = new PlaylistRepository();

export const playlist: Command = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage and play the server\'s "Dzbanek playlist"')
    .addSubcommand((sub) =>
      sub.setName('add').setDescription('Add the currently playing song to the Dzbanek playlist'),
    )
    .addSubcommand((sub) =>
      sub.setName('play').setDescription('Add all songs from the Dzbanek playlist to the queue'),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'Playlists are only available in servers.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(false);

    if (!sub) {
      // Base /playlist - show list
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const items = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
      if (items.length === 0) {
        await interaction.editReply(
          'The Dzbanek playlist is empty. Use /playlist add when something is playing.',
        );
        return;
      }

      // Convert to Track-like for embed (duration unknown)
      const fakeTracks = items.map((it) => ({
        title: it.artist ? `${it.artist} - ${it.title}` : it.title,
        url: it.url,
        durationSec: it.durationSec || 0,
        requestedBy: it.addedBy || 'unknown',
      }));

      await interaction.editReply({
        embeds: [buildQueueEmbed(null, fakeTracks as unknown as Track[])],
      });
      return;
    }

    if (sub === 'add') {
      const subscription = guildId ? services.music.get(guildId) : undefined;
      const current = subscription?.current;
      if (!current) {
        await interaction.reply({
          content: '🔇 Nothing is currently playing to add.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await playlistRepo.addItem(
        guildId,
        {
          title: current.title,
          url: current.url,
          durationSec: current.durationSec,
          addedBy: interaction.user.username,
        },
        PLAYLIST_NAME,
      );

      await interaction.reply({
        content: `✅ Added **${current.title}** to the Dzbanek playlist.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'play') {
      const member = interaction.member;
      const { GuildMember } = await import('discord.js');
      const voiceChannel = member instanceof GuildMember ? member.voice.channel : null;
      if (!voiceChannel) {
        await interaction.reply({
          content: '🔇 You need to be in a voice channel to play.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const items = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
      if (items.length === 0) {
        await interaction.editReply('The Dzbanek playlist is empty.');
        return;
      }

      const tracks = items.map((it) => ({
        title: it.artist ? `${it.artist} - ${it.title}` : it.title,
        url: it.url,
        durationSec: it.durationSec || 0,
        requestedBy: interaction.user.username,
      }));

      const subscription = await services.music.join(voiceChannel);
      const room = services.config.music.maxQueueSize - subscription.queue.length;
      const accepted = tracks.slice(0, Math.max(0, room));

      if (accepted.length === 0) {
        await interaction.editReply('⚠️ The queue is full.');
        return;
      }

      subscription.enqueue(accepted as unknown as Track[]);

      await interaction.editReply(
        `➕ Added **${accepted.length}** tracks from the Dzbanek playlist to the queue.`,
      );
      return;
    }
  },
};
