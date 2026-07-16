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
import { LevelingService } from './leveling/LevelingService';
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
  const leveling = new LevelingService(client, logger);

  const services: Services = {
    config,
    logger,
    music: new MusicManager(config, logger, statsStore),
    news: new NewsService(client, seenStore, config, logger),
    stats: statsStore,
    wishlist: wishlistStore,
    leveling,
  };

  const steamService = new SteamDealService(
    client,
    steamStore,
    config,
    logger,
    wishlistStore,
    statsStore,
  );
  const epicService = new EpicService(client, logger, statsStore);

  registerEvents(client, commands, services);

  // Website API — /api/stats, /api/health, Discord OAuth admin (default :3848).
  // Set API_ENABLED=false to disable without removing other env vars.
  const apiEnabled = process.env.API_ENABLED !== 'false';
  const apiPort =
    Number.parseInt(process.env.API_PORT ?? process.env.PORT ?? '3848', 10) || 3848;
  if (apiEnabled) {
    try {
      startApiServer({
        client,
        getConfig: () => config,
        leveling,
        music: services.music,
        statsStore,
      });
    } catch (error) {
      logger.error('Failed to start Website API server (bot continues):', error);
    }
  } else {
    logger.info('Website API disabled (API_ENABLED=false).');
  }

  // Optional Express stats sidecar (simple JSON). Opt-in only — the main API already
  // serves /api/stats on :3848. Set EXPRESS_STATS_ENABLED=true and a free
  // EXPRESS_STATS_PORT if you still want a second listener.
  if (process.env.EXPRESS_STATS_ENABLED === 'true') {
    const expressPort = Number.parseInt(process.env.EXPRESS_STATS_PORT ?? '3849', 10) || 3849;
    if (apiEnabled && expressPort === apiPort) {
      logger.warn(
        `Express stats skipped: port ${expressPort} is already used by the Website API. Set EXPRESS_STATS_PORT to another port.`,
      );
    } else {
      try {
        startExpressStatsServer({ client });
      } catch (error) {
        logger.error('Failed to start Express stats server (bot continues):', error);
      }
    }
  }

  // Poll news once the bot is ready, then on the configured schedule.
  client.once(Events.ClientReady, () => {
    void (async () => {
      // Map legacy config.json channel IDs into per-guild SQLite settings first,
      // so multi-server Steam/news/epic targets exist before the initial poll.
      try {
        await seedGuildSettingsFromConfig(client, config, logger);
      } catch (error) {
        logger.warn('Guild settings seed failed:', error);
      }

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
            : 'Commands are registered globally (all servers). Steam/news/epic post per guild via website admin.'),
      );
    })();
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
