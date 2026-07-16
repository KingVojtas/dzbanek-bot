import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { buildInfoEmbed, buildTrackEmbed, formatDuration } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { isSpotifyAlbumUrl, isSpotifyPlaylistUrl } from '../../music/source/spotifysource';
import type { Command, Track } from '../../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription(
      'Play from YouTube, Spotify (track/playlist/album), or SoundCloud (URL or search).',
    )
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
        embeds: [buildInfoEmbed('🔇 You need to be in a voice channel to play music.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    // Must acknowledge within ~3s — do this before any DB / yt-dlp work.
    await interaction.deferReply();

    if (interaction.guildId) {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      if (settings.musicEnabled === false) {
        await interaction.editReply({
          embeds: [
            buildInfoEmbed(
              '🎵 Music is disabled on this server. An admin can re-enable it in the web admin dashboard.',
            ),
          ],
        });
        return;
      }
    }

    const isSpotifyCollection = isSpotifyPlaylistUrl(query) || isSpotifyAlbumUrl(query);

    if (isSpotifyCollection) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            '🔍 Resolving Spotify album/playlist tracks on YouTube… this can take a minute for large collections.',
          ),
        ],
      });
    }

    let tracks: Track[];
    try {
      tracks = await services.music.trackSource.resolve(query, interaction.user.username);
    } catch (error: unknown) {
      services.logger.error('Failed to resolve track:', error);
      const errMsg = error instanceof Error ? error.message : String(error || '');
      let msg = '❌ Could not load that track. Try a different URL or search.';
      const errStr = errMsg.toLowerCase();
      if (errStr.includes('spotify_client') || errStr.includes('spotify client')) {
        msg =
          '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` (free at https://developer.spotify.com/dashboard). Single track links still work without them.';
      } else if (
        errStr.includes('unavailable') ||
        errStr.includes('private') ||
        errStr.includes('sign in')
      ) {
        msg =
          '❌ This video is unavailable, private, age-restricted, or requires login. Try a different (public) URL or search.';
      } else if (errStr.includes('bot')) {
        msg =
          '❌ YouTube is blocking extraction right now (common). Try again in a minute or use a search instead of URL.';
      }
      await interaction.editReply({ embeds: [buildInfoEmbed(msg)] });
      return;
    }

    if (tracks.length === 0) {
      await interaction.editReply({
        embeds: [buildInfoEmbed('🔍 No results found for your query.')],
      });
      return;
    }

    // Attach Discord user id so stats record when playback actually starts.
    for (const t of tracks) {
      t.requestedById = interaction.user.id;
    }

    const subscription = await services.music.join(voiceChannel);
    const wasIdle = !subscription.current && subscription.queue.length === 0;
    const hadCurrent = !!subscription.current;

    const room = services.config.music.maxQueueSize - subscription.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) {
      await interaction.editReply({
        embeds: [buildInfoEmbed('⚠️ The queue is full. Try again once some tracks have played.')],
      });
      return;
    }
    subscription.enqueue(accepted);

    if (accepted.length === 1) {
      const track = accepted[0];
      const label = wasIdle ? '▶️ Now playing' : '➕ Added to queue';
      const embed = buildTrackEmbed(track, label);

      // Cool + useful: show position + estimated wait when adding to an active session
      if (!wasIdle) {
        const addedIdx = subscription.queue.length - 1; // 0-based position of this track in queue
        const ahead = (hadCurrent && subscription.current ? 1 : 0) + addedIdx;
        const position = ahead + 1; // 1-based "you are #N in line"

        let waitSec = 0;
        if (hadCurrent && subscription.current) waitSec += subscription.current.durationSec || 0;
        for (let i = 0; i < addedIdx; i++) {
          const t = subscription.queue[i];
          if (t) waitSec += t.durationSec || 0;
        }

        const posPart = `Position #${position}`;
        const waitPart = waitSec > 0 ? ` • ~${formatDuration(waitSec)} until it starts` : '';
        embed.setFooter({ text: `${posPart}${waitPart}` });
      }

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

      await interaction.editReply({
        embeds: [embed],
        components: [row],
      });
    } else {
      // Multi-track: give a bit more useful info about where the batch landed
      let msg = `➕ Added **${accepted.length}** tracks to the queue.`;
      if (!wasIdle) {
        const firstAddedIdx = subscription.queue.length - accepted.length;
        const aheadForFirst = (hadCurrent && subscription.current ? 1 : 0) + firstAddedIdx;
        const firstPos = aheadForFirst + 1;
        msg += ` First one is at position **#${firstPos}**.`;
      }
      await interaction.editReply({ embeds: [buildInfoEmbed(msg)] });
    }
  },
};
