import type { GuildSettings as PrismaGuildSettings } from '@prisma/client';
import { prisma } from '../client';

/**
 * Full guild settings row. Extends generated Prisma type until `prisma generate`
 * is re-run after schema changes (Windows may lock the query engine while bot runs).
 */
export type GuildSettings = PrismaGuildSettings & {
  logChannelId: string | null;
  welcomeEnabled: boolean;
  welcomeChannelId: string | null;
  welcomeMessage: string | null;
  goodbyeEnabled: boolean;
  goodbyeChannelId: string | null;
  goodbyeMessage: string | null;
  steamMinDiscount: number | null;
  steamMinReviewScore: number | null;
  newsKeywords: string | null;
  steamPostHourUtc: number | null;
  epicPostHourUtc: number | null;
  newsPostHourUtc: number | null;
};

export type GuildSettingsUpdate = {
  newsEnabled?: boolean;
  newsChannelId?: string | null;
  steamEnabled?: boolean;
  steamChannelId?: string | null;
  epicEnabled?: boolean;
  epicChannelId?: string | null;
  musicEnabled?: boolean;
  logChannelId?: string | null;
  welcomeEnabled?: boolean;
  welcomeChannelId?: string | null;
  welcomeMessage?: string | null;
  goodbyeEnabled?: boolean;
  goodbyeChannelId?: string | null;
  goodbyeMessage?: string | null;
  steamMinDiscount?: number | null;
  steamMinReviewScore?: number | null;
  newsKeywords?: string | null;
  steamPostHourUtc?: number | null;
  epicPostHourUtc?: number | null;
  newsPostHourUtc?: number | null;
};

function asRow(row: PrismaGuildSettings): GuildSettings {
  const r = row as GuildSettings;
  return {
    ...row,
    logChannelId: r.logChannelId ?? null,
    welcomeEnabled: r.welcomeEnabled ?? false,
    welcomeChannelId: r.welcomeChannelId ?? null,
    welcomeMessage: r.welcomeMessage ?? null,
    goodbyeEnabled: r.goodbyeEnabled ?? false,
    goodbyeChannelId: r.goodbyeChannelId ?? null,
    goodbyeMessage: r.goodbyeMessage ?? null,
    steamMinDiscount: r.steamMinDiscount ?? null,
    steamMinReviewScore: r.steamMinReviewScore ?? null,
    newsKeywords: r.newsKeywords ?? null,
    steamPostHourUtc: r.steamPostHourUtc ?? null,
    epicPostHourUtc: r.epicPostHourUtc ?? null,
    newsPostHourUtc: r.newsPostHourUtc ?? null,
  };
}

const EMPTY_EXTRAS = {
  logChannelId: null as string | null,
  welcomeEnabled: false,
  welcomeChannelId: null as string | null,
  welcomeMessage: null as string | null,
  goodbyeEnabled: false,
  goodbyeChannelId: null as string | null,
  goodbyeMessage: null as string | null,
  steamMinDiscount: null as number | null,
  steamMinReviewScore: null as number | null,
  newsKeywords: null as string | null,
  steamPostHourUtc: null as number | null,
  epicPostHourUtc: null as number | null,
  newsPostHourUtc: null as number | null,
};

export class GuildSettingsRepository {
  async get(guildId: string): Promise<GuildSettings | null> {
    const row = await prisma.guildSettings.findUnique({ where: { guildId } });
    return row ? asRow(row) : null;
  }

  /** Returns settings or a default empty shape when no row exists yet. */
  async getOrDefault(guildId: string): Promise<GuildSettings> {
    const existing = await this.get(guildId);
    if (existing) return existing;
    return {
      guildId,
      newsEnabled: false,
      newsChannelId: null,
      steamEnabled: false,
      steamChannelId: null,
      epicEnabled: false,
      epicChannelId: null,
      musicEnabled: true,
      ...EMPTY_EXTRAS,
      updatedAt: new Date(0),
      updatedByUserId: null,
    };
  }

  async upsert(
    guildId: string,
    data: GuildSettingsUpdate,
    updatedByUserId?: string | null,
  ): Promise<GuildSettings> {
    const row = await prisma.guildSettings.upsert({
      where: { guildId },
      create: {
        guildId,
        newsEnabled: data.newsEnabled ?? false,
        newsChannelId: data.newsChannelId ?? null,
        steamEnabled: data.steamEnabled ?? false,
        steamChannelId: data.steamChannelId ?? null,
        epicEnabled: data.epicEnabled ?? false,
        epicChannelId: data.epicChannelId ?? null,
        musicEnabled: data.musicEnabled ?? true,
        logChannelId: data.logChannelId ?? null,
        welcomeEnabled: data.welcomeEnabled ?? false,
        welcomeChannelId: data.welcomeChannelId ?? null,
        welcomeMessage: data.welcomeMessage ?? null,
        goodbyeEnabled: data.goodbyeEnabled ?? false,
        goodbyeChannelId: data.goodbyeChannelId ?? null,
        goodbyeMessage: data.goodbyeMessage ?? null,
        steamMinDiscount: data.steamMinDiscount ?? null,
        steamMinReviewScore: data.steamMinReviewScore ?? null,
        newsKeywords: data.newsKeywords ?? null,
        steamPostHourUtc: data.steamPostHourUtc ?? null,
        epicPostHourUtc: data.epicPostHourUtc ?? null,
        newsPostHourUtc: data.newsPostHourUtc ?? null,
        updatedByUserId: updatedByUserId ?? null,
      } as unknown as Parameters<typeof prisma.guildSettings.upsert>[0]['create'],
      update: {
        ...data,
        updatedByUserId: updatedByUserId ?? undefined,
      } as unknown as Parameters<typeof prisma.guildSettings.upsert>[0]['update'],
    });
    return asRow(row);
  }

  /** Clear feed toggles/channels/filters/greetings/log; leave music on by default. */
  async reset(guildId: string, updatedByUserId?: string | null): Promise<GuildSettings> {
    return this.upsert(
      guildId,
      {
        newsEnabled: false,
        newsChannelId: null,
        steamEnabled: false,
        steamChannelId: null,
        epicEnabled: false,
        epicChannelId: null,
        musicEnabled: true,
        logChannelId: null,
        welcomeEnabled: false,
        welcomeChannelId: null,
        welcomeMessage: null,
        goodbyeEnabled: false,
        goodbyeChannelId: null,
        goodbyeMessage: null,
        steamMinDiscount: null,
        steamMinReviewScore: null,
        newsKeywords: null,
        steamPostHourUtc: null,
        epicPostHourUtc: null,
        newsPostHourUtc: null,
      },
      updatedByUserId,
    );
  }

  async findNewsEnabled(): Promise<GuildSettings[]> {
    const rows = await prisma.guildSettings.findMany({
      where: {
        newsEnabled: true,
        newsChannelId: { not: null },
      },
    });
    return rows.map(asRow);
  }

  async findSteamEnabled(): Promise<GuildSettings[]> {
    const rows = await prisma.guildSettings.findMany({
      where: {
        steamEnabled: true,
        steamChannelId: { not: null },
      },
    });
    return rows.map(asRow);
  }

  async findEpicEnabled(): Promise<GuildSettings[]> {
    const rows = await prisma.guildSettings.findMany({
      where: {
        epicEnabled: true,
        epicChannelId: { not: null },
      },
    });
    return rows.map(asRow);
  }
}
