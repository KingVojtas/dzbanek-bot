import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildPlaylistEmbed } from '../../core/embeds';
import { PlaylistRepository } from '../../db/repositories';
import type { Command, Track } from '../../core/types';

const PLAYLIST_NAME = 'Dzbanek playlist';

const playlistRepo = new PlaylistRepository();

/** Collapse common YouTube / Spotify URL shapes so the same track matches across forms. */
function normalizeTrackUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id ? `youtube:${id}` : url;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `youtube:${v}`;
      const parts = u.pathname.split('/').filter(Boolean);
      // /shorts/ID, /embed/ID, /live/ID
      if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
        return `youtube:${parts[1]}`;
      }
    }
    if (host === 'open.spotify.com' || host === 'spotify.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      // /track/ID, /intl-xx/track/ID
      const trackIdx = parts.indexOf('track');
      if (trackIdx >= 0 && parts[trackIdx + 1]) {
        return `spotify:track:${parts[trackIdx + 1]}`;
      }
    }
    return `${host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type PlaylistRow = Awaited<ReturnType<PlaylistRepository['getItems']>>[number];

/** True when the track is already stored (same video/URL, or identical title). */
function isTrackInPlaylist(items: PlaylistRow[], track: { title: string; url: string }): boolean {
  const urlKey = normalizeTrackUrl(track.url);
  const titleKey = normalizeText(track.title);

  return items.some((item) => {
    if (normalizeTrackUrl(item.url) === urlKey) return true;
    // Same title (normalized) counts as duplicate when both sides have a real title
    if (titleKey.length >= 2 && normalizeText(item.title) === titleKey) return true;
    return false;
  });
}

/** Find playlist rows that match a user query and/or resolved tracks. */
function findMatchingPlaylistItems(
  items: PlaylistRow[],
  query: string,
  resolved: Track[],
): PlaylistRow[] {
  const queryNorm = normalizeText(query);
  const resolvedUrlKeys = new Set(
    resolved.map((t) => normalizeTrackUrl(t.url)).filter((k) => k.length > 0),
  );
  const resolvedTitleNorms = resolved.map((t) => normalizeText(t.title)).filter(Boolean);

  return items.filter((item) => {
    const itemUrlKey = normalizeTrackUrl(item.url);
    if (resolvedUrlKeys.has(itemUrlKey)) return true;

    const itemTitle = normalizeText(item.title);
    const itemArtist = item.artist ? normalizeText(item.artist) : '';
    const itemLabel = itemArtist ? `${itemArtist} ${itemTitle}` : itemTitle;

    // Exact-ish title match against resolved YouTube/Spotify results
    for (const resolvedTitle of resolvedTitleNorms) {
      if (
        itemTitle === resolvedTitle ||
        itemLabel === resolvedTitle ||
        (resolvedTitle.length >= 4 &&
          (itemTitle.includes(resolvedTitle) || resolvedTitle.includes(itemTitle)))
      ) {
        return true;
      }
    }

    // Direct text match against what's stored (name / artist / raw query string)
    if (queryNorm.length >= 2) {
      if (
        itemTitle.includes(queryNorm) ||
        itemLabel.includes(queryNorm) ||
        queryNorm.includes(itemTitle) ||
        (itemArtist && itemArtist.includes(queryNorm))
      ) {
        return true;
      }
    }

    // URL pasted as query
    if (query.includes('http') && itemUrlKey === normalizeTrackUrl(query)) {
      return true;
    }

    return false;
  });
}

export const playlist: Command = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage and play the server\'s "Dzbanek playlist"')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a song by name/URL (YouTube/Spotify), or the currently playing track')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('Song name or YouTube/Spotify/SoundCloud URL')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a song from the playlist by name or URL (YouTube/Spotify search)')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('Song name or YouTube/Spotify/SoundCloud URL to remove')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('play').setDescription('Add all songs from the Dzbanek playlist to the queue'),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show songs in the Dzbanek playlist'),
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

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const items = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
      if (items.length === 0) {
        await interaction.editReply({
          embeds: [buildPlaylistEmbed([], PLAYLIST_NAME)],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          buildPlaylistEmbed(
            items.map((it) => ({
              title: it.title,
              url: it.url,
              durationSec: it.durationSec,
              artist: it.artist,
              addedBy: it.addedBy,
            })),
            PLAYLIST_NAME,
          ),
        ],
      });
      return;
    }

    if (sub === 'add') {
      const query = interaction.options.getString('query')?.trim();

      if (query) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let tracks: Track[];
        try {
          tracks = await services.music.trackSource.resolve(query, interaction.user.username);
        } catch (error: unknown) {
          services.logger.error('Failed to resolve track for playlist add:', error);
          await interaction.editReply(
            '❌ Could not find that song. Try a different name or paste a YouTube/Spotify URL.',
          );
          return;
        }

        if (tracks.length === 0) {
          await interaction.editReply('🔍 No results found for that query.');
          return;
        }

        const existing = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
        // Dedupe within this batch too (e.g. Spotify album with repeats)
        const seenInBatch = new Set<string>();
        const toAdd: Track[] = [];
        let skipped = 0;

        for (const track of tracks) {
          const key = normalizeTrackUrl(track.url) || normalizeText(track.title);
          if (seenInBatch.has(key) || isTrackInPlaylist(existing, track)) {
            skipped += 1;
            continue;
          }
          seenInBatch.add(key);
          toAdd.push(track);
        }

        if (toAdd.length === 0) {
          if (tracks.length === 1) {
            await interaction.editReply(
              `📋 **${tracks[0].title}** is already in the playlist.`,
            );
          } else {
            await interaction.editReply('📋 All of those songs are already in the playlist.');
          }
          return;
        }

        for (const track of toAdd) {
          await playlistRepo.addItem(
            guildId,
            {
              title: track.title,
              url: track.url,
              artist: track.uploader,
              durationSec: track.durationSec,
              addedBy: interaction.user.username,
            },
            PLAYLIST_NAME,
          );
        }

        if (toAdd.length === 1 && skipped === 0) {
          await interaction.editReply(`✅ Added **${toAdd[0].title}** to the Dzbanek playlist.`);
        } else if (skipped > 0) {
          await interaction.editReply(
            `✅ Added **${toAdd.length}** track(s) to the Dzbanek playlist` +
              ` (skipped **${skipped}** already in the playlist).`,
          );
        } else {
          await interaction.editReply(
            `✅ Added **${toAdd.length}** tracks to the Dzbanek playlist.`,
          );
        }
        return;
      }

      // No query: add currently playing track
      const subscription = services.music.get(guildId);
      const current = subscription?.current;
      if (!current) {
        await interaction.reply({
          content:
            '🔇 Nothing is currently playing. Use `/playlist add query:song name` to add by search.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const existing = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
      if (isTrackInPlaylist(existing, current)) {
        await interaction.reply({
          content: `📋 **${current.title}** is already in the playlist.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await playlistRepo.addItem(
        guildId,
        {
          title: current.title,
          url: current.url,
          artist: current.uploader,
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

    if (sub === 'remove') {
      const query = interaction.options.getString('query', true).trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const items = await playlistRepo.getItems(guildId, PLAYLIST_NAME);
      if (items.length === 0) {
        await interaction.editReply('The Dzbanek playlist is empty.');
        return;
      }

      // Resolve via YouTube/Spotify so URL/title match the same way as /playlist add.
      let resolved: Track[] = [];
      try {
        resolved = await services.music.trackSource.resolve(query, interaction.user.username);
      } catch (error: unknown) {
        services.logger.debug('Playlist remove resolve failed (will try text match):', error);
      }

      const matches = findMatchingPlaylistItems(items, query, resolved);
      if (matches.length === 0) {
        await interaction.editReply("Couldn't find that song in the playlist.");
        return;
      }

      const removedCount = await playlistRepo.removeByIds(matches.map((m) => m.id));
      if (removedCount === 1) {
        const title = matches[0].artist
          ? `${matches[0].artist} - ${matches[0].title}`
          : matches[0].title;
        await interaction.editReply(`🗑️ Removed **${title}** from the Dzbanek playlist.`);
      } else {
        await interaction.editReply(
          `🗑️ Removed **${removedCount}** matching tracks from the Dzbanek playlist.`,
        );
      }
      return;
    }

    if (sub === 'play') {
      const member = interaction.member;
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
        requestedById: interaction.user.id,
        uploader: it.artist ?? undefined,
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
