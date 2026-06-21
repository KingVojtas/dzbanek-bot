import type { Client, Message, SendableChannels } from 'discord.js';
import type { Config } from '../config';
import { buildEpicFreeGamesEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { EpicFreeGame } from '../core/types';

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
  constructor(
    private readonly client: Client,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async poll(): Promise<void> {
    console.log('[Epic] poll() called.');

    let channel: SendableChannels | null;
    try {
      channel = await this.resolveChannel();
    } catch (error) {
      console.error('[Epic] ERROR: Exception while fetching the channel:', error);
      this.logger.error('Epic: exception while fetching channel:', error);
      return;
    }

    if (!channel) {
      console.log('[Epic] poll() aborted — channel not available.');
      return;
    }

    try {
      await this.pollGames(channel);
    } catch (error) {
      console.error('[Epic] ERROR: Unhandled exception in pollGames():', error);
      this.logger.error('Epic: failed to poll free games:', error);
    }

    console.log('[Epic] poll() finished.');
  }

  private async resolveChannel(): Promise<SendableChannels | null> {
    console.log(`[Epic] Fetching channel ID: ${this.config.epic.channelId} …`);
    const channel = await this.client.channels.fetch(this.config.epic.channelId);

    if (!channel) {
      console.warn(`[Epic] WARNING: channel ${this.config.epic.channelId} not found.`);
      this.logger.warn(`Epic: channel ${this.config.epic.channelId} not found.`);
      return null;
    }

    console.log(
      `[Epic] Channel fetched. type=${channel.type} isSendable=${channel.isSendable()}`,
    );

    if (!channel.isSendable()) {
      console.warn(`[Epic] WARNING: channel ${this.config.epic.channelId} is not sendable.`);
      this.logger.warn(`Epic: channel ${this.config.epic.channelId} is not sendable.`);
      return null;
    }

    return channel;
  }

  private async pollGames(channel: SendableChannels): Promise<void> {
    const games = await this.fetchFreeGames();
    const currentCount = games.filter((g) => !g.isUpcoming).length;
    const upcomingCount = games.filter((g) => g.isUpcoming).length;
    console.log(`[Epic] ${currentCount} currently free, ${upcomingCount} upcoming.`);

    if (games.length === 0) {
      console.log('[Epic] No free or upcoming games found. Nothing to post.');
      return;
    }

    // ── Duplicate check ───────────────────────────────────────────────────────
    const lastMessage = await this.findLastBotMessage(channel);
    if (this.isDuplicateEmbed(lastMessage, games)) {
      console.log('[Epic] Free games unchanged since last post — skipping re-post.');
      this.logger.info('Epic: free games unchanged, skipping re-post.');
      return;
    }

    // ── Delete old message and send new embed ─────────────────────────────────
    if (lastMessage) {
      try {
        await lastMessage.delete();
        console.log(`[Epic] Deleted previous bot message (id: ${lastMessage.id}).`);
      } catch {
        console.warn('[Epic] Could not delete previous message (may already be deleted).');
      }
    }

    console.log('[Epic] Building embed…');
    await channel.send({ embeds: [buildEpicFreeGamesEmbed(games)] });
    console.log('[Epic] Embed sent successfully.');
    this.logger.info(
      `Epic: posted free games embed (${currentCount} current, ${upcomingCount} upcoming).`,
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

    return (
      lastTitles.length === newTitles.length && lastTitles.every((t, i) => t === newTitles[i])
    );
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
