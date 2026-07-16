import { Events, type Client } from 'discord.js';
import type { Services } from '../core/types';

export function registerMessageCreate(client: Client, services: Services): void {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!services.leveling) return;
      if (!message.guildId || !message.inGuild()) return;
      if (message.author.bot || message.webhookId) return;
      if (message.system) return;
      if (!message.content) return;

      const result = await services.leveling.tryAwardFromMessage(
        message.guildId,
        message.author.id,
        message.content,
      );
      if (!result) return;

      if (result.level > result.previousLevel) {
        const settings = await services.leveling.getSettings(message.guildId);
        await services.leveling.notifyLevelUp(
          message.guildId,
          message.author.id,
          result.level,
          settings.levelUpChannelId,
        );
      }
    } catch (error) {
      services.logger.error('MessageCreate leveling error:', error);
    }
  });
}
