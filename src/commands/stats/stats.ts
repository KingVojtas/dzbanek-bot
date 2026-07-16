import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const stats: Command = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show music and activity stats for the server or a user.')
    .addUserOption((o) => o.setName('user').setDescription('Specific user (optional)')),

  async execute(interaction, services) {
    if (!services.stats || !interaction.guildId) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Stats not available.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser('user');
    const g = await services.stats.getGuild(interaction.guildId);
    if (!g) {
      await interaction.reply({
        embeds: [buildInfoEmbed('No stats yet for this server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (targetUser) {
      const u = g.users[targetUser.id];
      if (!u) {
        await interaction.reply({
          embeds: [buildInfoEmbed(`${targetUser} has no recorded activity yet.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const dur = Math.round(u.totalDurationSec / 60);
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `Plays: ${u.plays}  Duration: ~${dur}m  Skips: ${u.skips}  Wishlist adds: ${u.wishlistAdds}`,
            `Stats for ${targetUser.username}`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // guild summary
    const topUserId = Object.entries(g.users).sort((a, b) => b[1].plays - a[1].plays)[0]?.[0];
    const durMin = Math.round(g.totalDurationSec / 60);

    // Surface one cool fact: the server's most played track (data is already tracked)
    const topTrackEntry = Object.values(g.topTracks || {}).sort((a, b) => b.plays - a.plays)[0];
    const topTrackLine = topTrackEntry
      ? `\nMost played: **${topTrackEntry.title}** (${topTrackEntry.plays} plays)`
      : '';

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          `Total plays: ${g.totalPlays} (~${durMin}m)\n` +
            `Skips: ${g.totalSkips} | Wishlist adds: ${g.totalWishlistAdds}\n` +
            (topUserId ? `Top player: <@${topUserId}>` : '') +
            topTrackLine,
          'Server Stats',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
