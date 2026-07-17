import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { postGuildLog } from '../../logging/GuildLog';
import { canForceControl, isDjModeEnabled, voteSkipThreshold } from '../../music/dj';
import type { Command } from '../../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

export const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track (or vote to skip when DJ mode is on).'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription || !subscription.current) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 Nothing is playing to skip.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const skipped = subscription.current;
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const settings = interaction.guildId
      ? await guildSettingsRepo.getOrDefault(interaction.guildId)
      : null;
    const djRoleId = settings?.djRoleId ?? null;
    const voiceChannel = member?.voice.channel ?? null;
    const force = canForceControl(member, djRoleId, voiceChannel);

    if (!force && isDjModeEnabled(djRoleId)) {
      const needed = voteSkipThreshold(voiceChannel);
      const result = subscription.voteSkip(interaction.user.id, needed);
      if (!result.skipped) {
        const msg = result.alreadyVoted
          ? `🗳️ You already voted. Skip votes: **${result.votes}/${result.needed}**`
          : `🗳️ Skip vote recorded: **${result.votes}/${result.needed}**`;
        await interaction.reply({ embeds: [buildInfoEmbed(msg)] });
        return;
      }

      if (services.stats && interaction.guildId) {
        await services.stats.recordSkip(interaction.guildId, interaction.user.id);
      }
      void postGuildLog(
        interaction.client,
        interaction.guildId,
        'music',
        'Track skipped (vote)',
        `Vote-skipped **${skipped.title}** (${result.votes}/${result.needed})`,
        interaction.user.tag,
      );
      await interaction.reply({
        embeds: [buildInfoEmbed(`⏭️ Vote passed — skipped **${skipped.title}**.`)],
      });
      return;
    }

    const next = subscription.skip();

    if (services.stats && interaction.guildId) {
      await services.stats.recordSkip(interaction.guildId, interaction.user.id);
    }

    void postGuildLog(
      interaction.client,
      interaction.guildId,
      'music',
      'Track skipped',
      next
        ? `Skipped **${skipped.title}**\nUp next: **${next.title}**`
        : `Skipped **${skipped.title}**\nQueue is now empty.`,
      interaction.user.tag,
    );

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          next
            ? `⏭️ Skipped **${skipped.title}**.\nUp next: **${next.title}**`
            : `⏭️ Skipped **${skipped.title}**.\nQueue is empty.`,
        ),
      ],
    });
  },
};
