import type { GuildSettings } from '@prisma/client';
import { prisma } from '../client';

export type GuildSettingsUpdate = {
  newsEnabled?: boolean;
  newsChannelId?: string | null;
  steamEnabled?: boolean;
  steamChannelId?: string | null;
  epicEnabled?: boolean;
  epicChannelId?: string | null;
};

export class GuildSettingsRepository {
  async get(guildId: string): Promise<GuildSettings | null> {
    return prisma.guildSettings.findUnique({ where: { guildId } });
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
      updatedAt: new Date(0),
      updatedByUserId: null,
    };
  }

  async upsert(
    guildId: string,
    data: GuildSettingsUpdate,
    updatedByUserId?: string | null,
  ): Promise<GuildSettings> {
    return prisma.guildSettings.upsert({
      where: { guildId },
      create: {
        guildId,
        newsEnabled: data.newsEnabled ?? false,
        newsChannelId: data.newsChannelId ?? null,
        steamEnabled: data.steamEnabled ?? false,
        steamChannelId: data.steamChannelId ?? null,
        epicEnabled: data.epicEnabled ?? false,
        epicChannelId: data.epicChannelId ?? null,
        updatedByUserId: updatedByUserId ?? null,
      },
      update: {
        ...data,
        updatedByUserId: updatedByUserId ?? undefined,
      },
    });
  }

  async findNewsEnabled(): Promise<GuildSettings[]> {
    return prisma.guildSettings.findMany({
      where: {
        newsEnabled: true,
        newsChannelId: { not: null },
      },
    });
  }

  async findSteamEnabled(): Promise<GuildSettings[]> {
    return prisma.guildSettings.findMany({
      where: {
        steamEnabled: true,
        steamChannelId: { not: null },
      },
    });
  }

  async findEpicEnabled(): Promise<GuildSettings[]> {
    return prisma.guildSettings.findMany({
      where: {
        epicEnabled: true,
        epicChannelId: { not: null },
      },
    });
  }
}
