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
    )
    .addBooleanOption((option) =>
      option
        .setName('play_next')
        .setDescription('Insert at the front of the queue (play after the current track)')
        .setRequired(false),
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
      // Only treat as "missing env" when the code explicitly says credentials are required
      // (do NOT match `spotify_client_id` inside other messages — that hid real 403s).
      if (!msg && /spotify_client_id and spotify_client_secret are required/i.test(errMsg)) {
        msg =
          '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on the bot host.';
      } else if (
        !msg &&
        (errStr.includes('spotify') ||
          errStr.includes('playlist') ||
          errStr.includes('album') ||
          errStr.includes('403') ||
          errStr.includes('public'))
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
    const playNext = interaction.options.getBoolean('play_next') ?? false;

    const room = services.config.music.maxQueueSize - subscription.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) {
      await interaction.editReply({
        content: '⚠️ The queue is full. Try again once some tracks have played.',
      });
      return;
    }

    // Wire the text channel so each track can post a fresh now-playing panel
    // (and delete the previous one) as the album/queue advances.
    if (interaction.channel?.isSendable()) {
      subscription.setAnnounceChannel(interaction.channel);
    }

    if (playNext && !wasIdle) {
      subscription.enqueueNext(accepted);
    } else {
      subscription.enqueue(accepted);
    }

    // Wait for stream, but show the player as soon as audio starts (or after a short grace).
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

      // Subscription posts a Components V2 now-playing message on track start.
      // Give announce a brief moment if the stream just started.
      if (!subscription.getNowPlayingMessage()) {
        await new Promise((r) => setTimeout(r, 400));
      }

      if (subscription.getNowPlayingMessage()) {
        try {
          await interaction.deleteReply();
        } catch {
          /* may already be gone */
        }
        if (accepted.length > 1) {
          await interaction
            .followUp({
              content: `🎶 Queued **${accepted.length}** tracks · now playing **${subscription.current?.title ?? accepted[0].title}**. Use \`/queue\` to browse pages.`,
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      }

      // Fallback if announce channel wasn't available — reply with the player panel.
      if (subscription.current) {
        const display = buildMusicPlayerDisplay({
          track: subscription.current,
          positionSec: subscription.getPlaybackPositionSec(),
          queueLength: subscription.queue.length,
          paused: subscription.paused,
          loopMode: subscription.loopMode,
          label:
            accepted.length > 1 ? `Now Playing · +${accepted.length - 1} queued` : 'Now Playing',
        });
        const panel = await sendMusicPlayerReply(interaction, display);
        if (panel) subscription.setNowPlayingMessage(panel);
        return;
      }
    }

    // Adding while something is already playing — confirmation, not a new live panel.
    const currentTrack = subscription.current;
    const displayTrack = accepted.length === 1 ? accepted[0] : (currentTrack ?? accepted[0]);

    if (displayTrack && (accepted.length === 1 || currentTrack)) {
      const label = playNext
        ? accepted.length > 1
          ? `Play next · ${accepted.length} tracks`
          : 'Play next'
        : accepted.length > 1
          ? `Added ${accepted.length} tracks`
          : 'Added to queue';

      let footer: string | undefined;
      if (playNext) {
        footer =
          accepted.length === 1
            ? `Up next after current · ${subscription.queue.length} still in queue`
            : `${accepted.length} tracks inserted at front · ${subscription.queue.length} in queue`;
      } else if (accepted.length === 1) {
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
      } else {
        footer = `${accepted.length} tracks from this request · ${subscription.queue.length} still in queue`;
      }

      const display = buildMusicPlayerDisplay({
        track: displayTrack,
        positionSec: 0,
        queueLength: subscription.queue.length,
        paused: subscription.paused,
        loopMode: subscription.loopMode,
        volumePct: subscription.volume,
        label,
        footer,
      });

      // Ephemeral-style confirmation reply (does not become the live NP panel)
      await sendMusicPlayerReply(interaction, display);
    } else {
      let msg = `➕ Added **${accepted.length}** tracks to the queue.`;
      const firstAddedIdx = subscription.queue.length - accepted.length;
      const aheadForFirst = (hadCurrent && subscription.current ? 1 : 0) + firstAddedIdx;
      const firstPos = aheadForFirst + 1;
      msg += ` First one is at position **#${firstPos}**.`;
      await interaction.editReply({ content: msg });
    }
  },
};
