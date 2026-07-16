import { EmbedBuilder, type Client, type ColorResolvable } from 'discord.js';
import { config } from '../config';
import { GuildSettingsRepository } from '../db/repositories';
import { resolveGuildSendableChannel } from '../utils/guild-channel';

const repo = new GuildSettingsRepository();

export type GuildLogKind = 'config' | 'music' | 'error' | 'info';

const KIND_COLOR: Record<GuildLogKind, ColorResolvable> = {
  config: 0x5865f2,
  music: 0x57f287,
  error: 0xed4245,
  info: 0xfee75c,
};

/**
 * Post a short audit embed to **this guild's** configured log channel only.
 * Never posts to another server (channel must belong to `guildId`).
 * Failures are swallowed so logging never breaks the main bot path.
 */
export async function postGuildLog(
  client: Client,
  guildId: string | null | undefined,
  kind: GuildLogKind,
  title: string,
  description: string,
  actorTag?: string | null,
): Promise<void> {
  if (!guildId) return;

  try {
    const settings = await repo.getOrDefault(guildId);
    const channelId = settings.logChannelId;
    if (!channelId) return;

    // Strict multi-server guard: log channel must live in this guild.
    const channel = await resolveGuildSendableChannel(client, channelId, guildId);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(KIND_COLOR[kind] ?? config.embedColor)
      .setTitle(title.slice(0, 256))
      .setDescription(description.slice(0, 4096))
      .setTimestamp(new Date());

    if (actorTag) {
      embed.setFooter({ text: `By ${actorTag}`.slice(0, 2048) });
    }

    await channel.send({ embeds: [embed] });
  } catch {
    /* never throw from audit logging */
  }
}
