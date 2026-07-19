import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type Client,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type PartialGuildMember,
} from 'discord.js';
import { buildGoodbyeEmbed, buildWelcomeEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import { GuildSettingsRepository } from '../db/repositories';
import { parseRoleIds } from '../utils/digest-schedule';
import { resolveGuildSendableChannel } from '../utils/guild-channel';

const guildSettings = new GuildSettingsRepository();

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

export function registerGuildMemberEvents(client: Client, logger: Logger): void {
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

      // Per-guild only (website admin). Never fall back to another server's config.
      const settings = await guildSettings.getOrDefault(member.guild.id);
      if (!settings.welcomeEnabled || !settings.welcomeChannelId) return;

      const channel = await resolveGuildSendableChannel(
        client,
        settings.welcomeChannelId,
        member.guild.id,
      );
      if (!channel) return;

      const customMessage = settings.welcomeMessage;

      const description = customMessage?.trim() ? renderGreetingTemplate(customMessage, ctx) : null;

      const embed = buildWelcomeEmbed({
        ...info,
        guildName: member.guild.name,
        memberCount,
        description,
      });

      const roleIds = parseRoleIds(settings.welcomeRoleIds);
      const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
      if (roleIds.length > 0) {
        // Max 5 buttons per row, max 5 rows (25 roles)
        for (let i = 0; i < roleIds.length; i += 5) {
          const chunk = roleIds.slice(i, i + 5);
          const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
          for (const roleId of chunk) {
            const role = member.guild.roles.cache.get(roleId);
            if (!role || role.managed) continue;
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`welcome:role:${roleId}`)
                .setLabel(role.name.slice(0, 80))
                .setStyle(ButtonStyle.Secondary),
            );
          }
          if (row.components.length > 0) components.push(row);
        }
        if (components.length > 0) {
          const base = embed.data.footer?.text ?? info.userTag;
          embed.setFooter({ text: `${base} · pick a role below` });
        }
      }

      await channel.send({
        embeds: [embed],
        components: components.length > 0 ? components : undefined,
      });
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
      if (!settings.goodbyeEnabled || !settings.goodbyeChannelId) return;

      const channel = await resolveGuildSendableChannel(
        client,
        settings.goodbyeChannelId,
        member.guild.id,
      );
      if (!channel) return;

      const customMessage = settings.goodbyeMessage;
      const description = customMessage?.trim() ? renderGreetingTemplate(customMessage, ctx) : null;

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
