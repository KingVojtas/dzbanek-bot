import { SeenRepository } from '../db/repositories';

/**
 * Deduplication store backed by SQLite via Prisma.
 * Keeps the same public API as the previous JSON version for minimal disruption.
 */
export class SeenStore {
  private readonly repo: SeenRepository;

  constructor(
    // filePath kept for backward compat in constructor calls, but ignored
    _filePath: string,
    _maxPerFeed: number,
  ) {
    this.repo = new SeenRepository();
  }

  // No-op for compatibility (data is loaded on-demand from DB)
  load(): void {}

  /** True if nothing has ever been recorded for this scope (i.e. first run for this feed). */
  async isEmpty(scope: string): Promise<boolean> {
    return this.repo.isEmpty(scope);
  }

  async has(scope: string, id: string): Promise<boolean> {
    return this.repo.has(scope, id);
  }

  async add(scope: string, ids: string[]): Promise<void> {
    await this.repo.add(scope, ids);
  }

  // No-op - Prisma handles persistence immediately
  save(): void {}
}
