import { Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { Config } from '../config';
import { buildGoodbyeEmbed, buildWelcomeEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';

async function resolveTextChannel(client: Client, channelId: string) {
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel;
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

export function registerGuildMemberEvents(client: Client, config: Config, logger: Logger): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    const channelId = config.welcome.welcomeChannelId;
    if (!channelId) return;

    try {
      const channel = await resolveTextChannel(client, channelId);
      if (!channel) {
        logger.warn(`Welcome: channel ${channelId} not found or not text-based.`);
        return;
      }

      const info = memberDisplay(member);
      const embed = buildWelcomeEmbed({
        ...info,
        guildName: member.guild.name,
        memberCount: member.guild.memberCount,
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error(`Welcome: failed to post for ${member.id}:`, error);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const channelId = config.welcome.goodbyeChannelId;
    if (!channelId) return;

    try {
      const channel = await resolveTextChannel(client, channelId);
      if (!channel) {
        logger.warn(`Goodbye: channel ${channelId} not found or not text-based.`);
        return;
      }

      const info = memberDisplay(member);
      const embed = buildGoodbyeEmbed({
        ...info,
        guildName: member.guild.name,
        memberCount: member.guild.memberCount,
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error(`Goodbye: failed to post for ${member.id}:`, error);
    }
  });
}
