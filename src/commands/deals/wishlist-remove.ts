import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

export const wishlistRemove: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist-remove')
    .setDescription('Remove an item from your wishlist by list index (see /wishlist-list).')
    .addIntegerOption((o) =>
      o
        .setName('index')
        .setDescription('1-based index from your list')
        .setRequired(true)
        .setMinValue(1),
    ),

  async execute(interaction, services) {
    if (!services.wishlist) {
      await interaction.reply({
        content: 'Wishlist not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const idx = interaction.options.getInteger('index', true) - 1;
    const list = services.wishlist.get(interaction.user.id);
    const target = list[idx];
    if (!target) {
      await interaction.reply({ content: 'Invalid index.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ok = services.wishlist.remove(interaction.user.id, target);
    if (ok) services.wishlist.save();
    await interaction.reply({
      content: ok ? `Removed: ${target}` : 'Nothing removed.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
