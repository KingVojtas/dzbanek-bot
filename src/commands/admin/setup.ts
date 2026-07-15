import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import { GuildSettingsRepository } from '../../db/repositories';
import type { Command } from '../../core/types';

const repo = new GuildSettingsRepository();

function channelMention(id: string | null | undefined): string {
  return id ? `<#${id}>` : '_not set_';
}

function onOff(enabled: boolean): string {
  return enabled ? '✅ on' : '❌ off';
}

function isTextLike(channel: GuildBasedChannel): channel is TextChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.isTextBased()
  );
}

export const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure this server’s news, Steam deals, and Epic free games channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show multi-server settings for this guild'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('news')
        .setDescription('Set the channel for RSS news posts (enables news for this server)')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for news embeds')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('steam')
        .setDescription('Set the channel for Steam deal digests (enables Steam for this server)')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for Steam deals')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('epic')
        .setDescription('Set the channel for Epic free games (enables Epic for this server)')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for Epic free games')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Turn off a feed feature for this server')
        .addStringOption((opt) =>
          opt
            .setName('feature')
            .setDescription('Which feature to disable')
            .setRequired(true)
            .addChoices(
              { name: 'News', value: 'news' },
              { name: 'Steam deals', value: 'steam' },
              { name: 'Epic free games', value: 'epic' },
              { name: 'All of the above', value: 'all' },
            ),
        ),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId || !interaction.guild) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Extra guard (Discord also enforces default_member_permissions).
    const member = interaction.member;
    const canManage =
      member &&
      typeof member === 'object' &&
      'permissions' in member &&
      typeof member.permissions !== 'string' &&
      member.permissions.has(PermissionFlagsBits.ManageGuild);

    if (!canManage) {
      await interaction.reply({
        content: 'You need the **Manage Server** permission to change bot setup.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'status') {
      const s = await repo.getOrDefault(guildId);
      await interaction.reply({
        content: [
          `**⚙️ Setup for ${interaction.guild.name}**`,
          '',
          `📰 **News** — ${onOff(s.newsEnabled)} → ${channelMention(s.newsChannelId)}`,
          `🎮 **Steam deals** — ${onOff(s.steamEnabled)} → ${channelMention(s.steamChannelId)}`,
          `🎁 **Epic free games** — ${onOff(s.epicEnabled)} → ${channelMention(s.epicChannelId)}`,
          '',
          'Music, playlists, and stats work in every server automatically.',
          'Use `/setup news|steam|epic` to choose channels, or `/setup disable` to turn a feed off.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'disable') {
      const feature = interaction.options.getString('feature', true);
      const update =
        feature === 'all'
          ? {
              newsEnabled: false,
              steamEnabled: false,
              epicEnabled: false,
            }
          : feature === 'news'
            ? { newsEnabled: false }
            : feature === 'steam'
              ? { steamEnabled: false }
              : { epicEnabled: false };

      await repo.upsert(guildId, update, interaction.user.id);
      services.logger.info(
        `Setup: guild ${guildId} disabled ${feature} by ${interaction.user.id}`,
      );

      await interaction.reply({
        content:
          feature === 'all'
            ? '✅ Disabled **news**, **Steam**, and **Epic** posts for this server. Music still works.'
            : `✅ Disabled **${feature}** posts for this server.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // news | steam | epic — set channel + enable
    const channel = interaction.options.getChannel('channel', true);
    if (!channel || !('id' in channel)) {
      await interaction.reply({
        content: 'Invalid channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Resolve full channel from guild cache/API when needed
    const full =
      interaction.guild.channels.cache.get(channel.id) ??
      (await interaction.guild.channels.fetch(channel.id).catch(() => null));

    if (!full || !isTextLike(full)) {
      await interaction.reply({
        content: 'Pick a **text** or **announcement** channel the bot can post in.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const me = interaction.guild.members.me;
    if (me) {
      const perms = full.permissionsFor(me);
      if (perms && !perms.has(PermissionFlagsBits.SendMessages)) {
        await interaction.reply({
          content: `I can't send messages in ${full}. Give me **Send Messages** (and **Embed Links**) there.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const update =
      sub === 'news'
        ? { newsEnabled: true, newsChannelId: full.id }
        : sub === 'steam'
          ? { steamEnabled: true, steamChannelId: full.id }
          : { epicEnabled: true, epicChannelId: full.id };

    await repo.upsert(guildId, update, interaction.user.id);
    services.logger.info(
      `Setup: guild ${guildId} set ${sub} → #${full.id} by ${interaction.user.id}`,
    );

    const labels = { news: 'News', steam: 'Steam deals', epic: 'Epic free games' } as const;
    await interaction.reply({
      content: `✅ **${labels[sub as keyof typeof labels]}** will post in ${full}.\nCheck anytime with \`/setup status\`.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
