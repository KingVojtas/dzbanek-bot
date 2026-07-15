import { prisma } from '../client';

export interface SnapshotData {
  date: string;
  servers: number;
  approxUsers: number;
  totalPlays: number;
  uniqueUsersTracked: number;
}

export class SnapshotRepository {
  /** UTC calendar date as YYYY-MM-DD. */
  static todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async hasSnapshot(date: string): Promise<boolean> {
    const row = await prisma.dailySnapshot.findUnique({
      where: { date },
      select: { date: true },
    });
    return row !== null;
  }

  async createSnapshot(data: SnapshotData): Promise<void> {
    await prisma.dailySnapshot.upsert({
      where: { date: data.date },
      create: {
        date: data.date,
        servers: data.servers,
        approxUsers: data.approxUsers,
        totalPlays: data.totalPlays,
        uniqueUsersTracked: data.uniqueUsersTracked,
      },
      update: {
        servers: data.servers,
        approxUsers: data.approxUsers,
        totalPlays: data.totalPlays,
        uniqueUsersTracked: data.uniqueUsersTracked,
      },
    });
  }

  async getHistory(limit = 90): Promise<SnapshotData[]> {
    const rows = await prisma.dailySnapshot.findMany({
      orderBy: { date: 'desc' },
      take: limit,
    });
    // Return chronological (oldest first) for charting
    return rows
      .map((r) => ({
        date: r.date,
        servers: r.servers,
        approxUsers: r.approxUsers,
        totalPlays: r.totalPlays,
        uniqueUsersTracked: r.uniqueUsersTracked,
      }))
      .reverse();
  }

  /** Delete snapshots older than `keepDays` (default 90). */
  async pruneOlderThan(keepDays = 90): Promise<number> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const result = await prisma.dailySnapshot.deleteMany({
      where: { date: { lt: cutoffDate } },
    });
    return result.count;
  }
}
