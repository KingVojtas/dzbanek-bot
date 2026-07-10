import { Events, MessageFlags } from 'discord.js';
import type {
  Client,
  Collection,
  InteractionReplyOptions,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Command, Services } from '../core/types';

export function registerInteractionCreate(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction, services);
        if (services.stats && interaction.guildId) {
          services.stats.recordCommand(
            interaction.guildId,
            interaction.user.id,
            interaction.commandName,
          );
          services.stats.save();
        }
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
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await handleComponentInteraction(interaction, services).catch((err) => {
        services.logger.error('Component interaction error:', err);
      });
      return;
    }
  });
}

async function handleComponentInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction
      .reply({ content: 'Music controls only work in servers.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const sub = services.music.get(interaction.guildId);
  if (!sub) {
    await interaction
      .reply({
        content: '🔇 No active music session in this server.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const customId = interaction.customId;

  try {
    if (customId === 'music:pause' || customId === 'music:resume') {
      if (sub.paused) {
        sub.resume();
      } else {
        sub.pause();
      }
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:skip') {
      sub.skip();
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:stop') {
      sub.stop();
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:shuffle') {
      sub.shuffle();
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:loop') {
      const modes: ('off' | 'track' | 'queue')[] = ['off', 'track', 'queue'];
      const current = (sub.loopMode ?? 'off') as 'off' | 'track' | 'queue';
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length];
      sub.setLoopMode(next);
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    // Future: queue remove via select e.g. 'queue:remove:3'
    if (customId.startsWith('queue:remove:')) {
      const idxStr = customId.split(':')[2];
      const idx = parseInt(idxStr, 10);
      if (!Number.isNaN(idx)) sub.remove(idx);
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    await interaction
      .reply({ content: 'Unknown control.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
  } catch (error) {
    services.logger.error('Error handling music component:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '❌ Action failed.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}
