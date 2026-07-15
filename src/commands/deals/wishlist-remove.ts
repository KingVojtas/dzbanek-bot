import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { fetchGameName } from '../../steam/SteamPriceApi';
import type { Command } from '../../core/types';

export const wishlistRemove: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist-remove')
    .setDescription('Remove a game from your wishlist by name (see /wishlist-list).')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Game name (or part of it) exactly as shown in /wishlist-list')
        .setRequired(true),
    ),

  async execute(interaction, services) {
    if (!services.wishlist) {
      await interaction.reply({
        content: 'Wishlist not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const input = interaction.options.getString('name', true).trim().toLowerCase();
    const list = await services.wishlist.get(interaction.user.id);

    if (!list.length) {
      await interaction.reply({
        content: 'Your wishlist is empty.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Build display names for matching (same logic as list)
    const entries = await Promise.all(
      list.map(async (raw) => {
        let display = raw;
        if (raw.startsWith('name:')) {
          display = raw.slice(5);
        } else if (/^\d+$/.test(raw)) {
          try {
            const name = await fetchGameName(raw);
            if (name) display = name;
          } catch {
            // keep raw as fallback (won't happen for user-facing)
          }
        }
        return { raw, display: display.toLowerCase() };
      }),
    );

    // Find best match (contains or contained)
    const match = entries.find((e) => e.display.includes(input) || input.includes(e.display));

    if (!match) {
      await interaction.reply({
        content: `No game matching "${input}" found in your wishlist. Check the exact name with /wishlist-list.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ok = await services.wishlist.remove(interaction.user.id, match.raw);

    // Pretty name for confirmation (without technical stuff)
    let niceName = match.raw;
    if (match.raw.startsWith('name:')) {
      niceName = match.raw.slice(5);
    } else if (/^\d+$/.test(match.raw)) {
      try {
        const name = await fetchGameName(match.raw);
        if (name) niceName = name;
      } catch {
        // ignore - use fallback niceName
      }
    }

    await interaction.reply({
      content: ok ? `✅ Removed **${niceName}** from your wishlist.` : 'Nothing was removed.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
