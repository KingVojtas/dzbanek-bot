import type { Client } from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import { GuildSettingsRepository } from './repositories';

/**
 * One-shot-friendly seed: map legacy config.json channel IDs into GuildSettings
 * so the primary server keeps receiving posts after multi-server rollout.
 * Does not overwrite an existing row that already has that feature configured.
 */
export async function seedGuildSettingsFromConfig(
  client: Client,
  config: Config,
  logger: Logger,
): Promise<void> {
  const repo = new GuildSettingsRepository();

  type Feature = 'news' | 'steam' | 'epic' | 'welcome' | 'goodbye';
  const legacy: Array<{ feature: Feature; channelId: string | null }> = [
    { feature: 'news', channelId: config.news.channelId },
    { feature: 'steam', channelId: config.steam.channelId },
    { feature: 'epic', channelId: config.epic.channelId },
    { feature: 'welcome', channelId: config.welcome.welcomeChannelId },
    { feature: 'goodbye', channelId: config.welcome.goodbyeChannelId },
  ];

  for (const { feature, channelId } of legacy) {
    if (!channelId) continue;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('guildId' in channel) || !channel.guildId) {
        logger.warn(
          `Seed guild settings: ${feature} channel ${channelId} has no guild (skipping).`,
        );
        continue;
      }

      const guildId = channel.guildId;
      const existing = await repo.get(guildId);

      if (feature === 'news') {
        if (existing?.newsChannelId) continue;
        await repo.upsert(guildId, { newsEnabled: true, newsChannelId: channelId });
        logger.info(`Seeded news channel for guild ${guildId} → ${channelId}`);
      } else if (feature === 'steam') {
        if (existing?.steamChannelId) continue;
        await repo.upsert(guildId, { steamEnabled: true, steamChannelId: channelId });
        logger.info(`Seeded steam channel for guild ${guildId} → ${channelId}`);
      } else if (feature === 'epic') {
        if (existing?.epicChannelId) continue;
        await repo.upsert(guildId, { epicEnabled: true, epicChannelId: channelId });
        logger.info(`Seeded epic channel for guild ${guildId} → ${channelId}`);
      } else if (feature === 'welcome') {
        if (existing?.welcomeChannelId) continue;
        await repo.upsert(guildId, { welcomeEnabled: true, welcomeChannelId: channelId });
        logger.info(`Seeded welcome channel for guild ${guildId} → ${channelId}`);
      } else {
        if (existing?.goodbyeChannelId) continue;
        await repo.upsert(guildId, { goodbyeEnabled: true, goodbyeChannelId: channelId });
        logger.info(`Seeded goodbye channel for guild ${guildId} → ${channelId}`);
      }
    } catch (error) {
      logger.warn(`Seed guild settings failed for ${feature} (${channelId}):`, error);
    }
  }
}
