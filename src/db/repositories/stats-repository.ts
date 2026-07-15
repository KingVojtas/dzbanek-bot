import type { Track } from '../../core/types';
import { prisma } from '../client';

const MAX_TOP_TRACKS = 50;
const MAX_USERS_PER_GUILD = 500;

export interface UserStatsData {
  plays: number;
  totalDurationSec: number;
  skips: number;
  wishlistAdds: number;
  commands: Record<string, number>;
  lastActive?: string;
}

export interface TrackPlayData {
  plays: number;
  title: string;
  lastPlayed?: string;
}

export interface GuildStatsData {
  totalPlays: number;
  totalDurationSec: number;
  totalSkips: number;
  totalWishlistAdds: number;
  commandUsage: Record<string, number>;
  users: Record<string, UserStatsData>;
  topTracks: Record<string, TrackPlayData>;
}

export class StatsRepository {
  async recordPlay(guildId: string, userId: string, track: Track): Promise<void> {
    const duration = track.durationSec || 0;
    const now = new Date();

    // Update guild totals
    await prisma.guildStat.upsert({
      where: { guildId },
      create: {
        guildId,
        totalPlays: 1,
        totalDurationSec: duration,
        totalSkips: 0,
        totalWishlistAdds: 0,
      },
      update: {
        totalPlays: { increment: 1 },
        totalDurationSec: { increment: duration },
      },
    });

    // Update user stats
    await prisma.userStat.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: {
        guildId,
        userId,
        plays: 1,
        totalDurationSec: duration,
        skips: 0,
        wishlistAdds: 0,
        lastActive: now,
      },
      update: {
        plays: { increment: 1 },
        totalDurationSec: { increment: duration },
        lastActive: now,
      },
    });

    // Update track plays
    const trackKey = track.url || track.title;
    await prisma.trackPlay.upsert({
      where: { guildId_trackKey: { guildId, trackKey } },
      create: {
        guildId,
        trackKey,
        title: track.title,
        plays: 1,
        lastPlayed: now,
      },
      update: {
        plays: { increment: 1 },
        lastPlayed: now,
        title: track.title, // update title in case it changed
      },
    });

    // Prune top tracks if needed
    await this.pruneTopTracks(guildId);

    // Prune users if needed
    await this.pruneUsers(guildId);
  }

  async recordSkip(guildId: string, userId: string): Promise<void> {
    const now = new Date();

    await prisma.guildStat.upsert({
      where: { guildId },
      create: { guildId, totalSkips: 1 },
      update: { totalSkips: { increment: 1 } },
    });

    await prisma.userStat.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, skips: 1, lastActive: now },
      update: { skips: { increment: 1 }, lastActive: now },
    });
  }

  async recordCommand(guildId: string, userId: string, cmd: string): Promise<void> {
    const now = new Date();

    await prisma.commandCount.upsert({
      where: { guildId_userId_command: { guildId, userId, command: cmd } },
      create: { guildId, userId, command: cmd, count: 1 },
      update: { count: { increment: 1 } },
    });

    // Also touch user lastActive
    await prisma.userStat.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, lastActive: now },
      update: { lastActive: now },
    });
  }

  async recordWishlistAdd(guildId: string, userId: string): Promise<void> {
    const now = new Date();

    await prisma.guildStat.upsert({
      where: { guildId },
      create: { guildId, totalWishlistAdds: 1 },
      update: { totalWishlistAdds: { increment: 1 } },
    });

    await prisma.userStat.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, wishlistAdds: 1, lastActive: now },
      update: { wishlistAdds: { increment: 1 }, lastActive: now },
    });
  }

  async getGuild(guildId: string): Promise<GuildStatsData | undefined> {
    const guildStat = await prisma.guildStat.findUnique({ where: { guildId } });
    if (!guildStat) return undefined;

    const userStats = await prisma.userStat.findMany({ where: { guildId } });
    const commandCounts = await prisma.commandCount.findMany({ where: { guildId } });
    const trackPlays = await prisma.trackPlay.findMany({
      where: { guildId },
      orderBy: { plays: 'desc' },
      take: MAX_TOP_TRACKS,
    });

    const users: Record<string, UserStatsData> = {};
    for (const u of userStats) {
      const cmds: Record<string, number> = {};
      for (const c of commandCounts.filter((c) => c.userId === u.userId)) {
        cmds[c.command] = c.count;
      }
      users[u.userId] = {
        plays: u.plays,
        totalDurationSec: u.totalDurationSec,
        skips: u.skips,
        wishlistAdds: u.wishlistAdds,
        commands: cmds,
        lastActive: u.lastActive?.toISOString(),
      };
    }

    const topTracks: Record<string, TrackPlayData> = {};
    for (const t of trackPlays) {
      topTracks[t.trackKey] = {
        plays: t.plays,
        title: t.title,
        lastPlayed: t.lastPlayed?.toISOString(),
      };
    }

    // Build aggregate commandUsage for guild (optional, for backward compat)
    const commandUsage: Record<string, number> = {};
    for (const c of commandCounts) {
      commandUsage[c.command] = (commandUsage[c.command] ?? 0) + c.count;
    }

    return {
      totalPlays: guildStat.totalPlays,
      totalDurationSec: guildStat.totalDurationSec,
      totalSkips: guildStat.totalSkips,
      totalWishlistAdds: guildStat.totalWishlistAdds,
      commandUsage,
      users,
      topTracks,
    };
  }

  private async pruneTopTracks(guildId: string): Promise<void> {
    const count = await prisma.trackPlay.count({ where: { guildId } });
    if (count <= MAX_TOP_TRACKS) return;

    const excess = count - MAX_TOP_TRACKS;
    const oldest = await prisma.trackPlay.findMany({
      where: { guildId },
      orderBy: { plays: 'asc' },
      take: excess,
      select: { id: true },
    });

    if (oldest.length > 0) {
      await prisma.trackPlay.deleteMany({
        where: { id: { in: oldest.map((o) => o.id) } },
      });
    }
  }

  private async pruneUsers(guildId: string): Promise<void> {
    const count = await prisma.userStat.count({ where: { guildId } });
    if (count <= MAX_USERS_PER_GUILD) return;

    const excess = count - MAX_USERS_PER_GUILD;
    const leastActive = await prisma.userStat.findMany({
      where: { guildId },
      orderBy: { plays: 'asc' },
      take: excess,
      select: { id: true },
    });

    if (leastActive.length > 0) {
      await prisma.userStat.deleteMany({
        where: { id: { in: leastActive.map((u) => u.id) } },
      });
      // Also clean related command counts
      // (simplification: we leave orphaned command counts or clean in batches)
    }
  }
}
