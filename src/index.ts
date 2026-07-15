import './config/env';
import { Cron } from 'croner';
import { Events } from 'discord.js';
import { startExpressStatsServer } from './api/express-stats';
import { startApiServer, takeDailySnapshot } from './api/server';
import { buildCommandCollection } from './commands';
import { config, DISCORD_TOKEN } from './config';
import { createClient } from './core/client';
import { logger } from './core/logger';
import { migrateFromJsonIfNeeded } from './db/migrate-from-json';
import { seedGuildSettingsFromConfig } from './db/seed-guild-settings-from-config';
import type { Services } from './core/types';
import { registerEvents } from './events';
import { MusicManager } from './music/MusicManager';
import { NewsService } from './news/NewsService';
import { SeenStore } from './news/SeenStore';
import { EpicService } from './epic/EpicService';
import { SteamDealService } from './steam/SteamDealService';
import { StatsStore } from './stats/StatsStore';
import { WishlistStore } from './wishlist/WishlistStore';

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  // Run one-time migration from old JSON files (seen.json, steam_seen.json, wishlists.json, stats.json)
  await migrateFromJsonIfNeeded();

  const seenStore = new SeenStore('data/seen.json', config.news.maxSeenIds);
  // Note: no .load() needed anymore — data comes from SQLite

  // Steam store is intentionally NOT seeded from disk on startup.
  // This preserves the original behavior where current feed items are always treated as new.
  const steamStore = new SeenStore('data/steam_seen.json', config.steam.maxSeenIds);

  const wishlistStore = new WishlistStore('data/wishlists.json');
  const statsStore = new StatsStore('data/stats.json');

  const services: Services = {
    config,
    logger,
    music: new MusicManager(config, logger, statsStore),
    news: new NewsService(client, seenStore, config, logger),
    stats: statsStore,
    wishlist: wishlistStore,
  };

  const steamService = new SteamDealService(client, steamStore, config, logger, wishlistStore);
  const epicService = new EpicService(client, config, logger);

  registerEvents(client, commands, services);

  // Website API (Phase 2/3a) — defaults to enabled on port 3847.
  // Set API_ENABLED=false to disable without removing other env vars.
  if (process.env.API_ENABLED !== 'false') {
    try {
      startApiServer({
        client,
        getConfig: () => config,
      });
    } catch (error) {
      logger.error('Failed to start Website API server (bot continues):', error);
    }
  } else {
    logger.info('Website API disabled (API_ENABLED=false).');
  }

  // Simple Express stats sidecar (serverCount / userCount / uptime) — port 3848.
  // Set EXPRESS_STATS_ENABLED=false to disable independently of the main API.
  if (process.env.EXPRESS_STATS_ENABLED !== 'false') {
    try {
      startExpressStatsServer({ client });
    } catch (error) {
      logger.error('Failed to start Express stats server (bot continues):', error);
    }
  } else {
    logger.info('Express stats API disabled (EXPRESS_STATS_ENABLED=false).');
  }

  // Poll news once the bot is ready, then on the configured schedule.
  client.once(Events.ClientReady, () => {
    // Map legacy config.json channel IDs into per-guild SQLite settings (non-destructive).
    void seedGuildSettingsFromConfig(client, config, logger).catch((error) =>
      logger.warn('Guild settings seed failed:', error),
    );

    const runPoll = (reason: string) =>
      void services.news
        .poll()
        .catch((error) => logger.error(`${reason} news poll failed:`, error));

    runPoll('Initial');
    new Cron(config.news.cron, () => runPoll('Scheduled'));
    logger.info(`News polling scheduled (cron "${config.news.cron}").`);

    const runSteamPoll = (reason: string) =>
      void steamService
        .poll()
        .catch((error) => logger.error(`${reason} Steam deals poll failed:`, error));

    runSteamPoll('Initial');
    new Cron(config.steam.cron, () => runSteamPoll('Scheduled'));
    logger.info(`Steam Daily Deals polling scheduled (cron "${config.steam.cron}").`);

    const runEpicPoll = (reason: string) =>
      void epicService
        .poll()
        .catch((error) => logger.error(`${reason} Epic free games poll failed:`, error));

    runEpicPoll('Initial');
    new Cron(config.epic.cron, () => runEpicPoll('Scheduled'));
    logger.info(`Epic free games polling scheduled (cron "${config.epic.cron}").`);

    // Daily public-stats snapshot at 00:05 UTC; also take one on ready if missing today.
    const runSnapshot = (reason: string) =>
      void takeDailySnapshot(client).catch((error) =>
        logger.error(`${reason} daily snapshot failed:`, error),
      );

    runSnapshot('Initial');
    new Cron('5 0 * * *', () => runSnapshot('Scheduled'));
    logger.info('Daily stats snapshot scheduled (cron "5 0 * * *" UTC).');

    const guildCount = client.guilds.cache.size;
    logger.info(
      `Multi-server ready: in ${guildCount} guild(s). ` +
        (config.discord.guildId
          ? `Commands are guild-scoped to ${config.discord.guildId} (set discord.guildId to null + npm run deploy for all servers).`
          : 'Commands are registered globally (all servers).'),
    );
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
