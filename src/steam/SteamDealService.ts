import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type Message,
  type SendableChannels,
} from 'discord.js';
import type { Config } from '../config';
import { buildInfoEmbed, buildSteamDealsDigestEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { SteamDealItem } from '../core/types';
import { GuildSettingsRepository, type GuildSettings } from '../db/repositories';
import type { SeenStore } from '../news/SeenStore';
import { isPostHourNow, parseDiscountPercent } from '../utils/digest-schedule';
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
  settings: GuildSettings | null;
};

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
      console.log('[Steam] poll() aborted — no channels available.');
      return;
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
   * Legacy config channel (no per-guild filters) + each enabled GuildSettings row.
   */
  private async resolveTargets(): Promise<SteamTarget[]> {
    const byChannel = new Map<string, SteamTarget>();

    if (this.config.steam.channelId) {
      const ch = await this.fetchSendable(this.config.steam.channelId);
      if (ch) byChannel.set(ch.id, { channel: ch, settings: null });
    }

    try {
      const rows = await this.guildSettings.findSteamEnabled();
      for (const row of rows) {
        if (!row.steamChannelId) continue;
        const ch = await this.fetchSendable(row.steamChannelId);
        if (!ch) continue;
        // Guild settings win over legacy for the same channel id
        byChannel.set(ch.id, { channel: ch, settings: row });
      }
    } catch (error) {
      this.logger.warn('Steam: failed to load guild settings for channels:', error);
    }

    return [...byChannel.values()];
  }

  private async fetchSendable(channelId: string): Promise<SendableChannels | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        this.logger.warn(`Steam: channel ${channelId} not found.`);
        return null;
      }
      if (!channel.isSendable()) {
        this.logger.warn(`Steam: channel ${channelId} is not sendable.`);
        return null;
      }
      return channel;
    } catch (error) {
      this.logger.warn(`Steam: failed to fetch channel ${channelId}:`, error);
      return null;
    }
  }

  private async pollDeals(targets: SteamTarget[]): Promise<void> {
    const items = await this.reader.read();
    console.log(`[Steam] Total items from feed: ${items.length}`);

    if (items.length === 0) {
      console.log('[Steam] Feed returned no items. Nothing to post.');
      return;
    }

    console.log('[Steam] Checking for duplicates against seen store…');
    const fresh: SteamDealItem[] = [];
    for (const item of items) {
      if (!item.id) continue;
      const seen = await this.store.has(STEAM_FEED_URL, item.id);
      if (!seen) fresh.push(item);
    }

    console.log(`[Steam] ${fresh.length} new deal(s) out of ${items.length} total.`);

    if (fresh.length === 0) {
      this.logger.info('Steam Deals: no new deals since last poll.');
      return;
    }

    if ((await this.store.isEmpty(STEAM_FEED_URL)) && !this.config.steam.postOnFirstRun) {
      await this.store.add(
        STEAM_FEED_URL,
        fresh.map((item) => item.id),
      );
      this.logger.info(`Steam Deals: seeded ${fresh.length} existing deal(s) silently.`);
      return;
    }

    const ordered = [...fresh].reverse();

    console.log(`[Steam] Fetching reviews for ${ordered.length} deal(s)…`);
    const reviewEntries = await Promise.all(
      ordered.map(async (item): Promise<[string, SteamReviewInfo | null]> => {
        const appId = extractAppId(item.link);
        if (!appId) return [item.id, null];
        return [item.id, await fetchSteamReview(appId)];
      }),
    );
    const reviewMap = new Map<string, SteamReviewInfo | null>(reviewEntries);

    // Wishlist DMs for every fresh deal (not only public digest-filtered).
    if (this.wishlist) {
      try {
        for (const item of ordered) {
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
    for (const item of ordered) {
      discountCache.set(item.id, parseDiscountPercent(item.discount));
    }

    let postedTo = 0;
    for (const target of targets) {
      const settings = target.settings;
      if (!isPostHourNow(settings?.steamPostHourUtc ?? null)) {
        console.log(
          `[Steam] Skip channel ${target.channel.id} — post hour UTC ${settings?.steamPostHourUtc} (now ${new Date().getUTCHours()})`,
        );
        continue;
      }

      const minDiscount = settings?.steamMinDiscount ?? null;
      const minScore = settings?.steamMinReviewScore ?? null;

      const filtered = ordered.filter((item) => {
        const review = reviewMap.get(item.id);
        if (!review) return false;
        if (!isGoodReview(review, minScore)) return false;
        if (minDiscount != null) {
          const pct = discountCache.get(item.id) ?? null;
          if (pct == null) {
            // try live price later if we fetch; for now skip if feed has no %
            return false;
          }
          if (pct < minDiscount) return false;
        }
        return true;
      });

      const top = filtered.slice(0, 10);
      if (top.length === 0) {
        console.log(`[Steam] Channel ${target.channel.id}: no deals after guild filters.`);
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
        console.log(`[Steam] Channel ${target.channel.id}: empty after live discount filter.`);
        continue;
      }

      const prices = new Map<string, string | null>();
      const reviews = new Map<string, string>();
      for (const item of topFinal) {
        prices.set(item.id, priceCache.get(item.id) ?? null);
        const review = reviewMap.get(item.id);
        if (review) reviews.set(item.id, formatReview(review));
      }

      const embed = buildSteamDealsDigestEmbed(topFinal, prices, reviews);
      const components = this.buildWishlistComponents(topFinal);

      try {
        const lastMessage = await this.findLastBotMessage(target.channel);
        if (this.isDuplicateDigest(lastMessage, topFinal)) {
          console.log(`[Steam] Channel ${target.channel.id}: digest identical — skipping.`);
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
          embeds: [embed],
          components,
        });
        try {
          await sentMessage.react('🔥');
          await sentMessage.react('💰');
          await sentMessage.react('👍');
        } catch {
          /* ignore */
        }
        postedTo += 1;
        console.log(`[Steam] Digest sent to ${target.channel.id} (${topFinal.length} deals).`);
      } catch (error) {
        this.logger.error(`Steam: failed to post digest to channel ${target.channel.id}:`, error);
      }
    }

    await this.store.add(
      STEAM_FEED_URL,
      ordered.map((item) => item.id),
    );

    this.logger.info(
      `Steam Deals: posted to ${postedTo}/${targets.length} channel(s) (${ordered.length} new deals processed).`,
    );
  }

  private buildWishlistComponents(top: SteamDealItem[]) {
    const selectOptions = top
      .map((item) => {
        const appId = extractAppId(item.link);
        const value = appId ?? `name:${item.gameName.toLowerCase().slice(0, 80)}`;
        const discount = item.discount ? ` ${item.discount}` : '';
        return new StringSelectMenuOptionBuilder()
          .setLabel(item.gameName.slice(0, 100))
          .setValue(value)
          .setDescription(`Add to bot wishlist${discount}`.slice(0, 100));
      })
      .slice(0, 25);

    if (selectOptions.length === 0) return [];

    const menu = new StringSelectMenuBuilder()
      .setCustomId('wishlist:add')
      .setPlaceholder('❤️ Add to my wishlist (get notified on sales)')
      .setMinValues(1)
      .setMaxValues(Math.min(5, selectOptions.length))
      .addOptions(selectOptions);

    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
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
    if (!lastMessage || lastMessage.embeds.length === 0 || top.length === 0) return false;

    const lastTitles = lastMessage.embeds[0].fields.map((f) =>
      f.name.replace(/^\d+\.\s*/, '').trim(),
    );
    const newTitles = top.map((item) => item.gameName);

    return (
      lastTitles.length === newTitles.length &&
      lastTitles.every((title, i) => title === newTitles[i])
    );
  }
}
