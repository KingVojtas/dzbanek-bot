import {
  Events,
  type Client,
  type GuildMember,
  type GuildTextBasedChannel,
  type PartialGuildMember,
} from 'discord.js';
import type { Config } from '../config';
import { buildGoodbyeEmbed, buildWelcomeEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import { GuildSettingsRepository } from '../db/repositories';

const guildSettings = new GuildSettingsRepository();

async function resolveGuildTextChannel(
  client: Client,
  channelId: string,
  expectedGuildId: string,
): Promise<GuildTextBasedChannel | null> {
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  // Never post a welcome/goodbye into a different guild (multi-server safety).
  if (!('guild' in channel) || channel.guild?.id !== expectedGuildId) return null;
  return channel as GuildTextBasedChannel;
}

function memberDisplay(member: GuildMember | PartialGuildMember): {
  userTag: string;
  userMention: string;
  displayName: string;
  avatarUrl: string | null;
  accountCreatedAt: Date | null;
} {
  const user = member.user;
  const id = member.id;
  const userTag = user?.tag ?? user?.username ?? id;
  const displayName = member.displayName || user?.globalName || user?.username || userTag;
  const avatarUrl =
    member.displayAvatarURL?.({ size: 256 }) ?? user?.displayAvatarURL?.({ size: 256 }) ?? null;
  const accountCreatedAt = user?.createdAt ?? null;

  return {
    userTag,
    userMention: `<@${id}>`,
    displayName,
    avatarUrl,
    accountCreatedAt,
  };
}

/** Replace {user}, {userTag}, {displayName}, {server}, {memberCount}. */
export function renderGreetingTemplate(
  template: string,
  ctx: {
    userMention: string;
    userTag: string;
    displayName: string;
    guildName: string;
    memberCount: number | null;
  },
): string {
  return template
    .replaceAll('{user}', ctx.userMention)
    .replaceAll('{userTag}', ctx.userTag)
    .replaceAll('{displayName}', ctx.displayName)
    .replaceAll('{server}', ctx.guildName)
    .replaceAll('{memberCount}', ctx.memberCount != null ? String(ctx.memberCount) : '?');
}

export function registerGuildMemberEvents(client: Client, config: Config, logger: Logger): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const info = memberDisplay(member);
      const memberCount = member.guild.memberCount ?? null;
      const ctx = {
        userMention: info.userMention,
        userTag: info.userTag,
        displayName: info.displayName,
        guildName: member.guild.name,
        memberCount,
      };

      const settings = await guildSettings.getOrDefault(member.guild.id);
      let channelId: string | null = null;
      let customMessage: string | null = null;

      if (settings.welcomeEnabled && settings.welcomeChannelId) {
        channelId = settings.welcomeChannelId;
        customMessage = settings.welcomeMessage;
      } else if (config.welcome.welcomeChannelId) {
        // Legacy config.json only applies to the guild that owns that channel.
        channelId = config.welcome.welcomeChannelId;
        customMessage = null;
      }

      if (!channelId) return;

      const channel = await resolveGuildTextChannel(client, channelId, member.guild.id);
      if (!channel) {
        // Wrong guild or missing channel — skip silently for multi-server.
        return;
      }

      const description = customMessage?.trim()
        ? renderGreetingTemplate(customMessage, ctx)
        : null;

      const embed = buildWelcomeEmbed({
        ...info,
        guildName: member.guild.name,
        memberCount,
        description,
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error(`Welcome: failed to post for ${member.id}:`, error);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      const info = memberDisplay(member);
      const memberCount = member.guild.memberCount ?? null;
      const ctx = {
        userMention: info.userMention,
        userTag: info.userTag,
        displayName: info.displayName,
        guildName: member.guild.name,
        memberCount,
      };

      const settings = await guildSettings.getOrDefault(member.guild.id);
      let channelId: string | null = null;
      let customMessage: string | null = null;

      if (settings.goodbyeEnabled && settings.goodbyeChannelId) {
        channelId = settings.goodbyeChannelId;
        customMessage = settings.goodbyeMessage;
      } else if (config.welcome.goodbyeChannelId) {
        channelId = config.welcome.goodbyeChannelId;
        customMessage = null;
      }

      if (!channelId) return;

      const channel = await resolveGuildTextChannel(client, channelId, member.guild.id);
      if (!channel) return;

      const description = customMessage?.trim()
        ? renderGreetingTemplate(customMessage, ctx)
        : null;

      const embed = buildGoodbyeEmbed({
        ...info,
        guildName: member.guild.name,
        memberCount,
        description,
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error(`Goodbye: failed to post for ${member.id}:`, error);
    }
  });
}
