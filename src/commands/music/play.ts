import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildMusicPlayerDisplay } from '../../core/display';
import { buildInfoEmbed, formatDuration } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { isSpotifyAlbumUrl, isSpotifyPlaylistUrl } from '../../music/source/spotifysource';
import { youtubeBotCheckHint } from '../../music/ytdlp-cookies';
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
      const botHint = youtubeBotCheckHint(errMsg);
      let msg = botHint ?? '❌ Could not load that track. Try a different URL or search.';
      const errStr = errMsg.toLowerCase();
      if (!botHint && (errStr.includes('spotify_client') || errStr.includes('spotify client'))) {
        msg =
          '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` (free at https://developer.spotify.com/dashboard). Single track links still work without them.';
      } else if (
        !botHint &&
        (errStr.includes('unavailable') ||
          errStr.includes('private') ||
          errStr.includes('age-restrict'))
      ) {
        msg =
          '❌ This video is unavailable, private, age-restricted, or requires login. Try a different (public) URL or search.';
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

    // When starting from idle, wait for the stream so YouTube bot-blocks surface in Discord
    // instead of "joined VC with no sound".
    if (wasIdle && accepted.length >= 1) {
      await interaction.editReply({
        embeds: [buildInfoEmbed('🔄 Loading audio stream…')],
      });
      const attempt = await subscription.waitForPlaybackAttempt(55_000);
      if (!attempt.ok) {
        const hint = attempt.error ? youtubeBotCheckHint(attempt.error) : null;
        await interaction.editReply({
          embeds: [
            buildInfoEmbed(
              hint ??
                `❌ Could not play **${accepted[0].title}**.\n${attempt.error?.slice(0, 400) ?? 'Unknown stream error.'}`,
            ),
          ],
        });
        return;
      }
    }

    if (accepted.length === 1) {
      const track = accepted[0];
      const nowPlaying = wasIdle ? (subscription.current ?? track) : track;
      const label = wasIdle ? 'Now Playing' : 'Added to queue';

      let footer: string | undefined;
      if (!wasIdle) {
        const addedIdx = subscription.queue.length - 1;
        const ahead = (hadCurrent && subscription.current ? 1 : 0) + addedIdx;
        const position = ahead + 1;

        let waitSec = 0;
        if (hadCurrent && subscription.current) waitSec += subscription.current.durationSec || 0;
        for (let i = 0; i < addedIdx; i++) {
          const t = subscription.queue[i];
          if (t) waitSec += t.durationSec || 0;
        }

        footer = `Position #${position}${waitSec > 0 ? ` · ~${formatDuration(waitSec)} until it starts` : ''}`;
      }

      const display = buildMusicPlayerDisplay({
        track: nowPlaying,
        positionSec: wasIdle ? subscription.getPlaybackPositionSec() : 0,
        queueLength: subscription.queue.length,
        paused: subscription.paused,
        loopMode: subscription.loopMode,
        label,
        footer,
      });

      await interaction.editReply({
        components: display.components,
        flags: display.flags,
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
