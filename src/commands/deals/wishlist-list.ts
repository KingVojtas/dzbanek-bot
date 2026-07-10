import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const wishlistList: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist-list')
    .setDescription('List your wishlist items.'),

  async execute(interaction, services) {
    if (!services.wishlist) {
      await interaction.reply({
        content: 'Wishlist not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const list = services.wishlist.get(interaction.user.id);
    if (!list.length) {
      await interaction.reply({
        content: 'Your wishlist is empty. Use /wishlist-add.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const display = list
      .slice(0, 20)
      .map((id, i) => `${i + 1}. ${id}`)
      .join('\n');
    await interaction.reply({
      content: `Your wishlist (${list.length}):\n${display}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
