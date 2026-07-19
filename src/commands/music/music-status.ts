import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const musicStatus: Command = {
  data: new SlashCommandBuilder()
    .setName('music-status')
    .setDescription('Show music session status (queue, volume, bridge/errors).'),

  async execute(interaction, services) {
    const sub = interaction.guildId ? services.music.get(interaction.guildId) : undefined;
    if (!sub) {
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            '🔇 No active music session in this server.\nUse `/play` in a voice channel to start one.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines: string[] = [];
    lines.push(
      sub.current
        ? `**Now playing:** ${sub.current.title.slice(0, 120)}`
        : '**Now playing:** nothing',
    );
    if (sub.queue[0]) {
      lines.push(`**Up next:** ${sub.queue[0].title.slice(0, 120)}`);
    }
    lines.push(`**Queue:** ${sub.queue.length} track(s)`);
    lines.push(`**Volume:** ${sub.volume}%`);
    lines.push(`**Loop:** ${sub.loopMode}`);
    lines.push(`**Paused:** ${sub.paused ? 'yes' : 'no'}`);
    lines.push(`**History:** ${sub.getHistoryLength()} track(s)`);
    lines.push(`**Announce channel:** ${sub.getAnnounceChannel() ? 'set' : 'not set'}`);

    const bridge = sub.getBridgeWarning();
    if (bridge) {
      lines.push('', `⚠️ **Bridge / stream:** ${bridge}`);
    } else if (sub.isBridgePaused()) {
      lines.push('', '⚠️ **Bridge:** queue paused after stream failures.');
    } else {
      lines.push('', '✅ **Bridge / stream:** no recent infrastructure errors.');
    }

    if (sub.lastError && !bridge) {
      lines.push(`**Last error:** ${sub.lastError.slice(0, 200)}`);
    }

    // Optional live probe of MUSIC_WORKER_URL (status only — non-blocking timeout)
    const workerBase = process.env.MUSIC_WORKER_URL?.trim();
    if (workerBase) {
      try {
        const endpoint = workerBase.replace(/\/$/, '');
        const url = endpoint.endsWith('/health') ? endpoint : `${endpoint}/health`;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2500);
        const res = await fetch(url, { method: 'GET', signal: ac.signal }).catch(async () => {
          // Some workers only expose /resolve — try base
          return fetch(endpoint, { method: 'GET', signal: ac.signal });
        });
        clearTimeout(t);
        lines.push(
          `**Worker URL:** reachable (HTTP ${res.status}) · \`${endpoint.slice(0, 60)}\``,
        );
      } catch {
        lines.push(
          `**Worker URL:** ❌ unreachable · \`${workerBase.slice(0, 60)}\` (is the home bridge up?)`,
        );
      }
    } else {
      lines.push('**Worker URL:** not configured (`MUSIC_WORKER_URL`)');
    }

    await interaction.reply({
      embeds: [buildInfoEmbed(lines.join('\n'), '🎵 Music status')],
      flags: MessageFlags.Ephemeral,
    });
  },
};
