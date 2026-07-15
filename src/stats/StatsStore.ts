import type { Track } from '../core/types';
import { StatsRepository, type GuildStatsData } from '../db/repositories';

// Re-export for compatibility with existing code that imports the types
export type {
  GuildStatsData as GuildStats,
  UserStatsData as UserStats,
  TrackPlayData as TrackPlayStats,
} from '../db/repositories';

/**
 * Stats store backed by SQLite via Prisma.
 * Maintains a similar public surface as the old JSON version.
 */
export class StatsStore {
  private readonly repo = new StatsRepository();

  // filePath ignored
  constructor(_filePath: string) {}

  load(): void {}

  async recordPlay(guildId: string, userId: string, track: Track): Promise<void> {
    await this.repo.recordPlay(guildId, userId, track);
  }

  async recordSkip(guildId: string, userId: string): Promise<void> {
    await this.repo.recordSkip(guildId, userId);
  }

  async recordCommand(guildId: string, userId: string, cmd: string): Promise<void> {
    await this.repo.recordCommand(guildId, userId, cmd);
  }

  async recordWishlistAdd(guildId: string, userId: string): Promise<void> {
    await this.repo.recordWishlistAdd(guildId, userId);
  }

  async getGuild(guildId: string): Promise<GuildStatsData | undefined> {
    return this.repo.getGuild(guildId);
  }

  save(): void {}
}
