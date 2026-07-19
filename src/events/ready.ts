import { Events } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { Client } from 'discord.js';
import { startBotPresence } from '../core/presence';
import type { Logger } from '../core/logger';
import type { MusicManager } from '../music/MusicManager';

export function registerReady(client: Client, logger: Logger, music?: MusicManager): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    // Info level so Railway/production logs show whether Opus/FFmpeg resolved.
    logger.info(`Voice dependency report:\n${generateDependencyReport()}`);

    startBotPresence(readyClient, logger, music);
    logger.info('Presence rotator started (now-playing + rotating status).');
  });
}
