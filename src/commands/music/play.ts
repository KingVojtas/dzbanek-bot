import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildMusicPlayerDisplay, sendMusicPlayerReply } from '../../core/display';
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
    // Acknowledge immediately; use content (not embeds) so Components V2 can replace it.
    await interaction.deferReply();

    // Settings are local SQLite (fast). Then resolve + voice join in parallel.
    if (interaction.guildId) {
      try {
        const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
        if (settings.musicEnabled === false) {
          await interaction.editReply({
            content:
              '🎵 Music is disabled on this server. An admin can re-enable it in the web admin dashboard.',
          });
          return;
        }
      } catch {
        /* proceed; music defaults to on */
      }
    }

    const isSpotifyCollection = isSpotifyPlaylistUrl(query) || isSpotifyAlbumUrl(query);
    if (isSpotifyCollection) {
      void interaction.editReply({
        content:
          '🔍 Resolving Spotify album/playlist on YouTube… large collections can take a bit.',
      });
    }

    let tracks: Track[];
    let subscription: Awaited<ReturnType<typeof services.music.join>>;
    try {
      [tracks, subscription] = await Promise.all([
        services.music.trackSource.resolve(query, interaction.user.username),
        services.music.join(voiceChannel),
      ]);
    } catch (error: unknown) {
      // Prefer surfacing resolve errors; join errors are also useful.
      services.logger.error('Failed to resolve/join for /play:', error);
      const errMsg = error instanceof Error ? error.message : String(error || '');
      const botHint = youtubeBotCheckHint(errMsg);
      let msg = botHint ?? null;
      const errStr = errMsg.toLowerCase();
      if (!msg && (errStr.includes('spotify_client') || errStr.includes('spotify client'))) {
        msg =
          '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on the bot host.';
      } else if (
        !msg &&
        (errStr.includes('spotify') || errStr.includes('playlist') || errStr.includes('album'))
      ) {
        // Show the real Spotify API reason (403 public playlist, etc.)
        msg = `❌ ${errMsg.slice(0, 500)}`;
      } else if (
        !msg &&
        (errStr.includes('unavailable') ||
          errStr.includes('private') ||
          errStr.includes('age-restrict'))
      ) {
        msg = '❌ This video is unavailable, private, or age-restricted.';
      } else if (!msg && (errStr.includes('voice') || errStr.includes('connect'))) {
        msg = `❌ ${errMsg}`;
      } else if (!msg) {
        msg = `❌ Could not load that track or join voice.\n${errMsg.slice(0, 400)}`;
      }
      await interaction.editReply({ content: msg });
      return;
    }

    if (tracks.length === 0) {
      await interaction.editReply({
        content: isSpotifyCollection
          ? '🔍 Spotify album/playlist loaded, but no playable YouTube matches were found. Is the home music bridge running?'
          : '🔍 No results found for your query.',
      });
      return;
    }

    for (const t of tracks) {
      t.requestedById = interaction.user.id;
    }

    const wasIdle = !subscription.current && subscription.queue.length === 0;
    const hadCurrent = !!subscription.current;

    const room = services.config.music.maxQueueSize - subscription.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) {
      await interaction.editReply({
        content: '⚠️ The queue is full. Try again once some tracks have played.',
      });
      return;
    }
    subscription.enqueue(accepted);

    // Wait for stream, but show the player as soon as audio starts (or after a short grace).
    // Previously we blocked the whole UI for up to 55s on “Loading…”.
    if (wasIdle && accepted.length >= 1) {
      void interaction.editReply({ content: '🔄 Loading…' }).catch(() => {});
      const attempt = await subscription.waitForPlaybackAttempt(25_000);
      if (!attempt.ok) {
        const hint = attempt.error ? youtubeBotCheckHint(attempt.error) : null;
        await interaction.editReply({
          content:
            hint ??
            `❌ Could not play **${accepted[0].title}**.\n${attempt.error?.slice(0, 400) ?? 'Unknown stream error.'}`,
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

      const panel = await sendMusicPlayerReply(interaction, display);
      if (wasIdle && panel && subscription.current) {
        subscription.setNowPlayingMessage(panel);
      }
    } else {
      let msg = `➕ Added **${accepted.length}** tracks to the queue.`;
      if (!wasIdle) {
        const firstAddedIdx = subscription.queue.length - accepted.length;
        const aheadForFirst = (hadCurrent && subscription.current ? 1 : 0) + firstAddedIdx;
        const firstPos = aheadForFirst + 1;
        msg += ` First one is at position **#${firstPos}**.`;
      }
      await interaction.editReply({ content: msg });
    }
  },
};
