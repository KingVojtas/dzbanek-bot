import { Events } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { Client } from 'discord.js';
import type { Logger } from '../core/logger';

export function registerReady(client: Client, logger: Logger): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    // Info level so Railway/production logs show whether Opus/FFmpeg resolved.
    logger.info(`Voice dependency report:\n${generateDependencyReport()}`);
  });
}
