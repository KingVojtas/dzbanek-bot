import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { fetchGameName, searchSteamAppIdByName } from '../../steam/SteamPriceApi';
import type { Command } from '../../core/types';

const STEAM_COLOR = 0x1b2838;

interface WishlistDisplay {
  name: string;
  link?: string;
}

/** Returns a clean display object with name (no IDs) and optional View on Steam link. */
async function getWishlistDisplay(raw: string): Promise<WishlistDisplay> {
  let name: string;
  let link: string | undefined;

  if (raw.startsWith('name:')) {
    const namePart = raw.slice(5);
    // Title case for display
    name = namePart
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    // Try to resolve to App ID for the link (without showing the ID)
    try {
      const foundId = await searchSteamAppIdByName(namePart);
      if (foundId) {
        link = `https://store.steampowered.com/app/${foundId}/`;
      }
    } catch {
      // no link if search fails
    }
  } else if (/^\d+$/.test(raw)) {
    try {
      const fetched = await fetchGameName(raw);
      name = fetched || 'Unknown Game';
    } catch {
      name = 'Unknown Game';
    }
    link = `https://store.steampowered.com/app/${raw}/`;
  } else {
    name = raw;
  }

  return { name, link };
}

export const wishlistList: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist-list')
    .setDescription('List your wishlist items.'),

  async execute(interaction, services) {
    if (!services.wishlist) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Wishlist not available.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const list = await services.wishlist.get(interaction.user.id);
    if (!list.length) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Your wishlist is empty. Use `/wishlist-add` to add games for deal alerts.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const itemsToShow = list.slice(0, 20);
    const displays = await Promise.all(itemsToShow.map((raw) => getWishlistDisplay(raw)));

    const lines = displays.map((d, i) => {
      const linkPart = d.link ? ` — [View on Steam](${d.link})` : '';
      return `${i + 1}. **${d.name}**${linkPart}`;
    });

    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle('🎮 Your Wishlist')
      .setDescription(lines.join('\n'))
      .setFooter({
        text:
          list.length > 20
            ? `Showing first 20 of ${list.length} items • Use /wishlist-remove <name>`
            : `${list.length} item(s) • Use /wishlist-remove <name> to remove`,
      })
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
