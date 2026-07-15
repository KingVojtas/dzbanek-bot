import './config/env';
import { REST, Routes } from 'discord.js';
import { commandList } from './commands';
import { config, DISCORD_TOKEN } from './config';
import { logger } from './core/logger';

/**
 * Registers the slash commands with Discord.
 *
 * - `discord.guildId` set → guild-only (instant; good for single-server dev).
 * - `discord.guildId` null → **global** (all servers; can take up to ~1 hour first time).
 *
 * For multi-server production, keep guildId null and run `npm run deploy`.
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
      ? `Deploying ${body.length} command(s) to guild ${guildId} only (single-server mode)...`
      : `Deploying ${body.length} command(s) globally (multi-server mode)...`,
  );

  await rest.put(route, { body });
  logger.info(
    guildId
      ? 'Slash commands deployed to one guild. Set discord.guildId to null for all servers.'
      : 'Slash commands deployed globally. They appear in every server that invites the bot.',
  );
}

deploy().catch((error) => {
  logger.error('Failed to deploy commands:', error);
  process.exit(1);
});
