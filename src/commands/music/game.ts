import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildTrackEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const game: Command = {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Look up a game and play its soundtrack (or search results).')
    .addStringOption((option) =>
      option.setName('query').setDescription('Game name').setRequired(true),
    ),

  async execute(interaction, services) {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ostQuery = `${query} official soundtrack`;
    let tracks;
    try {
      tracks = await services.music.trackSource.resolve(ostQuery, interaction.user.username);
    } catch (error) {
      services.logger.error('Failed to resolve game soundtrack:', error);
      await interaction.editReply('❌ Could not find a soundtrack for that game.');
      return;
    }

    if (!tracks || tracks.length === 0) {
      await interaction.editReply(
        `🔍 No soundtrack found for "${query}". Try a more specific name or use /play.`,
      );
      return;
    }

    const track = tracks[0];
    const embed = buildTrackEmbed(track, '🎮 Game Soundtrack');
    await interaction.editReply({
      content: `Found soundtrack for **${query}**`,
      embeds: [embed],
    });
  },
};
