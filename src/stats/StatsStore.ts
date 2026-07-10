import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Track } from '../core/types';

type CommandCounts = Record<string, number>;

export interface UserStats {
  plays: number;
  totalDurationSec: number;
  skips: number;
  wishlistAdds: number;
  commands: CommandCounts;
  lastActive?: string;
}

export interface TrackPlayStats {
  plays: number;
  title: string;
  lastPlayed?: string;
}

export interface GuildStats {
  totalPlays: number;
  totalDurationSec: number;
  totalSkips: number;
  totalWishlistAdds: number;
  commandUsage: CommandCounts;
  users: Record<string, UserStats>; // userId -> stats
  topTracks: Record<string, TrackPlayStats>; // key e.g. url or title|url
  _version?: number;
}

type StatsShape = Record<string, GuildStats>; // guildId -> GuildStats

const MAX_TOP_TRACKS = 50;
const MAX_USERS_PER_GUILD = 500;

/**
 * Per-guild stats store for numerous metrics (music, commands, wishlist).
 * JSON + atomic writes, modeled on SeenStore.
 */
export class StatsStore {
  private data: StatsShape = {};

  constructor(private readonly filePath: string) {}

  load(): void {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    try {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf8')) as StatsShape;
    } catch {
      this.data = {};
    }
  }

  private ensureGuild(guildId: string): GuildStats {
    if (!this.data[guildId]) {
      this.data[guildId] = {
        totalPlays: 0,
        totalDurationSec: 0,
        totalSkips: 0,
        totalWishlistAdds: 0,
        commandUsage: {},
        users: {},
        topTracks: {},
        _version: 1,
      };
    }
    return this.data[guildId];
  }

  private ensureUser(guild: GuildStats, userId: string): UserStats {
    if (!guild.users[userId]) {
      guild.users[userId] = {
        plays: 0,
        totalDurationSec: 0,
        skips: 0,
        wishlistAdds: 0,
        commands: {},
      };
    }
    return guild.users[userId];
  }

  recordPlay(guildId: string, userId: string, track: Track): void {
    const g = this.ensureGuild(guildId);
    const u = this.ensureUser(g, userId);

    g.totalPlays++;
    g.totalDurationSec += track.durationSec || 0;
    u.plays++;
    u.totalDurationSec += track.durationSec || 0;
    u.lastActive = new Date().toISOString();

    // top tracks (capped)
    const key = track.url || track.title;
    const t = g.topTracks[key] ?? { plays: 0, title: track.title };
    t.plays++;
    t.lastPlayed = new Date().toISOString();
    g.topTracks[key] = t;

    // prune top tracks
    const entries = Object.entries(g.topTracks);
    if (entries.length > MAX_TOP_TRACKS) {
      entries.sort((a, b) => b[1].plays - a[1].plays);
      g.topTracks = Object.fromEntries(entries.slice(0, MAX_TOP_TRACKS));
    }

    // prune users if needed
    const userEntries = Object.entries(g.users);
    if (userEntries.length > MAX_USERS_PER_GUILD) {
      // keep most active by plays
      userEntries.sort((a, b) => b[1].plays - a[1].plays);
      g.users = Object.fromEntries(userEntries.slice(0, MAX_USERS_PER_GUILD));
    }
  }

  recordSkip(guildId: string, userId: string): void {
    const g = this.ensureGuild(guildId);
    const u = this.ensureUser(g, userId);
    g.totalSkips++;
    u.skips++;
    u.lastActive = new Date().toISOString();
  }

  recordCommand(guildId: string, userId: string, cmd: string): void {
    const g = this.ensureGuild(guildId);
    const u = this.ensureUser(g, userId);
    g.commandUsage[cmd] = (g.commandUsage[cmd] ?? 0) + 1;
    u.commands[cmd] = (u.commands[cmd] ?? 0) + 1;
    u.lastActive = new Date().toISOString();
  }

  recordWishlistAdd(guildId: string, userId: string): void {
    const g = this.ensureGuild(guildId);
    const u = this.ensureUser(g, userId);
    g.totalWishlistAdds++;
    u.wishlistAdds++;
    u.lastActive = new Date().toISOString();
  }

  getGuild(guildId: string): GuildStats | undefined {
    return this.data[guildId];
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
