import type { Client, GuildBasedChannel, SendableChannels } from 'discord.js';

/**
 * Resolve a channel only if it exists, is sendable, and belongs to `expectedGuildId`.
 * Multi-server safety: never post to another guild's channel by ID alone.
 */
export async function resolveGuildSendableChannel(
  client: Client,
  channelId: string,
  expectedGuildId: string,
): Promise<SendableChannels | null> {
  try {
    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isSendable()) return null;
    if (channel.isDMBased()) return null;
    if (!('guildId' in channel) || channel.guildId !== expectedGuildId) return null;
    return channel;
  } catch {
    return null;
  }
}

/**
 * Ensure a channel ID (when non-null) is a text-like channel in `guildId`.
 * Throws a user-facing Error for the website API.
 */
export async function assertChannelBelongsToGuild(
  client: Client,
  channelId: string | null | undefined,
  guildId: string,
  label: string,
): Promise<void> {
  if (channelId == null || channelId === '') return;

  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));

  if (!channel) {
    throw new Error(`${label}: channel not found (bot may lack access).`);
  }
  if (channel.isDMBased()) {
    throw new Error(`${label}: must be a server channel, not a DM.`);
  }

  const chGuildId =
    'guildId' in channel && typeof channel.guildId === 'string'
      ? channel.guildId
      : 'guild' in channel &&
          channel.guild &&
          typeof (channel.guild as { id?: string }).id === 'string'
        ? (channel.guild as { id: string }).id
        : null;

  if (chGuildId !== guildId) {
    throw new Error(
      `${label}: channel is not in this server. Pick a channel from the selected server only.`,
    );
  }

  if (!channel.isTextBased()) {
    throw new Error(`${label}: pick a text or announcement channel.`);
  }
}

/** Best-effort guild id from a channel object. */
export function channelGuildId(channel: GuildBasedChannel | { guildId?: string }): string | null {
  if ('guildId' in channel && typeof channel.guildId === 'string') return channel.guildId;
  return null;
}
