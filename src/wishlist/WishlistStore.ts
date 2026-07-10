import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type WishlistShape = Record<string, string[]>; // userId -> list of appIds (capped)

/**
 * Persists per-user Steam wishlist (app IDs) for deal alerts.
 * Modeled directly on SeenStore for atomicity and simplicity.
 */
export class WishlistStore {
  private data: WishlistShape = {};
  private readonly maxPerUser = 100; // reasonable cap

  constructor(private readonly filePath: string) {}

  load(): void {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    try {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf8')) as WishlistShape;
    } catch {
      this.data = {};
    }
  }

  get(userId: string): string[] {
    return [...(this.data[userId] ?? [])];
  }

  add(userId: string, appIds: string[]): void {
    const existing = this.data[userId] ?? [];
    const merged = [...existing, ...appIds.filter((id) => !existing.includes(id))];
    this.data[userId] = merged.slice(-this.maxPerUser);
  }

  remove(userId: string, appId: string): boolean {
    const list = this.data[userId];
    if (!list) return false;
    const idx = list.indexOf(appId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) delete this.data[userId];
    return true;
  }

  /** Returns userIds that have this appId in wishlist. */
  getUsersForAppId(appId: string): string[] {
    const users: string[] = [];
    for (const [uid, list] of Object.entries(this.data)) {
      if (list.includes(appId)) users.push(uid);
    }
    return users;
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
