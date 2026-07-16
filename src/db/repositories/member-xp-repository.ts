import { prisma } from '../client';

export interface MemberXpRow {
  guildId: string;
  userId: string;
  xp: number;
  level: number;
  lastAwardAt: Date | null;
}

export interface AwardXpResult {
  guildId: string;
  userId: string;
  xp: number;
  level: number;
  previousLevel: number;
  amount: number;
}

export class MemberXpRepository {
  async get(guildId: string, userId: string): Promise<MemberXpRow | null> {
    const row = await prisma.memberXp.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    if (!row) return null;
    return {
      guildId: row.guildId,
      userId: row.userId,
      xp: row.xp,
      level: row.level,
      lastAwardAt: row.lastAwardAt,
    };
  }

  /**
   * Add XP and set denormalized level + lastAwardAt.
   * Caller computes the new level from total XP.
   */
  async addXp(
    guildId: string,
    userId: string,
    amount: number,
    newLevel: number,
    awardedAt: Date,
  ): Promise<AwardXpResult> {
    const existing = await this.get(guildId, userId);
    const previousLevel = existing?.level ?? 0;
    const nextXp = (existing?.xp ?? 0) + amount;

    const row = await prisma.memberXp.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: {
        guildId,
        userId,
        xp: nextXp,
        level: newLevel,
        lastAwardAt: awardedAt,
      },
      update: {
        xp: nextXp,
        level: newLevel,
        lastAwardAt: awardedAt,
      },
    });

    return {
      guildId: row.guildId,
      userId: row.userId,
      xp: row.xp,
      level: row.level,
      previousLevel,
      amount,
    };
  }

  async top(guildId: string, limit = 10): Promise<MemberXpRow[]> {
    const rows = await prisma.memberXp.findMany({
      where: { guildId },
      orderBy: [{ xp: 'desc' }, { level: 'desc' }],
      take: Math.min(Math.max(1, limit), 25),
    });
    return rows.map((row) => ({
      guildId: row.guildId,
      userId: row.userId,
      xp: row.xp,
      level: row.level,
      lastAwardAt: row.lastAwardAt,
    }));
  }

  /** 1-based rank among members with strictly more XP. */
  async rankOf(guildId: string, xp: number): Promise<number> {
    const higher = await prisma.memberXp.count({
      where: { guildId, xp: { gt: xp } },
    });
    return higher + 1;
  }

  async resetGuild(guildId: string): Promise<number> {
    const result = await prisma.memberXp.deleteMany({ where: { guildId } });
    return result.count;
  }
}
