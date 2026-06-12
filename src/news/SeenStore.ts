import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type StoreShape = Record<string, string[]>;

/**
 * Persists the set of already-posted article ids per feed to a JSON file so the
 * bot never reposts the same article across restarts. Each feed's list is
 * capped to the most recent N ids to bound growth.
 */
export class SeenStore {
  private data: StoreShape = {};

  constructor(
    private readonly filePath: string,
    private readonly maxPerFeed: number,
  ) {}

  load(): void {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    try {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreShape;
    } catch {
      this.data = {};
    }
  }

  /** True if nothing has ever been recorded for this feed (i.e. first run). */
  isEmpty(feedUrl: string): boolean {
    return (this.data[feedUrl]?.length ?? 0) === 0;
  }

  has(feedUrl: string, id: string): boolean {
    return this.data[feedUrl]?.includes(id) ?? false;
  }

  add(feedUrl: string, ids: string[]): void {
    const merged = [...(this.data[feedUrl] ?? []), ...ids];
    this.data[feedUrl] = merged.slice(-this.maxPerFeed);
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.filePath); // atomic replace
  }
}
