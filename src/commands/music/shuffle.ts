import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { canForceControl, isDjModeEnabled } from '../../music/dj';
import type { Command } from '../../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

export const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || subscription.queue.length < 2) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Not enough tracks in queue to shuffle.')],
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
        embeds: [buildInfoEmbed('🎛️ Only **DJs** can shuffle the queue.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const count = subscription.shuffle();
    const next = subscription.queue[0]?.title;
    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          `🔀 Shuffled **${count}** upcoming track${count === 1 ? '' : 's'}.` +
            (next ? `\nUp next: **${next.slice(0, 100)}**` : '') +
            `\nUse \`/queue\` to browse the new order.`,
        ),
      ],
    });
  },
};
