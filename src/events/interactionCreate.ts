import {
  ContainerBuilder,
  DiscordAPIError,
  Events,
  GuildMember,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';
import type {
  Client,
  Collection,
  InteractionReplyOptions,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  buildMusicPlayerDisplay,
  buildQueueManageRows,
  buildQueuePageRow,
} from '../core/display';
import { buildInfoEmbed, buildQueueEmbed, queueTotalPages } from '../core/embeds';
import { GuildSettingsRepository } from '../db/repositories';
import { postGuildLog } from '../logging/GuildLog';
import type { GuildMusicSubscription } from '../music/GuildMusicSubscription';
import { VOLUME_STEP } from '../music/GuildMusicSubscription';
import { canForceControl, isDjModeEnabled, voteSkipThreshold } from '../music/dj';
import { resolveToAppIdOrName } from '../steam/SteamPriceApi';
import type { Command, Services } from '../core/types';

const guildSettingsRepo = new GuildSettingsRepository();

/** Discord error 10062 — interaction already answered or expired (often a 2nd bot process). */
function isUnknownInteraction(error: unknown): boolean {
  if (error instanceof DiscordAPIError && error.code === 10062) return true;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 10062
  ) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /unknown interaction/i.test(msg);
}

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
        // Do not await DB before execute — Discord requires a reply/defer within ~3s.
        // Music-disabled checks run inside the command after deferReply (see play/game/playlist).
        await command.execute(interaction, services);

        // Never let stats recording fail the command (would re-throw into the error path).
        if (services.stats && interaction.guildId) {
          try {
            await services.stats.recordCommand(
              interaction.guildId,
              interaction.user.id,
              interaction.commandName,
            );
            // Public live wall — no user IDs; include short option summary
            const optBits: string[] = [];
            try {
              for (const opt of interaction.options.data) {
                if (opt.value == null) continue;
                const v = String(opt.value);
                if (v.length > 40) optBits.push(v.slice(0, 37) + '…');
                else optBits.push(v);
              }
            } catch {
              /* ignore */
            }
            const line =
              `/${interaction.commandName}` +
              (optBits.length ? ' ' + optBits.slice(0, 3).join(' ') : '');
            services.stats.pushRecentCommand(line);
          } catch (statsErr) {
            services.logger.warn(`Failed to record /${interaction.commandName} stats:`, statsErr);
          }
        }
      } catch (error) {
        // Second bot instance / race: command often already succeeded on the other process.
        if (isUnknownInteraction(error)) {
          services.logger.warn(
            `/${interaction.commandName}: Unknown interaction (another bot process may already have answered, or the token expired).`,
          );
          return;
        }

        services.logger.error(`Error executing /${interaction.commandName}:`, error);
        const detail = error instanceof Error ? error.message : String(error ?? 'Unknown error');
        void postGuildLog(
          interaction.client,
          interaction.guildId,
          'error',
          'Command error',
          `\`/${interaction.commandName}\` failed.\n${detail}`,
          interaction.user.tag,
        );
        // Show the real reason (truncated) so users aren't stuck with a useless generic message.
        const userText =
          detail.length > 500
            ? `❌ **/${interaction.commandName}** failed.\n${detail.slice(0, 500)}…`
            : `❌ **/${interaction.commandName}** failed.\n${detail}`;
        const embeds = [buildInfoEmbed(userText)];
        try {
          if (interaction.deferred || interaction.replied) {
            // editReply cannot set Ephemeral; original defer/reply already fixed visibility.
            await interaction.editReply({ embeds }).catch(async () => {
              await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
            });
          } else {
            const payload: InteractionReplyOptions = {
              embeds,
              flags: MessageFlags.Ephemeral,
            };
            await interaction.reply(payload);
          }
        } catch {
          // Interaction may already be dead — ignore.
        }
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

  if (customId.startsWith('music:') || customId.startsWith('queue:')) {
    const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
    if (settings.musicEnabled === false) {
      await interaction
        .reply({
          embeds: [buildInfoEmbed('🎵 Music is disabled on this server.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
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
      await updateMusicPlayerMessage(interaction, sub);
      return;
    }

    if (customId === 'music:volume:up' || customId === 'music:volume:down') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can change volume.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      const delta = customId === 'music:volume:up' ? VOLUME_STEP : -VOLUME_STEP;
      const pct = sub.adjustVolume(delta);
      await updateMusicPlayerMessage(interaction, sub, { footer: `🔊 Volume ${pct}%` });
      return;
    }

    if (customId === 'music:previous') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can go to the previous track.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      const ok = sub.previous();
      if (!ok) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🔇 Nothing to go back to.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      // New track posts a fresh NP message and deletes this one — don't edit the old panel.
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:skip') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      const djRoleId = settings.djRoleId ?? null;
      const force = canForceControl(member, djRoleId, voiceChannel);
      const skipped = sub.current;

      if (!force && isDjModeEnabled(djRoleId) && skipped) {
        const result = sub.voteSkip(interaction.user.id, voteSkipThreshold(voiceChannel));
        if (!result.skipped) {
          await interaction
            .reply({
              embeds: [
                buildInfoEmbed(
                  result.alreadyVoted
                    ? `🗳️ You already voted. Skip votes: **${result.votes}/${result.needed}**`
                    : `🗳️ Skip vote: **${result.votes}/${result.needed}**`,
                ),
              ],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }
        void postGuildLog(
          interaction.client,
          interaction.guildId,
          'music',
          'Track skipped (vote)',
          `Vote-skipped **${skipped.title}** (button)`,
          interaction.user.tag,
        );
        // Fresh NP message replaces this panel
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      const next = sub.skip();
      if (skipped) {
        void postGuildLog(
          interaction.client,
          interaction.guildId,
          'music',
          'Track skipped',
          next
            ? `Skipped **${skipped.title}** (button)\nUp next: **${next.title}**`
            : `Skipped **${skipped.title}** (button)\nQueue empty.`,
          interaction.user.tag,
        );
      }
      // Next track publishes a new now-playing message and deletes this one
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId === 'music:stop') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can stop playback.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      sub.stop();
      const stopped = new ContainerBuilder()
        .setAccentColor(0x8b5cf6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('**Music Player**\n🔇 Playback stopped.'),
        );
      await interaction
        .update({
          components: [stopped],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(async () => {
          await interaction.deferUpdate().catch(() => {});
        });
      return;
    }

    if (customId === 'music:shuffle') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can shuffle the queue.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      if (sub.queue.length < 2) {
        await interaction
          .reply({
            embeds: [
              buildInfoEmbed(
                '🔀 Need at least **2** upcoming tracks to shuffle.\n' +
                  'Add more songs (or play an album/playlist), then try again.',
              ),
            ],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      const count = sub.shuffle();
      const nextTitle = sub.queue[0]?.title;
      await updateMusicPlayerMessage(interaction, sub, {
        footer: nextTitle
          ? `🔀 Shuffled ${count} tracks · next: ${nextTitle.slice(0, 60)}`
          : `🔀 Shuffled ${count} tracks`,
      });
      await interaction
        .followUp({
          embeds: [
            buildInfoEmbed(
              `🔀 Shuffled **${count}** upcoming track${count === 1 ? '' : 's'}.` +
                (nextTitle ? `\nUp next: **${nextTitle.slice(0, 100)}**` : '') +
                `\nUse \`/queue\` to see the full order.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    if (customId === 'music:loop') {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can change loop mode.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      const modes: ('off' | 'track' | 'queue')[] = ['off', 'track', 'queue'];
      const current = (sub.loopMode ?? 'off') as 'off' | 'track' | 'queue';
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length];
      sub.setLoopMode(next);
      await updateMusicPlayerMessage(interaction, sub);
      return;
    }

    // /queue manage selects: queue:rm:<page> | queue:pn:<page> (value = 0-based index)
    if (
      (customId.startsWith('queue:rm:') || customId.startsWith('queue:pn:')) &&
      interaction.isStringSelectMenu()
    ) {
      const settings = await guildSettingsRepo.getOrDefault(interaction.guildId);
      const member = interaction.member instanceof GuildMember ? interaction.member : null;
      const voiceChannel = member?.voice.channel ?? null;
      if (
        isDjModeEnabled(settings.djRoleId) &&
        !canForceControl(member, settings.djRoleId, voiceChannel)
      ) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('🎛️ Only **DJs** can edit the queue.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      const pageFromId = parseInt(customId.split(':')[2] ?? '0', 10);
      const idx = parseInt(interaction.values[0] ?? '', 10);
      if (Number.isNaN(idx)) {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (customId.startsWith('queue:rm:')) {
        const removed = sub.remove(idx);
        if (!removed) {
          await interaction
            .reply({
              embeds: [buildInfoEmbed('❌ That track is no longer in the queue.')],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }
        const totalPages = queueTotalPages(sub.queue.length);
        const safePage = Math.min(Math.max(0, pageFromId), totalPages - 1);
        await interaction
          .update({
            embeds: [buildQueueEmbed(sub.current, sub.queue, safePage)],
            components: buildQueueComponents(safePage, sub),
          })
          .catch(async () => {
            await interaction.deferUpdate().catch(() => {});
          });
        await interaction
          .followUp({
            embeds: [buildInfoEmbed(`🗑️ Removed **${removed.title.slice(0, 100)}**.`)],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      // play next
      const moved = sub.moveToPlayNext(idx);
      if (!moved) {
        await interaction
          .reply({
            embeds: [buildInfoEmbed('❌ That track is no longer in the queue.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }
      const totalPages = queueTotalPages(sub.queue.length);
      const safePage = Math.min(Math.max(0, pageFromId), totalPages - 1);
      await interaction
        .update({
          embeds: [buildQueueEmbed(sub.current, sub.queue, safePage)],
          components: buildQueueComponents(safePage, sub),
        })
        .catch(async () => {
          await interaction.deferUpdate().catch(() => {});
        });
      await interaction
        .followUp({
          embeds: [buildInfoEmbed(`⏭️ **${moved.title.slice(0, 100)}** will play next.`)],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    // Legacy custom id
    if (customId.startsWith('queue:remove:')) {
      const idxStr = customId.split(':')[2];
      const idx = parseInt(idxStr, 10);
      if (!Number.isNaN(idx)) sub.remove(idx);
      await updateMusicPlayerMessage(interaction, sub);
      return;
    }

    // /queue pagination + refresh (`queue:page:N` | `queue:refresh:N` | `queue:noop`)
    if (customId === 'queue:noop') {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (customId.startsWith('queue:page:') || customId.startsWith('queue:refresh:')) {
      const parsed = parseInt(customId.split(':')[2] ?? '0', 10);
      const page = Number.isFinite(parsed) ? parsed : 0;
      const totalPages = queueTotalPages(sub.queue.length);
      const safePage = Math.min(Math.max(0, page), totalPages - 1);

      if (!sub.current && sub.queue.length === 0) {
        await interaction
          .update({
            embeds: [buildInfoEmbed('📭 The queue is empty.')],
            components: [],
          })
          .catch(async () => {
            await interaction.deferUpdate().catch(() => {});
          });
        return;
      }

      await interaction
        .update({
          embeds: [buildQueueEmbed(sub.current, sub.queue, safePage)],
          components: buildQueueComponents(safePage, sub),
        })
        .catch(async () => {
          await interaction.deferUpdate().catch(() => {});
        });
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

function buildQueueComponents(page: number, sub: GuildMusicSubscription) {
  const rows = [buildQueuePageRow(page, sub.queue.length)];
  if (sub.queue.length > 0) {
    rows.push(...buildQueueManageRows(page, sub.queue));
  }
  return rows;
}

/** Refresh the Components V2 music player message after a control action. */
async function updateMusicPlayerMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sub: GuildMusicSubscription,
  extras?: { footer?: string },
): Promise<void> {
  const track = sub.current;
  if (!track) {
    const warning = sub.getBridgeWarning();
    const empty = new ContainerBuilder()
      .setAccentColor(0x8b5cf6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          warning
            ? `**Music Player**\n⚠️ ${warning}`
            : '**Music Player**\n🔇 Nothing is playing right now.',
        ),
      );
    await interaction
      .update({
        components: [empty],
        flags: MessageFlags.IsComponentsV2,
      })
      .catch(async () => {
        await interaction.deferUpdate().catch(() => {});
      });
    sub.setNowPlayingMessage(null);
    return;
  }

  const display = buildMusicPlayerDisplay({
    track,
    positionSec: sub.getPlaybackPositionSec(),
    queueLength: sub.queue.length,
    paused: sub.paused,
    loopMode: sub.loopMode,
    label: sub.paused ? 'Paused' : 'Now Playing',
    upNextTitle: sub.queue[0]?.title ?? null,
    shuffleHighlight: sub.wasShuffledRecently(),
    volumePct: sub.volume,
    bridgeWarning: sub.getBridgeWarning(),
    footer: extras?.footer,
  });

  try {
    await interaction.update({
      components: display.components,
      flags: display.flags,
    });
    // Keep live progress attached to this panel
    sub.setNowPlayingMessage(interaction.message);
  } catch {
    await interaction.deferUpdate().catch(() => {});
    // Still attach so the 1s ticker can edit the message
    sub.setNowPlayingMessage(interaction.message);
  }
}
