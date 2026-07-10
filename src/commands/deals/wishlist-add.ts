import { MessageFlags, SlashCommandBuilder } from 'discord.js';
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
        content: 'Wishlist not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const input = interaction.options.getString('input', true).trim();
    let appId = input;

    // crude extraction if URL
    const match = input.match(/store\.steampowered\.com\/app\/(\d+)/);
    if (match) appId = match[1];

    // if looks like number use as-is, else treat name as key (store name for simplicity)
    if (!/^\d+$/.test(appId)) {
      // store as normalized name; matching will be limited but works for exact names in deals
      appId = `name:${appId.toLowerCase()}`;
    }

    services.wishlist.add(interaction.user.id, [appId]);
    services.wishlist.save();

    if (services.stats && interaction.guildId) {
      services.stats.recordWishlistAdd(interaction.guildId, interaction.user.id);
      services.stats.save();
    }

    await interaction.reply({
      content: `✅ Added to wishlist: ${input}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
