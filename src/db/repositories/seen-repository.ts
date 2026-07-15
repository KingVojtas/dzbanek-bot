import { prisma } from '../client';

export class SeenRepository {
  constructor(private readonly maxPerScope: number = 5000) {}

  async has(scope: string, itemId: string): Promise<boolean> {
    const count = await prisma.dedupEntry.count({
      where: { scope, itemId },
    });
    return count > 0;
  }

  async isEmpty(scope: string): Promise<boolean> {
    const count = await prisma.dedupEntry.count({
      where: { scope },
    });
    return count === 0;
  }

  async add(scope: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;

    // Insert (use upsert to be safe with unique constraint)
    for (const itemId of itemIds) {
      await prisma.dedupEntry.upsert({
        where: { scope_itemId: { scope, itemId } },
        create: { scope, itemId },
        update: {}, // no-op if exists
      });
    }

    // Enforce cap: keep only the most recent N
    const total = await prisma.dedupEntry.count({ where: { scope } });
    if (total > this.maxPerScope) {
      const toDelete = total - this.maxPerScope;
      const oldest = await prisma.dedupEntry.findMany({
        where: { scope },
        orderBy: { createdAt: 'asc' },
        take: toDelete,
        select: { id: true },
      });

      if (oldest.length > 0) {
        await prisma.dedupEntry.deleteMany({
          where: { id: { in: oldest.map((o) => o.id) } },
        });
      }
    }
  }

  /**
   * For steam dedup which intentionally starts fresh every restart.
   * We still support adding during the session.
   */
  async clearScope(scope: string): Promise<void> {
    await prisma.dedupEntry.deleteMany({ where: { scope } });
  }
}
