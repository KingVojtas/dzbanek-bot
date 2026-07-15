import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './client';

/**
 * One-time migration from old JSON stores to SQLite.
 * Safe to call on every startup — it only migrates if the corresponding
 * DB table/scope is empty.
 */
export async function migrateFromJsonIfNeeded(): Promise<void> {
  const dataDir = join(process.cwd(), 'data');

  // === Dedup (news + steam) ===
  const seenPath = join(dataDir, 'seen.json');
  if (existsSync(seenPath)) {
    try {
      const data = JSON.parse(readFileSync(seenPath, 'utf8')) as Record<string, string[]>;
      for (const [scope, ids] of Object.entries(data)) {
        const empty = (await prisma.dedupEntry.count({ where: { scope } })) === 0;
        if (empty && ids.length > 0) {
          for (const itemId of ids) {
            await prisma.dedupEntry.upsert({
              where: { scope_itemId: { scope, itemId } },
              create: { scope, itemId },
              update: {},
            });
          }
          console.log(`[Migrate] Migrated ${ids.length} dedup entries for scope ${scope}`);
        }
      }
    } catch (e) {
      console.warn('[Migrate] Failed to migrate seen.json:', e);
    }
  }

  const steamSeenPath = join(dataDir, 'steam_seen.json');
  if (existsSync(steamSeenPath)) {
    try {
      const data = JSON.parse(readFileSync(steamSeenPath, 'utf8')) as Record<string, string[]>;
      // For steam we respect the old "don't persist across restarts" behavior by default.
      // Only migrate if explicitly wanted (or you can delete the file).
      // Here we migrate but the SteamDealService still starts "fresh" because
      // we never called load for it.
      const scope = 'https://game-deals.app/rss/discounts/steam';
      const empty = (await prisma.dedupEntry.count({ where: { scope } })) === 0;
      const ids = data[scope] || Object.values(data).flat();
      if (empty && ids.length > 0) {
        for (const itemId of ids) {
          await prisma.dedupEntry.upsert({
            where: { scope_itemId: { scope, itemId } },
            create: { scope, itemId },
            update: {},
          });
        }
        console.log(`[Migrate] Migrated ${ids.length} steam dedup entries`);
      }
    } catch (e) {
      console.warn('[Migrate] Failed to migrate steam_seen.json:', e);
    }
  }

  // === Wishlists ===
  const wishlistPath = join(dataDir, 'wishlists.json');
  if (existsSync(wishlistPath)) {
    try {
      const data = JSON.parse(readFileSync(wishlistPath, 'utf8')) as Record<string, string[]>;
      const isEmpty = (await prisma.wishlistItem.count()) === 0;
      if (isEmpty) {
        for (const [userId, appIds] of Object.entries(data)) {
          for (const appId of appIds) {
            await prisma.wishlistItem.upsert({
              where: { userId_appId: { userId, appId } },
              create: { userId, appId },
              update: {},
            });
          }
        }
        console.log('[Migrate] Migrated wishlists.json');
      }
    } catch (e) {
      console.warn('[Migrate] Failed to migrate wishlists.json:', e);
    }
  }

  // === Stats ===
  const statsPath = join(dataDir, 'stats.json');
  if (existsSync(statsPath)) {
    try {
      const data = JSON.parse(readFileSync(statsPath, 'utf8')) as Record<string, unknown>;
      const guildCount = await prisma.guildStat.count();
      if (guildCount === 0) {
        for (const [guildId, gRaw] of Object.entries(data)) {
          const g = gRaw as Record<string, unknown>;
          if (!g) continue;

          const guildData = g as Record<string, unknown>;
          await prisma.guildStat.create({
            data: {
              guildId,
              totalPlays: Number(guildData.totalPlays ?? 0),
              totalDurationSec: Number(guildData.totalDurationSec ?? 0),
              totalSkips: Number(guildData.totalSkips ?? 0),
              totalWishlistAdds: Number(guildData.totalWishlistAdds ?? 0),
            },
          });

          // users
          for (const [userId, u] of Object.entries(g.users || {})) {
            const user = u as Record<string, unknown>;
            await prisma.userStat.create({
              data: {
                guildId,
                userId,
                plays: Number(user.plays ?? 0),
                totalDurationSec: Number(user.totalDurationSec ?? 0),
                skips: Number(user.skips ?? 0),
                wishlistAdds: Number(user.wishlistAdds ?? 0),
                lastActive: user.lastActive ? new Date(String(user.lastActive)) : null,
              },
            });
          }

          // command counts
          for (const [userId, userData] of Object.entries(g.users || {})) {
            const userCmds =
              ((userData as Record<string, unknown>).commands as Record<string, number>) || {};
            for (const [cmd, count] of Object.entries(userCmds)) {
              if (typeof count === 'number' && count > 0) {
                await prisma.commandCount.create({
                  data: { guildId, userId, command: cmd, count },
                });
              }
            }
          }

          // top tracks
          for (const [trackKey, t] of Object.entries(g.topTracks || {})) {
            const track = t as Record<string, unknown>;
            await prisma.trackPlay.create({
              data: {
                guildId,
                trackKey,
                title: String(track.title ?? trackKey),
                plays: Number(track.plays ?? 0),
                lastPlayed: track.lastPlayed ? new Date(String(track.lastPlayed)) : null,
              },
            });
          }
        }
        console.log('[Migrate] Migrated stats.json');
      }
    } catch (e) {
      console.warn('[Migrate] Failed to migrate stats.json:', e);
    }
  }
}
