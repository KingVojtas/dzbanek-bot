import { Events, MessageFlags } from 'discord.js';
import type { Client, Collection, InteractionReplyOptions } from 'discord.js';
import type { Command, Services } from '../core/types';

export function registerInteractionCreate(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, services);
    } catch (error) {
      services.logger.error(`Error executing /${interaction.commandName}:`, error);
      const payload: InteractionReplyOptions = {
        content: '❌ Something went wrong while running that command.',
        flags: MessageFlags.Ephemeral,
      };
      const respond =
        interaction.deferred || interaction.replied
          ? interaction.followUp(payload)
          : interaction.reply(payload);
      await respond.catch(() => {});
    }
  });
}
