import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { fetchGameName, resolveToAppIdOrName } from '../../steam/SteamPriceApi';
import type { Command } from '../../core/types';

export const wishlistAdd: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist-add')
    .setDescription(
      'Add a Steam game (by AppID, URL or name) to your personal wishlist for deal alerts.',
    )
    .addStringOption((o) =>
      o.setName('input').setDescription('App ID, Steam store URL, or game name').setRequired(true),
    ),

  async execute(interaction, services) {
    if (!services.wishlist) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Wishlist not available.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const input = interaction.options.getString('input', true).trim();

    // Always try to resolve to a real App ID (URL, number, or name search)
    const appId = await resolveToAppIdOrName(input);
    let resolvedName: string | null = null;
    if (/^\d+$/.test(appId)) {
      resolvedName = await fetchGameName(appId).catch(() => null);
    }

    await services.wishlist.add(interaction.user.id, [appId]);

    if (services.stats && interaction.guildId) {
      await services.stats.recordWishlistAdd(interaction.guildId, interaction.user.id);
    }

    const displayName = resolvedName || input;

    let response = `✅ **${displayName}** was added to your wishlist.\nYou'll get DM notifications when it goes on sale (via the daily Steam deals).`;

    if (/^\d+$/.test(appId)) {
      response += `\n[View on Steam](https://store.steampowered.com/app/${appId}/)`;
    }

    await interaction.reply({
      embeds: [buildInfoEmbed(response)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
