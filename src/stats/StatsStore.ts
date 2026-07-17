import type { Track } from '../core/types';
import { StatsRepository, type GuildStatsData } from '../db/repositories';

// Re-export for compatibility with existing code that imports the types
export type {
  GuildStatsData as GuildStats,
  UserStatsData as UserStats,
  TrackPlayData as TrackPlayStats,
} from '../db/repositories';

export interface RecentCommandEvent {
  command: string;
  at: string;
}

export interface RecentDealEvent {
  source: 'steam' | 'epic' | 'other';
  title: string;
  subtitle: string;
  at: string;
}

const MAX_RECENT_COMMANDS = 24;
const MAX_RECENT_DEALS = 12;

/**
 * Stats store backed by SQLite via Prisma.
 * Also keeps small in-memory rings for the public website live wall.
 */
export class StatsStore {
  private readonly repo = new StatsRepository();
  private readonly recentCommands: RecentCommandEvent[] = [];
  private readonly recentDeals: RecentDealEvent[] = [];

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

  /**
   * Public activity feed: recent slash commands (no user IDs).
   * Prefer full string from interactionCreate (e.g. `/play never gonna`).
   */
  pushRecentCommand(commandLine: string): void {
    const command = String(commandLine || '')
      .trim()
      .slice(0, 80);
    if (!command) return;
    const normalized = command.startsWith('/') ? command : `/${command}`;
    this.recentCommands.unshift({
      command: normalized,
      at: new Date().toISOString(),
    });
    if (this.recentCommands.length > MAX_RECENT_COMMANDS) {
      this.recentCommands.length = MAX_RECENT_COMMANDS;
    }
  }

  getRecentCommands(limit = 12): RecentCommandEvent[] {
    return this.recentCommands.slice(0, Math.min(Math.max(limit, 1), MAX_RECENT_COMMANDS));
  }

  pushRecentDeal(deal: Omit<RecentDealEvent, 'at'> & { at?: string }): void {
    const title = String(deal.title || '').trim();
    if (!title) return;
    const source =
      deal.source === 'epic' ? 'epic' : deal.source === 'steam' ? 'steam' : 'other';
    const entry: RecentDealEvent = {
      source,
      title: title.slice(0, 120),
      subtitle: String(deal.subtitle || '').trim().slice(0, 120),
      at: deal.at || new Date().toISOString(),
    };
    // Dedupe by source+title (case-insensitive) so re-polls refresh, not spam
    const key = source + '|' + entry.title.toLowerCase();
    const existing = this.recentDeals.findIndex(
      (d) => d.source + '|' + d.title.toLowerCase() === key,
    );
    if (existing >= 0) this.recentDeals.splice(existing, 1);
    this.recentDeals.unshift(entry);
    if (this.recentDeals.length > MAX_RECENT_DEALS) {
      this.recentDeals.length = MAX_RECENT_DEALS;
    }
  }

  /**
   * Replace all deals from one source (Steam or Epic pulse refresh).
   * Keeps the other source's entries. Call once per poll with the ranked list
   * even when Discord re-posts are skipped — so Deals Pulse isn't empty.
   */
  setDealsForSource(
    source: 'steam' | 'epic' | 'other',
    deals: { title: string; subtitle?: string }[],
  ): void {
    const kept = this.recentDeals.filter((d) => d.source !== source);
    const at = new Date().toISOString();
    const fresh: RecentDealEvent[] = [];
    const seen = Object.create(null) as Record<string, true>;
    for (const d of deals) {
      const title = String(d.title || '').trim().slice(0, 120);
      if (!title) continue;
      const k = title.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      fresh.push({
        source,
        title,
        subtitle: String(d.subtitle || '').trim().slice(0, 120),
        at,
      });
      if (fresh.length >= MAX_RECENT_DEALS) break;
    }
    // Prefer newest source batch first, then other pipeline
    this.recentDeals.length = 0;
    this.recentDeals.push(...fresh, ...kept);
    if (this.recentDeals.length > MAX_RECENT_DEALS) {
      this.recentDeals.length = MAX_RECENT_DEALS;
    }
  }

  getRecentDeals(limit = 8): RecentDealEvent[] {
    return this.recentDeals.slice(0, Math.min(Math.max(limit, 1), MAX_RECENT_DEALS));
  }

  async recordWishlistAdd(guildId: string, userId: string): Promise<void> {
    await this.repo.recordWishlistAdd(guildId, userId);
  }

  async getGuild(guildId: string): Promise<GuildStatsData | undefined> {
    return this.repo.getGuild(guildId);
  }

  async getGlobalAggregate() {
    return this.repo.getGlobalAggregate();
  }

  async getGlobalTopTracks(limit = 10) {
    return this.repo.getGlobalTopTracks(limit);
  }

  async getTopGuildsByPlays(limit = 10) {
    return this.repo.getTopGuildsByPlays(limit);
  }

  save(): void {}
}
