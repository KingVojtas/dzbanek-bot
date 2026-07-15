import { WishlistRepository } from '../db/repositories';

/**
 * Wishlist store backed by SQLite (Prisma).
 * API kept similar to previous JSON implementation.
 */
export class WishlistStore {
  private readonly repo = new WishlistRepository();

  // filePath ignored for DB version
  constructor(_filePath: string) {}

  load(): void {}

  async get(userId: string): Promise<string[]> {
    return this.repo.get(userId);
  }

  async add(userId: string, appIds: string[]): Promise<void> {
    await this.repo.add(userId, appIds);
  }

  async remove(userId: string, appId: string): Promise<boolean> {
    return this.repo.remove(userId, appId);
  }

  async getUsersForAppId(appId: string): Promise<string[]> {
    return this.repo.getUsersForAppId(appId);
  }

  save(): void {}
}
