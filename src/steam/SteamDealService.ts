import type { Client, SendableChannels } from 'discord.js';
import type { Config } from '../config';
import { buildSteamDealsDigestEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { SeenStore } from '../news/SeenStore';
import { STEAM_FEED_URL, SteamFeedReader } from './SteamFeedReader';
import { extractAppId, fetchSteamPrice, formatSteamPrice } from './SteamPriceApi';
import {
  fetchSteamReview,
  formatReview,
  isGoodReview,
  type SteamReviewInfo,
} from './SteamReviewApi';

/** Polls the game-deals.app Steam RSS feed and posts new deals as embeds. */
export class SteamDealService {
  private readonly reader = new SteamFeedReader();

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async poll(): Promise<void> {
    console.log('[Steam] poll() called.');

    let channel: SendableChannels | null;
    try {
      channel = await this.resolveChannel();
    } catch (error) {
      console.error('[Steam] ERROR: Exception while fetching the channel:', error);
      this.logger.error('Steam: exception while fetching channel:', error);
      return;
    }

    if (!channel) {
      console.log('[Steam] poll() aborted — channel not available.');
      return;
    }

    try {
      await this.pollDeals(channel);
    } catch (error) {
      console.error('[Steam] ERROR: Unhandled exception in pollDeals():', error);
      this.logger.error('Steam: failed to poll deals:', error);
    }

    console.log('[Steam] poll() finished.');
  }

  private async resolveChannel(): Promise<SendableChannels | null> {
    console.log(`[Steam] Fetching channel ID: ${this.config.steam.channelId} …`);

    const channel = await this.client.channels.fetch(this.config.steam.channelId);

    if (!channel) {
      console.warn(
        `[Steam] WARNING: channel ${this.config.steam.channelId} not found. ` +
          'Confirm the bot is in the guild and the channel ID is correct.',
      );
      this.logger.warn(`Steam: channel ${this.config.steam.channelId} not found.`);
      return null;
    }

    console.log(
      `[Steam] Channel fetched. type=${channel.type} isSendable=${channel.isSendable()} id=${channel.id}`,
    );

    if (!channel.isSendable()) {
      console.warn(
        `[Steam] WARNING: channel ${this.config.steam.channelId} is not sendable ` +
          '(may be a category/voice channel, or the bot is missing Send Messages permission).',
      );
      this.logger.warn(`Steam: channel ${this.config.steam.channelId} is not sendable.`);
      return null;
    }

    return channel;
  }

  private async pollDeals(channel: SendableChannels): Promise<void> {
    const items = await this.reader.read();
    console.log(`[Steam] Total items from feed: ${items.length}`);

    if (items.length === 0) {
      console.log('[Steam] Feed returned no items. Nothing to post.');
      return;
    }

    console.log('[Steam] Checking for duplicates against seen store…');
    const fresh: typeof items = [];
    for (const item of items) {
      if (!item.id) {
        console.log(`[Steam]   SKIP (no id): "${item.title}"`);
        continue;
      }
      const seen = this.store.has(STEAM_FEED_URL, item.id);
      console.log(`[Steam]   "${item.gameName}" → ${seen ? 'already seen, skip' : 'NEW ✓'}`);
      if (!seen) fresh.push(item);
    }

    console.log(`[Steam] ${fresh.length} new deal(s) out of ${items.length} total.`);

    if (fresh.length === 0) {
      console.log('[Steam] No new deals to post.');
      this.logger.info('Steam Deals: no new deals since last poll.');
      return;
    }

    // First-run guard: seed the backlog silently so we don't flood the channel.
    if (this.store.isEmpty(STEAM_FEED_URL) && !this.config.steam.postOnFirstRun) {
      console.log(
        `[Steam] First run, postOnFirstRun=false — seeding ${fresh.length} deal(s) as seen WITHOUT posting. ` +
          'Delete data/steam_seen.json and set "postOnFirstRun": true to force-post them.',
      );
      this.store.add(
        STEAM_FEED_URL,
        fresh.map((item) => item.id),
      );
      this.store.save();
      this.logger.info(`Steam Deals: seeded ${fresh.length} existing deal(s) silently.`);
      return;
    }

    // Sort oldest-first.
    const ordered = [...fresh].reverse();

    // ── Step 1: Fetch reviews for every fresh item in parallel ─────────────────
    console.log(`[Steam] Fetching reviews for ${ordered.length} deal(s)…`);
    const reviewEntries = await Promise.all(
      ordered.map(async (item): Promise<[string, SteamReviewInfo | null]> => {
        const appId = extractAppId(item.link);
        if (!appId) return [item.id, null];
        return [item.id, await fetchSteamReview(appId)];
      }),
    );
    const reviewMap = new Map<string, SteamReviewInfo | null>(reviewEntries);

    // ── Step 2: Filter by review quality ───────────────────────────────────
    console.log('[Steam] Filtering by review quality…');
    const filtered = ordered.filter((item) => {
      const review = reviewMap.get(item.id);
      if (!review) {
        console.log(`[Steam]   "${item.gameName}" → no review data, skip`);
        return false;
      }
      const pass = isGoodReview(review);
      console.log(
        `[Steam]   "${item.gameName}" → ${review.scoreDesc} (${review.positivePct}%) → ${pass ? 'PASS ✓' : 'SKIP ✗'}`,
      );
      return pass;
    });
    console.log(`[Steam] ${filtered.length}/${ordered.length} deal(s) passed the review filter.`);

    if (filtered.length === 0) {
      console.log('[Steam] No deals passed the review filter. Nothing to post.');
      this.logger.info('Steam Deals: no deals met the review quality threshold.');
      return;
    }

    // ── Step 3: Take top 10 filtered items ────────────────────────────────
    const top = filtered.slice(0, 10);

    // ── Step 4: Fetch live prices for the top items in parallel ─────────────
    console.log(`[Steam] Fetching live prices for ${top.length} deal(s) from Steam API…`);
    const priceEntries = await Promise.all(
      top.map(async (item): Promise<[string, string | null]> => {
        const appId = extractAppId(item.link);
        if (!appId) {
          console.warn(`[Steam] Could not extract app ID from: ${item.link}`);
          return [item.id, null];
        }
        const info = await fetchSteamPrice(appId);
        return [item.id, info ? formatSteamPrice(info) : null];
      }),
    );
    const prices = new Map<string, string | null>(priceEntries);
    console.log(
      `[Steam] Prices fetched: ${[...prices.values()].filter(Boolean).length}/${top.length} successful.`,
    );

    // ── Step 5: Pre-format review strings for the embed ────────────────────
    const reviews = new Map<string, string>();
    for (const item of top) {
      const review = reviewMap.get(item.id);
      if (review) reviews.set(item.id, formatReview(review));
    }

    // ── Step 6: Delete the previous bot message in the channel ──────────────
    await this.deleteLastBotMessage(channel);

    // ── Step 7: Send the digest embed ─────────────────────────────────
    console.log('[Steam] Building digest embed…');
    await channel.send({ embeds: [buildSteamDealsDigestEmbed(top, prices, reviews)] });
    console.log('[Steam] Digest message sent successfully.');

    this.logger.info(
      `Steam Deals: posted ${top.length} deal(s) ` +
        `(${filtered.length}/${ordered.length} passed review filter).`,
    );
    console.log(`[Steam] Done. ${top.length} deal(s) posted.`);
  }

  /**
   * Scans the most recent messages in the channel and deletes the last one
   * posted by this bot. Wrapped in try/catch so a missing or already-deleted
   * message never crashes the poll cycle.
   */
  private async deleteLastBotMessage(channel: SendableChannels): Promise<void> {
    if (!channel.isTextBased()) return;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      const last = recent.find((msg) => msg.author.id === this.client.user?.id);
      if (last) {
        await last.delete();
        console.log(`[Steam] Deleted previous bot message (id: ${last.id}).`);
      } else {
        console.log('[Steam] No previous bot message found in recent history.');
      }
    } catch (error) {
      console.warn('[Steam] Could not delete previous message (may already be deleted):', error);
    }
  }
}
