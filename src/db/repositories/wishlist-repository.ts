import { prisma } from '../client';

export class WishlistRepository {
  private readonly maxPerUser = 100;

  async get(userId: string): Promise<string[]> {
    const items = await prisma.wishlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { appId: true },
    });
    return items.map((i) => i.appId);
  }

  async add(userId: string, appIds: string[]): Promise<void> {
    if (appIds.length === 0) return;

    const existing = await this.get(userId);
    const toAdd = appIds.filter((id) => !existing.includes(id));

    if (toAdd.length === 0) return;

    for (const appId of toAdd) {
      await prisma.wishlistItem.upsert({
        where: { userId_appId: { userId, appId } },
        create: { userId, appId },
        update: {},
      });
    }

    // Enforce per-user cap
    const count = await prisma.wishlistItem.count({ where: { userId } });
    if (count > this.maxPerUser) {
      const excess = count - this.maxPerUser;
      const oldest = await prisma.wishlistItem.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        take: excess,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await prisma.wishlistItem.deleteMany({
          where: { id: { in: oldest.map((o) => o.id) } },
        });
      }
    }
  }

  async remove(userId: string, appId: string): Promise<boolean> {
    const result = await prisma.wishlistItem.deleteMany({
      where: { userId, appId },
    });
    return result.count > 0;
  }

  async getUsersForAppId(appId: string): Promise<string[]> {
    const items = await prisma.wishlistItem.findMany({
      where: { appId },
      select: { userId: true },
    });
    return items.map((i) => i.userId);
  }
}
