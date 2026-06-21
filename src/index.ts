import './config/env';
import { join } from 'node:path';
import { Cron } from 'croner';
import { Events } from 'discord.js';
import { buildCommandCollection } from './commands';
import { config, DISCORD_TOKEN } from './config';
import { createClient } from './core/client';
import { logger } from './core/logger';
import type { Services } from './core/types';
import { registerEvents } from './events';
import { MusicManager } from './music/MusicManager';
import { NewsService } from './news/NewsService';
import { SeenStore } from './news/SeenStore';
import { EpicService } from './epic/EpicService';
import { SteamDealService } from './steam/SteamDealService';

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  const seenStore = new SeenStore(join(process.cwd(), 'data', 'seen.json'), config.news.maxSeenIds);
  seenStore.load();

  // Steam store is intentionally NOT loaded from disk — the cache resets on
  // every startup so the current feed items are always treated as new and sent.
  // Deduplication still works within a single running session.
  const steamStore = new SeenStore(
    join(process.cwd(), 'data', 'steam_seen.json'),
    config.steam.maxSeenIds,
  );

  const services: Services = {
    config,
    logger,
    music: new MusicManager(config, logger),
    news: new NewsService(client, seenStore, config, logger),
  };

  const steamService = new SteamDealService(client, steamStore, config, logger);
  const epicService = new EpicService(client, config, logger);

  registerEvents(client, commands, services);

  // Poll news once the bot is ready, then on the configured schedule.
  client.once(Events.ClientReady, () => {
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
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
