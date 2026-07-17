import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { canForceControl, isDjModeEnabled } from '../../music/dj';
import type { Command } from '../../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

export const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the queue by its position (1-based).')
    .addIntegerOption((opt) =>
      opt
        .setName('position')
        .setDescription('Position in queue (1 = next)')
        .setRequired(true)
        .setMinValue(1),
    ),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || subscription.queue.length === 0) {
      await interaction.reply({
        embeds: [buildInfoEmbed('📭 The queue is empty.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const settings = interaction.guildId
      ? await guildSettingsRepo.getOrDefault(interaction.guildId)
      : null;
    if (
      isDjModeEnabled(settings?.djRoleId) &&
      !canForceControl(member, settings?.djRoleId, member?.voice.channel)
    ) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🎛️ Only **DJs** can remove tracks from the queue.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pos = interaction.options.getInteger('position', true);
    const idx = pos - 1; // 0-based
    const removed = subscription.remove(idx);
    if (!removed) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `❌ Invalid position ${pos}. Queue has ${subscription.queue.length} track(s).`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildInfoEmbed(`🗑️ Removed **${removed.title}** from position ${pos}.`)],
    });
  },
};
