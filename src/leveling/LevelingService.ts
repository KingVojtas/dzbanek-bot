import type { Client } from 'discord.js';
import { buildLevelUpEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import {
  GuildSettingsRepository,
  MemberXpRepository,
  type AwardXpResult,
  type MemberXpRow,
} from '../db/repositories';
import { isMessageEligible, levelFromTotalXp, progressInLevel, xpForMessage } from './formulas';

const SETTINGS_TTL_MS = 45_000;
const DEFAULT_COOLDOWN_SEC = 60;

interface CachedLevelingSettings {
  enabled: boolean;
  levelUpChannelId: string | null;
  cooldownSec: number;
  expiresAt: number;
}

export class LevelingService {
  private readonly repo = new MemberXpRepository();
  private readonly guildSettings = new GuildSettingsRepository();
  /** In-memory cooldown: last award time (ms) per guildId:userId */
  private readonly lastAwardMs = new Map<string, number>();
  private readonly settingsCache = new Map<string, CachedLevelingSettings>();

  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  invalidateSettingsCache(guildId: string): void {
    this.settingsCache.delete(guildId);
  }

  /** Clear in-memory cooldowns for a guild (after admin reset). */
  clearCooldownsForGuild(guildId: string): void {
    const prefix = `${guildId}:`;
    for (const key of this.lastAwardMs.keys()) {
      if (key.startsWith(prefix)) this.lastAwardMs.delete(key);
    }
  }

  async getSettings(guildId: string): Promise<CachedLevelingSettings> {
    const cached = this.settingsCache.get(guildId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached;

    const s = await this.guildSettings.getOrDefault(guildId);
    const cooldownRaw = s.levelingCooldownSec;
    const cooldownSec =
      typeof cooldownRaw === 'number' && Number.isFinite(cooldownRaw) && cooldownRaw > 0
        ? Math.min(300, Math.max(15, Math.trunc(cooldownRaw)))
        : DEFAULT_COOLDOWN_SEC;

    const entry: CachedLevelingSettings = {
      enabled: s.levelingEnabled === true,
      levelUpChannelId: s.levelUpChannelId ?? null,
      cooldownSec,
      expiresAt: now + SETTINGS_TTL_MS,
    };
    this.settingsCache.set(guildId, entry);
    return entry;
  }

  async getMember(guildId: string, userId: string): Promise<MemberXpRow> {
    const row = await this.repo.get(guildId, userId);
    return (
      row ?? {
        guildId,
        userId,
        xp: 0,
        level: 0,
        lastAwardAt: null,
      }
    );
  }

  async getRank(guildId: string, xp: number): Promise<number> {
    return this.repo.rankOf(guildId, xp);
  }

  async getTop(guildId: string, limit = 10): Promise<MemberXpRow[]> {
    return this.repo.top(guildId, limit);
  }

  async resetGuild(guildId: string): Promise<number> {
    this.clearCooldownsForGuild(guildId);
    this.invalidateSettingsCache(guildId);
    return this.repo.resetGuild(guildId);
  }

  /**
   * Attempt to award XP for a chat message.
   * Returns null when cooling down, disabled, or ineligible.
   */
  async tryAwardFromMessage(
    guildId: string,
    userId: string,
    content: string,
  ): Promise<AwardXpResult | null> {
    if (!isMessageEligible(content)) return null;

    const settings = await this.getSettings(guildId);
    if (!settings.enabled) return null;

    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const cooldownMs = settings.cooldownSec * 1000;

    const mem = this.lastAwardMs.get(key);
    if (mem != null && now - mem < cooldownMs) return null;

    const existing = await this.repo.get(guildId, userId);
    if (existing?.lastAwardAt && now - existing.lastAwardAt.getTime() < cooldownMs) {
      this.lastAwardMs.set(key, existing.lastAwardAt.getTime());
      return null;
    }

    const amount = xpForMessage(content);
    const nextXp = (existing?.xp ?? 0) + amount;
    const newLevel = levelFromTotalXp(nextXp);
    const result = await this.repo.addXp(guildId, userId, amount, newLevel, new Date(now));
    this.lastAwardMs.set(key, now);
    return result;
  }

  async notifyLevelUp(
    guildId: string,
    userId: string,
    level: number,
    channelId: string | null,
  ): Promise<void> {
    if (!channelId) return;
    try {
      const channel =
        this.client.channels.cache.get(channelId) ??
        (await this.client.channels.fetch(channelId).catch(() => null));
      if (!channel || !channel.isTextBased() || channel.isDMBased()) return;

      await channel.send({
        embeds: [buildLevelUpEmbed(`<@${userId}>`, level)],
      });
    } catch (error) {
      this.logger.warn(`Level-up notify failed for ${userId} in guild ${guildId}:`, error);
    }
  }

  /** Progress helpers for commands. */
  progress(xp: number) {
    return progressInLevel(xp);
  }
}
