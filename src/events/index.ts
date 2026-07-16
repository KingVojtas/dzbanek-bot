import type { Client, Collection } from 'discord.js';
import type { Command, Services } from '../core/types';
import { registerGuildMemberEvents } from './guildMembers';
import { registerInteractionCreate } from './interactionCreate';
import { registerMessageCreate } from './messageCreate';
import { registerReady } from './ready';

export function registerEvents(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  registerReady(client, services.logger);
  registerInteractionCreate(client, commands, services);
  registerGuildMemberEvents(client, services.config, services.logger);
  registerMessageCreate(client, services);
}
