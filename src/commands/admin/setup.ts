import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import { GuildSettingsRepository, type GuildSettingsUpdate } from '../../db/repositories';
import type { Command } from '../../core/types';
import { postGuildLog } from '../../logging/GuildLog';

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

const CHANNEL_SUBS = new Set([
  'news',
  'steam',
  'epic',
  'welcome',
  'goodbye',
  'leveling',
  'log',
]);

export const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure this server (multi-server: each guild has its own settings).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show all settings for this server'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('news')
        .setDescription('Set the channel for RSS news posts')
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
        .setDescription('Set the channel for Steam deal digests')
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
        .setDescription('Set the channel for Epic free games')
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
        .setName('welcome')
        .setDescription('Set the welcome (join) channel for this server')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for welcome embeds')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('goodbye')
        .setDescription('Set the goodbye (leave) channel for this server')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for goodbye embeds')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('leveling')
        .setDescription('Enable chat XP leveling and set the level-up channel')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for level-up notifications (optional)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('log')
        .setDescription('Set the audit/activity log channel for this server')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel for bot audit embeds')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('music')
        .setDescription('Enable or disable music commands in this server')
        .addBooleanOption((opt) =>
          opt.setName('enabled').setDescription('Allow /play and other music commands').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Turn off a feature for this server only')
        .addStringOption((opt) =>
          opt
            .setName('feature')
            .setDescription('Which feature to disable')
            .setRequired(true)
            .addChoices(
              { name: 'News', value: 'news' },
              { name: 'Steam deals', value: 'steam' },
              { name: 'Epic free games', value: 'epic' },
              { name: 'Welcome messages', value: 'welcome' },
              { name: 'Goodbye messages', value: 'goodbye' },
              { name: 'Leveling / XP', value: 'leveling' },
              { name: 'Audit log channel', value: 'log' },
              { name: 'All feeds + greetings + leveling', value: 'all' },
            ),
        ),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId || !interaction.guild) {
      await interaction.reply({
        embeds: [buildInfoEmbed('This command only works inside a server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = interaction.member;
    const canManage =
      member &&
      typeof member === 'object' &&
      'permissions' in member &&
      typeof member.permissions !== 'string' &&
      member.permissions.has(PermissionFlagsBits.ManageGuild);

    if (!canManage) {
      await interaction.reply({
        embeds: [buildInfoEmbed('You need the **Manage Server** permission to change bot setup.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'status') {
      const s = await repo.getOrDefault(guildId);
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            [
              `_Settings for **this server only** (multi-server safe)._`,
              '',
              `📰 **News** — ${onOff(s.newsEnabled)} → ${channelMention(s.newsChannelId)}`,
              `🎮 **Steam deals** — ${onOff(s.steamEnabled)} → ${channelMention(s.steamChannelId)}`,
              `🎁 **Epic free games** — ${onOff(s.epicEnabled)} → ${channelMention(s.epicChannelId)}`,
              `👋 **Welcome** — ${onOff(s.welcomeEnabled)} → ${channelMention(s.welcomeChannelId)}`,
              `🚪 **Goodbye** — ${onOff(s.goodbyeEnabled)} → ${channelMention(s.goodbyeChannelId)}`,
              `🏅 **Leveling** — ${onOff(s.levelingEnabled === true)} → level-ups ${channelMention(s.levelUpChannelId)}`,
              `🎵 **Music** — ${onOff(s.musicEnabled !== false)}`,
              `📋 **Audit log** — ${channelMention(s.logChannelId)}`,
              '',
              'Music / playlists / stats / XP ranks are per-server automatically.',
              'Web admin: same settings + filters for each guild you manage.',
            ].join('\n'),
            `⚙️ Setup for ${interaction.guild.name}`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'music') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await repo.upsert(guildId, { musicEnabled: enabled }, interaction.user.id);
      void postGuildLog(
        interaction.client,
        guildId,
        'config',
        'Music toggled',
        `Music commands ${enabled ? 'enabled' : 'disabled'} via \`/setup music\`.`,
        interaction.user.tag,
      );
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            enabled
              ? '✅ Music commands are **enabled** in this server.'
              : '✅ Music commands are **disabled** in this server.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'disable') {
      const feature = interaction.options.getString('feature', true);
      let update: GuildSettingsUpdate;
      if (feature === 'all') {
        update = {
          newsEnabled: false,
          steamEnabled: false,
          epicEnabled: false,
          welcomeEnabled: false,
          goodbyeEnabled: false,
          levelingEnabled: false,
          logChannelId: null,
        };
      } else if (feature === 'news') {
        update = { newsEnabled: false };
      } else if (feature === 'steam') {
        update = { steamEnabled: false };
      } else if (feature === 'epic') {
        update = { epicEnabled: false };
      } else if (feature === 'welcome') {
        update = { welcomeEnabled: false };
      } else if (feature === 'goodbye') {
        update = { goodbyeEnabled: false };
      } else if (feature === 'leveling') {
        update = { levelingEnabled: false };
      } else {
        update = { logChannelId: null };
      }

      await repo.upsert(guildId, update, interaction.user.id);
      services.logger.info(`Setup: guild ${guildId} disabled ${feature} by ${interaction.user.id}`);
      void postGuildLog(
        interaction.client,
        guildId,
        'config',
        'Setup disable',
        `Disabled **${feature}** via \`/setup disable\`.`,
        interaction.user.tag,
      );

      await interaction.reply({
        embeds: [buildInfoEmbed(`✅ Disabled **${feature}** for this server.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'leveling') {
      const channelOpt = interaction.options.getChannel('channel');
      let levelUpChannelId: string | null = null;

      if (channelOpt && 'id' in channelOpt) {
        const full =
          interaction.guild.channels.cache.get(channelOpt.id) ??
          (await interaction.guild.channels.fetch(channelOpt.id).catch(() => null));
        if (!full || !isTextLike(full)) {
          await interaction.reply({
            embeds: [buildInfoEmbed('Pick a **text** or **announcement** channel.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        levelUpChannelId = full.id;
      }

      await repo.upsert(
        guildId,
        {
          levelingEnabled: true,
          ...(levelUpChannelId ? { levelUpChannelId } : {}),
        },
        interaction.user.id,
      );
      services.leveling?.invalidateSettingsCache(guildId);

      void postGuildLog(
        interaction.client,
        guildId,
        'config',
        'Leveling enabled',
        levelUpChannelId
          ? `Chat XP on · level-ups → <#${levelUpChannelId}>`
          : 'Chat XP on (no level-up channel set).',
        interaction.user.tag,
      );

      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            levelUpChannelId
              ? `✅ Leveling **enabled**. Level-ups post in <#${levelUpChannelId}>.\nMembers: \`/rank\` · \`/leaderboard\``
              : '✅ Leveling **enabled**. Optionally set a level-up channel with `/setup leveling channel:#…`.\nMembers: `/rank` · `/leaderboard`',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!CHANNEL_SUBS.has(sub)) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Unknown setup subcommand.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    if (!channel || !('id' in channel)) {
      await interaction.reply({
        embeds: [buildInfoEmbed('Invalid channel.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const full =
      interaction.guild.channels.cache.get(channel.id) ??
      (await interaction.guild.channels.fetch(channel.id).catch(() => null));

    if (!full || !isTextLike(full)) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed('Pick a **text** or **announcement** channel the bot can post in.'),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const me = interaction.guild.members.me;
    if (me) {
      const perms = full.permissionsFor(me);
      if (perms && !perms.has(PermissionFlagsBits.SendMessages)) {
        await interaction.reply({
          embeds: [
            buildInfoEmbed(
              `I can't send messages in ${full}. Give me **Send Messages** (and **Embed Links**) there.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const update: GuildSettingsUpdate =
      sub === 'news'
        ? { newsEnabled: true, newsChannelId: full.id }
        : sub === 'steam'
          ? { steamEnabled: true, steamChannelId: full.id }
          : sub === 'epic'
            ? { epicEnabled: true, epicChannelId: full.id }
            : sub === 'welcome'
              ? { welcomeEnabled: true, welcomeChannelId: full.id }
              : sub === 'goodbye'
                ? { goodbyeEnabled: true, goodbyeChannelId: full.id }
                : sub === 'leveling'
                  ? { levelingEnabled: true, levelUpChannelId: full.id }
                  : { logChannelId: full.id };

    await repo.upsert(guildId, update, interaction.user.id);
    if (sub === 'leveling') services.leveling?.invalidateSettingsCache(guildId);

    services.logger.info(
      `Setup: guild ${guildId} set ${sub} → #${full.id} by ${interaction.user.id}`,
    );

    const labels: Record<string, string> = {
      news: 'News',
      steam: 'Steam deals',
      epic: 'Epic free games',
      welcome: 'Welcome',
      goodbye: 'Goodbye',
      leveling: 'Level-up notifications',
      log: 'Audit log',
    };

    void postGuildLog(
      interaction.client,
      guildId,
      'config',
      'Setup channel',
      `**${labels[sub] ?? sub}** → ${full}`,
      interaction.user.tag,
    );

    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          `✅ **${labels[sub] ?? sub}** will use ${full} **in this server**.\nCheck anytime with \`/setup status\`.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
