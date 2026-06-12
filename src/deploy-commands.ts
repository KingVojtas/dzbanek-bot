import './config/env';
import { REST, Routes } from 'discord.js';
import { commandList } from './commands';
import { config, DISCORD_TOKEN } from './config';
import { logger } from './core/logger';

/**
 * Registers the slash commands with Discord. Guild-scoped registration (when a
 * guildId is configured) is instant; global registration can take up to an hour
 * to propagate.
 */
async function deploy(): Promise<void> {
  const body = commandList.map((command) => command.data.toJSON());
  const rest = new REST().setToken(DISCORD_TOKEN);

  const { clientId, guildId } = config.discord;
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  logger.info(
    guildId
      ? `Deploying ${body.length} command(s) to guild ${guildId}...`
      : `Deploying ${body.length} command(s) globally...`,
  );

  await rest.put(route, { body });
  logger.info('Slash commands deployed successfully.');
}

deploy().catch((error) => {
  logger.error('Failed to deploy commands:', error);
  process.exit(1);
});
