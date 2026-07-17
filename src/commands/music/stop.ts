import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { GuildSettingsRepository } from '../../db/repositories';
import { canForceControl, isDjModeEnabled } from '../../music/dj';
import type { Command } from '../../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel.'),

  async execute(interaction, services) {
    const subscription = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!subscription) {
      await interaction.reply({
        embeds: [buildInfoEmbed('🔇 I am not playing anything.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const settings = interaction.guildId
      ? await guildSettingsRepo.getOrDefault(interaction.guildId)
      : null;
    const djRoleId = settings?.djRoleId ?? null;
    const voiceChannel = member?.voice.channel ?? null;

    if (isDjModeEnabled(djRoleId) && !canForceControl(member, djRoleId, voiceChannel)) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            '🎛️ Only **DJs** (or someone alone in the voice channel) can stop playback.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    subscription.stop();
    await interaction.reply({
      embeds: [buildInfoEmbed('⏹️ Stopped playback and left the voice channel.')],
    });
  },
};
