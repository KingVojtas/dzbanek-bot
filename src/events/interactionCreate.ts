import { Events, MessageFlags } from 'discord.js';
import type {
  Client,
  Collection,
  InteractionReplyOptions,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { buildInfoEmbed } from '../core/embeds';
import { resolveToAppIdOrName } from '../steam/SteamPriceApi';
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
          await services.stats.recordCommand(
            interaction.guildId,
            interaction.user.id,
            interaction.commandName,
          );
        }
      } catch (error) {
        services.logger.error(`Error executing /${interaction.commandName}:`, error);
        const payload: InteractionReplyOptions = {
          embeds: [buildInfoEmbed('❌ Something went wrong while running that command.')],
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
  const customId = interaction.customId;

  // Wishlist interactions (can happen anywhere, no music required)
  if (customId === 'wishlist:add' && interaction.isStringSelectMenu()) {
    if (!services.wishlist) {
      await interaction
        .reply({
          embeds: [buildInfoEmbed('Wishlist feature is not enabled.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    const rawValues = interaction.values;
    if (rawValues.length === 0) {
      await interaction
        .reply({
          embeds: [buildInfoEmbed('No games selected.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    try {
      // Automatically resolve every selected item to a real App ID if possible
      const resolvedValues = await Promise.all(rawValues.map((v) => resolveToAppIdOrName(v)));

      await services.wishlist.add(interaction.user.id, resolvedValues);

      if (services.stats && interaction.guildId) {
        await services.stats.recordWishlistAdd(interaction.guildId, interaction.user.id);
      }

      const count = resolvedValues.length;
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `✅ Added **${count}** game${count === 1 ? '' : 's'} to your wishlist.\nYou'll get a DM when better deals or sales appear for them.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      services.logger.error('Failed to add to wishlist via component:', error);
      await interaction
        .reply({
          embeds: [buildInfoEmbed('❌ Failed to add to wishlist.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  // Music controls require an active session in a guild
  if (!interaction.guildId) {
    await interaction
      .reply({
        embeds: [buildInfoEmbed('This control only works in servers.')],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const sub = services.music.get(interaction.guildId);
  if (!sub) {
    await interaction
      .reply({
        embeds: [buildInfoEmbed('🔇 No active music session in this server.')],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

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
      .reply({
        embeds: [buildInfoEmbed('Unknown control.')],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  } catch (error) {
    services.logger.error('Error handling music component:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          embeds: [buildInfoEmbed('❌ Action failed.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}
