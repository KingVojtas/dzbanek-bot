import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Message,
  type SendableChannels,
  type TextChannel,
} from 'discord.js';
import type { Config } from '../config';
import { buildSteamDealsDisplay, collectMessageTextContent } from '../core/display';
import { buildInfoEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { SteamDealItem } from '../core/types';
import { GuildSettingsRepository, type GuildSettings } from '../db/repositories';
import type { SeenStore } from '../news/SeenStore';
import { isPostHourNow, parseDiscountPercent } from '../utils/digest-schedule';
import { resolveGuildSendableChannel } from '../utils/guild-channel';
import type { StatsStore } from '../stats/StatsStore';
import type { WishlistStore } from '../wishlist/WishlistStore';
import { STEAM_FEED_URL, SteamFeedReader } from './SteamFeedReader';
import { extractAppId, fetchSteamPrice, formatSteamPrice } from './SteamPriceApi';
import {
  fetchSteamReview,
  formatReview,
  isGoodReview,
  type SteamReviewInfo,
} from './SteamReviewApi';

type SteamTarget = {
  channel: SendableChannels;
  settings: GuildSettings;
};

/** Channel names we auto-wire for multi-server Steam when admin never set the other guild. */
const STEAM_CHANNEL_NAME_HINTS = [
  'steam',
  'steam-deals',
  'steamdeals',
  'steam-sales',
  'deals',
  'game-deals',
  'gamedeals',
  'gamesales',
  'sales',
  'slevy',
  'akce',
  'hry',
  'games',
];

/** Polls the game-deals.app Steam RSS feed and posts new deals as embeds. */
export class SteamDealService {
  private readonly reader = new SteamFeedReader();
  private readonly guildSettings = new GuildSettingsRepository();

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly wishlist?: WishlistStore,
    private readonly stats?: StatsStore,
  ) {}

  async poll(): Promise<void> {
    console.log('[Steam] poll() called.');

    let targets: SteamTarget[];
    try {
      targets = await this.resolveTargets();
    } catch (error) {
      console.error('[Steam] ERROR: Exception while fetching channels:', error);
      this.logger.error('Steam: exception while fetching channels:', error);
      return;
    }

    if (targets.length === 0) {
      console.log(
        '[Steam] No Discord channels configured — still polling feed for website Deals Pulse.',
      );
    }

    try {
      await this.pollDeals(targets);
    } catch (error) {
      console.error('[Steam] ERROR: Unhandled exception in pollDeals():', error);
      this.logger.error('Steam: failed to poll deals:', error);
    }

    console.log('[Steam] poll() finished.');
  }

  /**
   * One digest per enabled guild — channel must belong to that guild.
   * Auto-enables Steam on other servers by matching a deals-like channel name
   * (or the same channel name as an already-configured guild).
   */
  private async resolveTargets(): Promise<SteamTarget[]> {
    const byGuild = new Map<string, SteamTarget>();
    let template: GuildSettings | null = null;
    let templateChannelName: string | null = null;

    try {
      // Prefer DB rows; also auto-wire missing guilds so multi-server "just works".
      await this.autoEnableSteamForMissingGuilds();

      const rows = await this.guildSettings.findSteamEnabled();
      this.logger.info(`Steam: ${rows.length} guild(s) have steam enabled in settings.`);
      for (const row of rows) {
        if (!row.steamChannelId) continue;
        const ch = await resolveGuildSendableChannel(this.client, row.steamChannelId, row.guildId);
        if (!ch) {
          this.logger.warn(
            `Steam: skip guild ${row.guildId} — channel ${row.steamChannelId} missing or not in that server.`,
          );
          continue;
        }
        byGuild.set(row.guildId, { channel: ch, settings: row });
        if (!template) {
          template = row;
          templateChannelName = 'name' in ch && typeof ch.name === 'string' ? ch.name : null;
        }
        const guildName = this.client.guilds.cache.get(row.guildId)?.name ?? row.guildId;
        console.log(`[Steam] Target guild "${guildName}" → #${ch.id}`);
      }

      // Second pass: any guild still missing after DB load (race) — try name match once more.
      if (templateChannelName) {
        for (const g of this.client.guilds.cache.values()) {
          if (byGuild.has(g.id)) continue;
          const ch = await this.findSteamChannelInGuild(g, templateChannelName, true);
          if (!ch) continue;
          const saved = await this.guildSettings.upsert(
            g.id,
            {
              steamEnabled: true,
              steamChannelId: ch.id,
              steamMinDiscount: template?.steamMinDiscount ?? null,
              steamMinReviewScore: template?.steamMinReviewScore ?? null,
              steamPostHourUtc: template?.steamPostHourUtc ?? null,
            },
            null,
          );
          byGuild.set(g.id, { channel: ch, settings: saved });
          this.logger.info(
            `Steam: auto-enabled for "${g.name}" → #${ch.name} (${ch.id}) [same name as primary]`,
          );
        }
      }
    } catch (error) {
      this.logger.warn('Steam: failed to load guild settings for channels:', error);
    }

    if (byGuild.size === 0) {
      this.logger.warn(
        'Steam: no guild targets. Create a #steam / #deals channel (or set Steam in website admin).',
      );
    } else {
      for (const g of this.client.guilds.cache.values()) {
        if (!byGuild.has(g.id)) {
          this.logger.info(
            `Steam: guild "${g.name}" (${g.id}) still has no Steam channel — rename a text channel to steam/deals or set it in website admin.`,
          );
        }
      }
    }

    return [...byGuild.values()];
  }

  /**
   * For every guild the bot is in without steamEnabled+channel, try to pick a
   * text channel whose name looks like Steam deals (or matches the primary).
   */
  private async autoEnableSteamForMissingGuilds(): Promise<void> {
    if (process.env.STEAM_AUTO_ENABLE === 'false') return;

    const enabled = await this.guildSettings.findSteamEnabled();
    let primaryName: string | null = null;
    const primary: GuildSettings | null = enabled[0] ?? null;

    if (primary?.steamChannelId) {
      const ch = await this.client.channels.fetch(primary.steamChannelId).catch(() => null);
      if (ch && 'name' in ch && typeof ch.name === 'string') primaryName = ch.name;
    }

    for (const guild of this.client.guilds.cache.values()) {
      const existing = await this.guildSettings.get(guild.id);
      if (existing?.steamEnabled && existing.steamChannelId) continue;

      // If at least one guild already has Steam, fall back to first postable text channel.
      const channel = await this.findSteamChannelInGuild(
        guild,
        primaryName,
        Boolean(primary || primaryName),
      );
      if (!channel) {
        this.logger.info(
          `Steam: cannot auto-enable "${guild.name}" — no usable text channel (bot needs Send Messages).`,
        );
        continue;
      }

      await this.guildSettings.upsert(
        guild.id,
        {
          steamEnabled: true,
          steamChannelId: channel.id,
          steamMinDiscount: primary?.steamMinDiscount ?? null,
          steamMinReviewScore: primary?.steamMinReviewScore ?? null,
          steamPostHourUtc: primary?.steamPostHourUtc ?? null,
        },
        null,
      );
      this.logger.info(`Steam: auto-enabled "${guild.name}" → #${channel.name} (${channel.id})`);
    }
  }

  private async findSteamChannelInGuild(
    guild: Guild,
    preferredName: string | null,
    allowFirstTextFallback = false,
  ): Promise<TextChannel | null> {
    try {
      await guild.channels.fetch();
    } catch {
      /* use cache */
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const textChannels = guild.channels.cache.filter(
      (c): c is TextChannel =>
        c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
    );

    const canPost = (c: TextChannel): boolean => {
      if (!me) return true;
      const perms = c.permissionsFor(me);
      return (
        !!perms &&
        perms.has(PermissionFlagsBits.SendMessages) &&
        perms.has(PermissionFlagsBits.EmbedLinks)
      );
    };

    const candidates = [...textChannels.values()].filter(canPost);
    if (candidates.length === 0) return null;

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\u00c0-\u024f]+/gi, '')
        .trim();

    // 1) Exact same name as primary guild's steam channel
    if (preferredName) {
      const pref = norm(preferredName);
      const match = candidates.find((c) => norm(c.name) === pref);
      if (match) return match;
    }

    // 2) Common deal-channel names
    for (const hint of STEAM_CHANNEL_NAME_HINTS) {
      const h = norm(hint);
      const match = candidates.find((c) => norm(c.name) === h || norm(c.name).includes(h));
      if (match) return match;
    }

    // 3) Multi-server catch-up: first postable text channel (when primary already set)
    if (allowFirstTextFallback) {
      candidates.sort((a, b) => a.rawPosition - b.rawPosition);
      return candidates[0] ?? null;
    }

    return null;
  }

  private async pollDeals(targets: SteamTarget[]): Promise<void> {
    const items = await this.reader.read();
    console.log(`[Steam] Total items from feed: ${items.length}`);

    if (items.length === 0) {
      console.log('[Steam] Feed returned no items. Nothing to post.');
      return;
    }

    const withIds = items.filter((item) => Boolean(item.id));
    console.log('[Steam] Checking for duplicates against seen store…');
    const fresh: SteamDealItem[] = [];
    for (const item of withIds) {
      const seen = await this.store.has(STEAM_FEED_URL, item.id);
      if (!seen) fresh.push(item);
    }

    console.log(
      `[Steam] ${fresh.length} new deal(s) out of ${withIds.length}; posting digests to ${targets.length} guild(s).`,
    );

    // First-ever run: seed backlog without spamming every guild (unless postOnFirstRun).
    // Still continue so Deals Pulse can refresh for the website.
    const seedOnly =
      (await this.store.isEmpty(STEAM_FEED_URL)) && !this.config.steam.postOnFirstRun;
    if (seedOnly) {
      await this.store.add(
        STEAM_FEED_URL,
        withIds.map((item) => item.id),
      );
      this.logger.info(
        `Steam Deals: seeded ${withIds.length} existing deal(s) silently (Discord digests skipped; website pulse still updates).`,
      );
    }

    // Always rank digests from the **full current feed**, not only `fresh` items.
    // Previously: pool = fresh when any new IDs existed → one new RSS row → 1-game digest.
    // `fresh` is still used for wishlist DMs; duplicate-embed check avoids spam.
    const pool = withIds;
    if (fresh.length > 0 && fresh.length < withIds.length) {
      console.log(
        `[Steam] ${fresh.length} new feed id(s); digest still ranks top deals from all ${withIds.length} feed items.`,
      );
    }

    console.log(`[Steam] Fetching reviews for ${pool.length} deal(s)…`);
    const reviewEntries = await Promise.all(
      pool.map(async (item): Promise<[string, SteamReviewInfo | null]> => {
        const appId = extractAppId(item.link);
        if (!appId) return [item.id, null];
        return [item.id, await fetchSteamReview(appId)];
      }),
    );
    const reviewMap = new Map<string, SteamReviewInfo | null>(reviewEntries);

    // Wishlist DMs only for truly new feed items (not catch-up digests / first seed).
    if (this.wishlist && fresh.length > 0 && !seedOnly) {
      try {
        for (const item of fresh) {
          const appId = extractAppId(item.link);
          if (!appId) continue;
          const users = await this.wishlist.getUsersForAppId(appId);
          for (const uid of users) {
            try {
              const user = await this.client.users.fetch(uid);
              const dm = await user.createDM();
              const priceLine = [item.salePrice, item.discount].filter(Boolean).join(' ');
              await dm.send({
                embeds: [
                  buildInfoEmbed(
                    `${priceLine}\n[View on Steam](${item.link})`,
                    `🎮 ${item.gameName} is on sale!`,
                  ),
                ],
              });
            } catch {
              /* ignore DM failures */
            }
          }
        }
      } catch (e) {
        console.warn('[Steam] Wishlist matching error:', e);
      }
    }

    const priceCache = new Map<string, string | null>();
    const discountCache = new Map<string, number | null>();
    for (const item of pool) {
      discountCache.set(item.id, parseDiscountPercent(item.discount));
    }

    // Deals Pulse for the website: refresh from the ranked feed even when Discord
    // digests are skipped (post hour, duplicate, first-run seed, no targets).
    if (this.stats) {
      const byDiscount = (a: SteamDealItem, b: SteamDealItem) => {
        const da = discountCache.get(a.id) ?? parseDiscountPercent(a.discount) ?? 0;
        const db = discountCache.get(b.id) ?? parseDiscountPercent(b.discount) ?? 0;
        if (db !== da) return db - da;
        return a.gameName.localeCompare(b.gameName);
      };
      let pulsePool = pool
        .filter((item) => {
          const review = reviewMap.get(item.id);
          return Boolean(review && isGoodReview(review, null));
        })
        .sort(byDiscount)
        .slice(0, 6);
      // If reviews API is flaky / all fail, still surface top discounts so the site isn't empty.
      if (pulsePool.length === 0) {
        pulsePool = [...pool].sort(byDiscount).slice(0, 4);
      }
      this.stats.setDealsForSource(
        'steam',
        pulsePool.map((item) => ({
          title: item.gameName || item.title,
          subtitle: [item.discount, item.salePrice].filter(Boolean).join(' · ') || 'On sale',
        })),
      );
      if (pulsePool.length === 0) {
        console.log('[Steam] Deals Pulse: feed empty — nothing to publish.');
      } else {
        console.log(`[Steam] Deals Pulse: published ${pulsePool.length} deal(s) to /api/stats.`);
      }
    }

    let postedTo = 0;
    for (const target of targets) {
      if (seedOnly) break; // website pulse already updated; don't spam Discord on first seed

      const settings = target.settings;
      const guildLabel = this.client.guilds.cache.get(settings.guildId)?.name ?? settings.guildId;

      if (!isPostHourNow(settings.steamPostHourUtc ?? null)) {
        console.log(
          `[Steam] Skip guild "${guildLabel}" — post hour UTC ${settings.steamPostHourUtc} (now ${new Date().getUTCHours()})`,
        );
        continue;
      }

      const minDiscount = settings.steamMinDiscount ?? null;
      const minScore = settings.steamMinReviewScore ?? null;

      const filtered = pool.filter((item) => {
        const review = reviewMap.get(item.id);
        if (!review) return false;
        if (!isGoodReview(review, minScore)) return false;
        if (minDiscount != null) {
          const pct = discountCache.get(item.id) ?? null;
          if (pct == null) {
            return false;
          }
          if (pct < minDiscount) return false;
        }
        return true;
      });

      // Prefer deepest discounts first (stable order for duplicate-digest compare).
      filtered.sort((a, b) => {
        const da = discountCache.get(a.id) ?? parseDiscountPercent(a.discount) ?? 0;
        const db = discountCache.get(b.id) ?? parseDiscountPercent(b.discount) ?? 0;
        if (db !== da) return db - da;
        return a.gameName.localeCompare(b.gameName);
      });

      const top = filtered.slice(0, 10);
      if (top.length === 0) {
        console.log(`[Steam] Guild "${guildLabel}": no deals after guild filters.`);
        continue;
      }

      // Live prices for this top list (shared cache)
      await Promise.all(
        top.map(async (item) => {
          if (priceCache.has(item.id)) return;
          const appId = extractAppId(item.link);
          if (!appId) {
            priceCache.set(item.id, null);
            return;
          }
          const info = await fetchSteamPrice(appId);
          priceCache.set(item.id, info ? formatSteamPrice(info) : null);
          if (info && discountCache.get(item.id) == null) {
            discountCache.set(item.id, info.discountPercent);
          }
        }),
      );

      // Re-apply discount using live % if feed lacked it
      const topFinal =
        minDiscount == null
          ? top
          : top.filter((item) => {
              const pct = discountCache.get(item.id);
              return pct != null && pct >= minDiscount;
            });

      if (topFinal.length === 0) {
        console.log(`[Steam] Guild "${guildLabel}": empty after live discount filter.`);
        continue;
      }

      const prices = new Map<string, string | null>();
      const reviews = new Map<string, string>();
      for (const item of topFinal) {
        prices.set(item.id, priceCache.get(item.id) ?? null);
        const review = reviewMap.get(item.id);
        if (review) reviews.set(item.id, formatReview(review));
      }

      const display = buildSteamDealsDisplay(
        topFinal,
        prices,
        reviews,
        settings.steamMinDiscount ?? null,
      );

      try {
        const lastMessage = await this.findLastBotMessage(target.channel);
        if (this.isDuplicateDigest(lastMessage, topFinal)) {
          console.log(`[Steam] Guild "${guildLabel}": digest identical — skipping.`);
          continue;
        }
        if (lastMessage) {
          try {
            await lastMessage.delete();
          } catch {
            /* ignore */
          }
        }
        const sentMessage = await target.channel.send({
          components: display.components,
          flags: display.flags,
        });
        try {
          await sentMessage.react('🔥');
          await sentMessage.react('💰');
          await sentMessage.react('👍');
        } catch {
          /* ignore */
        }
        postedTo += 1;
        console.log(
          `[Steam] Digest sent to guild "${guildLabel}" (#${target.channel.id}, ${topFinal.length} deals).`,
        );
      } catch (error) {
        this.logger.error(
          `Steam: failed to post digest to guild ${settings.guildId} channel ${target.channel.id}:`,
          error,
        );
      }
    }

    // Mark full feed as seen so we only DM wishlists on truly new items next time.
    if (!seedOnly) {
      await this.store.add(
        STEAM_FEED_URL,
        withIds.map((item) => item.id),
      );
    }

    this.logger.info(
      `Steam Deals: posted to ${postedTo}/${targets.length} guild(s) (pool=${pool.length}, fresh=${fresh.length}${seedOnly ? ', seed-only' : ''}).`,
    );
  }

  private async findLastBotMessage(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      return recent.find((msg) => msg.author.id === this.client.user?.id) ?? null;
    } catch {
      return null;
    }
  }

  private isDuplicateDigest(lastMessage: Message | null, top: SteamDealItem[]): boolean {
    if (!lastMessage || top.length === 0) return false;

    const blob = collectMessageTextContent(lastMessage);
    // Legacy embed path
    if (lastMessage.embeds.length > 0) {
      const lastTitles = lastMessage.embeds[0].fields.map((f) =>
        f.name.replace(/^\d+\.\s*/, '').trim(),
      );
      const newTitles = top.map((item) => item.gameName);
      if (
        lastTitles.length === newTitles.length &&
        lastTitles.every((title, i) => title === newTitles[i])
      ) {
        return true;
      }
    }

    // Components V2: all game names appear in the message text
    return top.every((item) => blob.includes(item.gameName.slice(0, 40)));
  }
}
