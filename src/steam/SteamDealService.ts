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
import { GuildSettingsRepository } from '../db/repositories';
import type { SeenStore } from '../news/SeenStore';
import type { SteamDealItem } from '../core/types';
import type { WishlistStore } from '../wishlist/WishlistStore';
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

    let channels: SendableChannels[];
    try {
      channels = await this.resolveChannels();
    } catch (error) {
      console.error('[Steam] ERROR: Exception while fetching channels:', error);
      this.logger.error('Steam: exception while fetching channels:', error);
      return;
    }

    if (channels.length === 0) {
      console.log('[Steam] poll() aborted — no channels available.');
      return;
    }

    try {
      await this.pollDeals(channels);
    } catch (error) {
      console.error('[Steam] ERROR: Unhandled exception in pollDeals():', error);
      this.logger.error('Steam: failed to poll deals:', error);
    }

    console.log('[Steam] poll() finished.');
  }

  /**
   * Collect unique channel IDs from legacy config + enabled GuildSettings.
   */
  private async resolveChannels(): Promise<SendableChannels[]> {
    const channelIds = new Set<string>();

    if (this.config.steam.channelId) {
      channelIds.add(this.config.steam.channelId);
    }

    try {
      const rows = await this.guildSettings.findSteamEnabled();
      for (const row of rows) {
        if (row.steamChannelId) channelIds.add(row.steamChannelId);
      }
    } catch (error) {
      this.logger.warn('Steam: failed to load guild settings for channels:', error);
    }

    const channels: SendableChannels[] = [];
    for (const channelId of channelIds) {
      console.log(`[Steam] Fetching channel ID: ${channelId} …`);
      try {
        const channel = await this.client.channels.fetch(channelId);

        if (!channel) {
          console.warn(
            `[Steam] WARNING: channel ${channelId} not found. ` +
              'Confirm the bot is in the guild and the channel ID is correct.',
          );
          this.logger.warn(`Steam: channel ${channelId} not found.`);
          continue;
        }

        console.log(
          `[Steam] Channel fetched. type=${channel.type} isSendable=${channel.isSendable()} id=${channel.id}`,
        );

        if (!channel.isSendable()) {
          console.warn(
            `[Steam] WARNING: channel ${channelId} is not sendable ` +
              '(may be a category/voice channel, or the bot is missing Send Messages permission).',
          );
          this.logger.warn(`Steam: channel ${channelId} is not sendable.`);
          continue;
        }

        channels.push(channel);
      } catch (error) {
        this.logger.warn(`Steam: failed to fetch channel ${channelId}:`, error);
      }
    }

    return channels;
  }

  private async pollDeals(channels: SendableChannels[]): Promise<void> {
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
      const seen = await this.store.has(STEAM_FEED_URL, item.id);
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
    if ((await this.store.isEmpty(STEAM_FEED_URL)) && !this.config.steam.postOnFirstRun) {
      console.log(
        `[Steam] First run, postOnFirstRun=false — seeding ${fresh.length} deal(s) as seen WITHOUT posting. ` +
          'Delete data/steam_seen.json and set "postOnFirstRun": true to force-post them.',
      );
      await this.store.add(
        STEAM_FEED_URL,
        fresh.map((item) => item.id),
      );
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

    // Wishlist DMs for every fresh deal (not only the public review-filtered digest).
    // Users were promised alerts when *their* games go on sale.
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
              console.log(`[Steam] Wishlist DM sent to ${uid} for ${item.gameName}`);
            } catch (dmErr) {
              console.warn(`[Steam] Failed to DM wishlist user ${uid}:`, dmErr);
            }
          }
        }
      } catch (e) {
        console.warn('[Steam] Wishlist matching error:', e);
      }
    }

    if (filtered.length === 0) {
      console.log('[Steam] No deals passed the review filter. Nothing to post to channel.');
      this.logger.info('Steam Deals: no deals met the review quality threshold for the digest.');
      // Still mark processed so we don't re-DM / re-scan forever.
      await this.store.add(
        STEAM_FEED_URL,
        ordered.map((item) => item.id),
      );
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

    // ── Step 6–7: Per channel — duplicate check, delete old, post digest ───
    console.log('[Steam] Building digest embed…');
    const embed = buildSteamDealsDigestEmbed(top, prices, reviews);

    // Build an interactive "Add to wishlist" select menu for the bot's wishlist system.
    const selectOptions = top
      .map((item) => {
        const appId = extractAppId(item.link);
        const value = appId ?? `name:${item.gameName.toLowerCase().slice(0, 80)}`;
        const discount = item.discount ? ` ${item.discount}` : '';
        const label = item.gameName.slice(0, 100);
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
          .setDescription(`Add to bot wishlist${discount}`.slice(0, 100));
      })
      .slice(0, 25); // Discord max 25 options

    const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

    if (selectOptions.length > 0) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('wishlist:add')
        .setPlaceholder('❤️ Add to my wishlist (get notified on sales)')
        .setMinValues(1)
        .setMaxValues(Math.min(5, selectOptions.length))
        .addOptions(selectOptions);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    }

    let postedTo = 0;
    for (const channel of channels) {
      try {
        const lastMessage = await this.findLastBotMessage(channel);

        if (this.isDuplicateDigest(lastMessage, top)) {
          console.log(`[Steam] Channel ${channel.id}: digest identical to last post — skipping.`);
          continue;
        }

        if (lastMessage) {
          try {
            await lastMessage.delete();
            console.log(
              `[Steam] Deleted previous bot message in ${channel.id} (id: ${lastMessage.id}).`,
            );
          } catch {
            console.warn(
              `[Steam] Could not delete previous message in ${channel.id} (may already be deleted).`,
            );
          }
        }

        const sentMessage = await channel.send({
          embeds: [embed],
          components,
        });

        try {
          await sentMessage.react('🔥');
          await sentMessage.react('💰');
          await sentMessage.react('👍');
        } catch {
          // ignore reaction permission errors
        }
        postedTo += 1;
        console.log(`[Steam] Digest message sent to channel ${channel.id}.`);
      } catch (error) {
        this.logger.error(`Steam: failed to post digest to channel ${channel.id}:`, error);
      }
    }

    // Mark all fresh deals seen so wishlist DMs and review work don't repeat next poll.
    await this.store.add(
      STEAM_FEED_URL,
      ordered.map((item) => item.id),
    );

    this.logger.info(
      `Steam Deals: posted ${top.length} deal(s) to ${postedTo}/${channels.length} channel(s) ` +
        `(${filtered.length}/${ordered.length} passed review filter).`,
    );
    console.log(`[Steam] Done. ${top.length} deal(s) posted to ${postedTo} channel(s).`);
  }

  /**
   * Returns the most recent message posted by this bot in the channel,
   * or null if none is found or the fetch fails.
   */
  private async findLastBotMessage(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      return recent.find((msg) => msg.author.id === this.client.user?.id) ?? null;
    } catch {
      console.warn('[Steam] Could not fetch recent messages for duplicate check.');
      return null;
    }
  }

  /**
   * Compares the game lineup we are about to post against the last bot message
   * already in the channel.
   *
   * The embed stores each game as a field named "N. Game Name".
   * We strip the numeric prefix and compare titles in order — if every title
   * matches, the digest is identical and we skip the re-post.
   */
  private isDuplicateDigest(lastMessage: Message | null, top: SteamDealItem[]): boolean {
    if (!lastMessage || lastMessage.embeds.length === 0 || top.length === 0) return false;

    const lastTitles = lastMessage.embeds[0].fields.map((f) =>
      f.name.replace(/^\d+\.\s*/, '').trim(),
    );
    const newTitles = top.map((item) => item.gameName);

    console.log(`[Steam] Last posted titles:  ${lastTitles.join(' | ')}`);
    console.log(`[Steam] New digest titles:   ${newTitles.join(' | ')}`);

    return (
      lastTitles.length === newTitles.length &&
      lastTitles.every((title, i) => title === newTitles[i])
    );
  }
}
