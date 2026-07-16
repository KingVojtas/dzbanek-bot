import { EmbedBuilder, type Client, type ColorResolvable } from 'discord.js';
import { config } from '../config';
import { GuildSettingsRepository } from '../db/repositories';

const repo = new GuildSettingsRepository();

export type GuildLogKind = 'config' | 'music' | 'error' | 'info';

const KIND_COLOR: Record<GuildLogKind, ColorResolvable> = {
  config: 0x5865f2,
  music: 0x57f287,
  error: 0xed4245,
  info: 0xfee75c,
};

/**
 * Post a short audit embed to the guild's configured log channel (if any).
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

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isSendable()) return;

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
