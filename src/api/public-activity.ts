import type { Client } from 'discord.js';
import type { MusicManager } from '../music/MusicManager';
import type { StatsStore } from '../stats/StatsStore';

const PLAY_THRESHOLDS = [10, 100, 1000, 10000, 50000, 100000] as const;
const SERVER_THRESHOLDS = [2, 5, 10, 25, 50, 100] as const;

export interface PublicActivityPayload {
  topTracks: { title: string; plays: number; durationSec?: number }[];
  nowPlaying: {
    title: string;
    artist: string;
    albumArtUrl: string | null;
    source?: string | null;
    durationSec?: number;
    positionSec?: number;
    remainingSec?: number | null;
    queueLength?: number;
    paused?: boolean;
    at?: string;
  } | null;
  recentCommands: { command: string; at: string }[];
  recentDeals: {
    source: 'steam' | 'epic' | 'other';
    title: string;
    subtitle: string;
  }[];
  milestones: { id: string; text: string; at: string }[];
  topServers: { name: string; plays: number }[];
}

/**
 * Build privacy-safe `public` block for GET /api/stats (Dzbanek Now wall).
 */
export async function buildPublicActivity(options: {
  client: Client;
  music?: MusicManager;
  stats: StatsStore;
}): Promise<PublicActivityPayload> {
  const { client, music, stats } = options;
  const nowIso = new Date().toISOString();

  const [topTracksRaw, topGuilds, totals] = await Promise.all([
    stats.getGlobalTopTracks(10),
    stats.getTopGuildsByPlays(8),
    stats.getGlobalAggregate(),
  ]);

  const topTracks = topTracksRaw.map((t) => ({
    title: t.title,
    plays: t.plays,
  }));

  const topServers = topGuilds.map((g, i) => {
    const guild = client.guilds.cache.get(g.guildId);
    // Prefer Discord name when bot is still in the guild; otherwise anonymize
    const name = guild?.name?.trim() || `Server #${i + 1}`;
    return { name, plays: g.plays };
  });

  const milestones: PublicActivityPayload['milestones'] = [];
  for (const th of PLAY_THRESHOLDS) {
    if (totals.totalPlays >= th) {
      milestones.push({
        id: `plays-${th}`,
        text: `Dzbanek-bot reached ${th.toLocaleString()} total tracks played!`,
        at: nowIso,
      });
    }
  }
  const serverCount = client.guilds.cache.size;
  for (const th of SERVER_THRESHOLDS) {
    if (serverCount >= th) {
      milestones.push({
        id: `servers-${th}`,
        text: `Dzbanek-bot is on ${th}+ Discord servers!`,
        at: nowIso,
      });
    }
  }

  return {
    topTracks,
    nowPlaying: music?.getPublicNowPlaying() ?? null,
    recentCommands: stats.getRecentCommands(12),
    recentDeals: stats.getRecentDeals(8).map((d) => ({
      source: d.source,
      title: d.title,
      subtitle: d.subtitle,
    })),
    milestones: milestones.slice(-12),
    topServers,
  };
}
