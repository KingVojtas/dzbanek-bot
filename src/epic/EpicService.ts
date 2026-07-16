import type { Client, Message, SendableChannels } from 'discord.js';
import { buildEpicFreeGamesEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { EpicFreeGame } from '../core/types';
import { GuildSettingsRepository, type GuildSettings } from '../db/repositories';
import type { StatsStore } from '../stats/StatsStore';
import { isPostHourNow } from '../utils/digest-schedule';
import { resolveGuildSendableChannel } from '../utils/guild-channel';

type EpicTarget = {
  channel: SendableChannels;
  settings: GuildSettings;
};

const EPIC_API_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
  '?locale=en-US&country=US&allowCountries=US';

// ─── Raw API shape (minimal — only fields we use) ─────────────────────────────

interface RawKeyImage {
  type: string;
  url: string;
}

interface RawPromoOffer {
  startDate: string;
  endDate: string;
  discountSetting: { discountType: string; discountPercentage: number };
}

interface RawPromoGroup {
  promotionalOffers: RawPromoOffer[];
}

interface RawMapping {
  pageSlug: string;
  pageType: string;
}

interface RawElement {
  title: string;
  description: string;
  keyImages: RawKeyImage[];
  seller: { name: string };
  productSlug: string | null;
  catalogNs: { mappings: RawMapping[] | null };
  offerMappings: RawMapping[] | null;
  price: {
    totalPrice: {
      discountPrice: number;
      originalPrice: number;
      fmtPrice: { originalPrice: string };
    };
  };
  promotions: {
    promotionalOffers: RawPromoGroup[];
    upcomingPromotionalOffers: RawPromoGroup[];
  } | null;
}

interface RawApiResponse {
  data: { Catalog: { searchStore: { elements: RawElement[] } } };
}

// ─── Service ──────────────────────────────────────────────────────────────────

/** Polls the Epic Games Store API and posts the weekly free games as an embed. */
export class EpicService {
  private readonly guildSettings = new GuildSettingsRepository();

  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
    private readonly stats?: StatsStore,
  ) {}

  async poll(): Promise<void> {
    console.log('[Epic] poll() called.');

    let targets: EpicTarget[];
    try {
      targets = await this.resolveTargets();
    } catch (error) {
      console.error('[Epic] ERROR: Exception while fetching channels:', error);
      this.logger.error('Epic: exception while fetching channels:', error);
      return;
    }

    if (targets.length === 0) {
      console.log('[Epic] poll() aborted — no channels available.');
      return;
    }

    try {
      await this.pollGames(targets);
    } catch (error) {
      console.error('[Epic] ERROR: Unhandled exception in pollGames():', error);
      this.logger.error('Epic: failed to poll free games:', error);
    }

    console.log('[Epic] poll() finished.');
  }

  /** One post per enabled guild — channel must belong to that guild. */
  private async resolveTargets(): Promise<EpicTarget[]> {
    const byGuild = new Map<string, EpicTarget>();

    try {
      const rows = await this.guildSettings.findEpicEnabled();
      for (const row of rows) {
        if (!row.epicChannelId) continue;
        const ch = await resolveGuildSendableChannel(
          this.client,
          row.epicChannelId,
          row.guildId,
        );
        if (!ch) {
          this.logger.warn(
            `Epic: skip guild ${row.guildId} — channel ${row.epicChannelId} missing or not in that server.`,
          );
          continue;
        }
        byGuild.set(row.guildId, { channel: ch, settings: row });
      }
    } catch (error) {
      this.logger.warn('Epic: failed to load guild settings for channels:', error);
    }

    return [...byGuild.values()];
  }

  private async pollGames(targets: EpicTarget[]): Promise<void> {
    const games = await this.fetchFreeGames();
    const currentCount = games.filter((g) => !g.isUpcoming).length;
    const upcomingCount = games.filter((g) => g.isUpcoming).length;
    console.log(`[Epic] ${currentCount} currently free, ${upcomingCount} upcoming.`);

    if (games.length === 0) {
      console.log('[Epic] No free or upcoming games found. Nothing to post.');
      return;
    }

    console.log('[Epic] Building embed…');
    const embed = buildEpicFreeGamesEmbed(games);
    let postedTo = 0;

    for (const target of targets) {
      if (!isPostHourNow(target.settings.epicPostHourUtc ?? null)) {
        console.log(
          `[Epic] Skip channel ${target.channel.id} — post hour UTC ${target.settings.epicPostHourUtc}`,
        );
        continue;
      }

      const channel = target.channel;
      try {
        const lastMessage = await this.findLastBotMessage(channel);
        if (this.isDuplicateEmbed(lastMessage, games)) {
          console.log(`[Epic] Channel ${channel.id}: free games unchanged — skipping re-post.`);
          continue;
        }

        if (lastMessage) {
          try {
            await lastMessage.delete();
          } catch {
            /* ignore */
          }
        }

        const sentMessage = await channel.send({
          embeds: [embed],
        });
        try {
          await sentMessage.react('🎁');
          await sentMessage.react('🆓');
          await sentMessage.react('⭐');
        } catch {
          /* ignore */
        }
        // Public website Deals Pulse (once per successful post cycle — first channel only)
        if (this.stats && postedTo === 0) {
          for (const g of games.filter((x) => !x.isUpcoming).slice(0, 5)) {
            this.stats.pushRecentDeal({
              source: 'epic',
              title: g.title,
              subtitle: 'Free now on Epic Games Store',
            });
          }
        }
        postedTo += 1;
        console.log(`[Epic] Embed sent to channel ${channel.id}.`);
      } catch (error) {
        this.logger.error(`Epic: failed to post to channel ${channel.id}:`, error);
      }
    }

    this.logger.info(
      `Epic: posted free games embed to ${postedTo}/${targets.length} channel(s) ` +
        `(${currentCount} current, ${upcomingCount} upcoming).`,
    );
  }

  private async fetchFreeGames(): Promise<EpicFreeGame[]> {
    console.log('[Epic] Fetching free games from Epic API…');

    let response: Response;
    try {
      response = await fetch(EPIC_API_URL, { headers: { Accept: 'application/json' } });
    } catch (error) {
      console.error('[Epic] Network error fetching Epic API:', error);
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Epic API returned HTTP ${response.status}`);
    }

    let json: RawApiResponse;
    try {
      json = (await response.json()) as RawApiResponse;
    } catch (error) {
      console.error('[Epic] JSON parse error:', error);
      throw error;
    }

    const elements = json.data?.Catalog?.searchStore?.elements ?? [];
    console.log(`[Epic] API returned ${elements.length} element(s).`);

    const current: EpicFreeGame[] = [];
    const upcoming: EpicFreeGame[] = [];

    for (const el of elements) {
      if (isCurrentlyFree(el)) {
        const end = getActiveEndDate(el);
        console.log(`[Epic]   CURRENT FREE: "${el.title}" (ends: ${end ?? 'unknown'})`);
        current.push(toEpicFreeGame(el, false));
      } else if (isUpcomingFree(el)) {
        const start = getUpcomingStartDate(el);
        console.log(`[Epic]   UPCOMING FREE: "${el.title}" (starts: ${start ?? 'unknown'})`);
        upcoming.push(toEpicFreeGame(el, true));
      }
    }

    return [...current, ...upcoming];
  }

  private async findLastBotMessage(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      return recent.find((msg) => msg.author.id === this.client.user?.id) ?? null;
    } catch {
      console.warn('[Epic] Could not fetch recent messages for duplicate check.');
      return null;
    }
  }

  /**
   * Compares the game titles in the last bot embed against the new lineup.
   * The separator field (\u200b) is excluded from the comparison.
   */
  private isDuplicateEmbed(lastMessage: Message | null, games: EpicFreeGame[]): boolean {
    if (!lastMessage || lastMessage.embeds.length === 0 || games.length === 0) return false;

    const lastTitles = lastMessage.embeds[0].fields
      .map((f) => f.name.trim())
      .filter((name) => name !== '\u200b');

    const newTitles = games.map((g) => g.title);

    console.log(`[Epic] Last posted: ${lastTitles.join(' | ')}`);
    console.log(`[Epic] New games:   ${newTitles.join(' | ')}`);

    return lastTitles.length === newTitles.length && lastTitles.every((t, i) => t === newTitles[i]);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True when a game is free right now (discountPrice 0, full-price original, active 100% promo). */
function isCurrentlyFree(el: RawElement): boolean {
  const { discountPrice, originalPrice } = el.price.totalPrice;
  if (discountPrice !== 0 || originalPrice === 0) return false;
  return (el.promotions?.promotionalOffers ?? []).some((g) =>
    g.promotionalOffers.some((o) => o.discountSetting.discountPercentage === 0),
  );
}

/** True when a game will be free in a future promotion. */
function isUpcomingFree(el: RawElement): boolean {
  return (el.promotions?.upcomingPromotionalOffers ?? []).some((g) =>
    g.promotionalOffers.some((o) => o.discountSetting.discountPercentage === 0),
  );
}

function getActiveEndDate(el: RawElement): string | undefined {
  return el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0]?.endDate;
}

function getUpcomingStartDate(el: RawElement): string | undefined {
  return el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0]?.startDate;
}

function getUpcomingEndDate(el: RawElement): string | undefined {
  return el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0]?.endDate;
}

/** Picks OfferImageWide first, then Thumbnail, then any image. */
function getImage(el: RawElement): string | undefined {
  const preferred = ['OfferImageWide', 'Thumbnail'];
  for (const type of preferred) {
    const found = el.keyImages.find((img) => img.type === type);
    if (found) return found.url;
  }
  return el.keyImages[0]?.url;
}

/** Builds the canonical Epic Store product URL from available slugs. */
function buildStoreUrl(el: RawElement): string {
  const slug =
    el.catalogNs.mappings?.find((m) => m.pageType === 'productHome')?.pageSlug ??
    el.offerMappings?.find((m) => m.pageType === 'productHome')?.pageSlug ??
    el.productSlug ??
    null;
  return slug
    ? `https://store.epicgames.com/en-US/p/${slug}`
    : 'https://store.epicgames.com/en-US/free-games';
}

function toEpicFreeGame(el: RawElement, isUpcoming: boolean): EpicFreeGame {
  return {
    title: el.title,
    description: el.description,
    originalPrice: el.price.totalPrice.fmtPrice.originalPrice,
    storeUrl: buildStoreUrl(el),
    image: getImage(el),
    seller: el.seller?.name || undefined,
    endDate: isUpcoming ? getUpcomingEndDate(el) : getActiveEndDate(el),
    isUpcoming,
    upcomingStartDate: isUpcoming ? getUpcomingStartDate(el) : undefined,
  };
}
