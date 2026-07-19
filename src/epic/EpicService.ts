import type { Client, Message, SendableChannels } from 'discord.js';
import {
  buildEpicFreeGamesDisplay,
  collectMessageTextContent,
  epicDigestFingerprint,
  extractEpicDigestFingerprint,
  selectEpicDisplayLineup,
} from '../core/display';
import type { Logger } from '../core/logger';
import type { EpicFreeGame } from '../core/types';
import { GuildSettingsRepository, SeenRepository, type GuildSettings } from '../db/repositories';
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

/** Durable lineup key: one scope per channel so restarts don't re-spam the same free games. */
function epicLineupScope(channelId: string): string {
  return `epic-lineup:${channelId}`;
}

/** Polls the Epic Games Store API and posts the weekly free games as an embed. */
export class EpicService {
  private readonly guildSettings = new GuildSettingsRepository();
  /** Persists last posted lineup fingerprint per channel (SQLite DedupEntry). */
  private readonly lineupStore = new SeenRepository(20);
  /** Prevent concurrent poll() from double-posting during deploys. */
  private pollInFlight: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
    private readonly stats?: StatsStore,
  ) {}

  async poll(): Promise<void> {
    if (this.pollInFlight) {
      console.log('[Epic] poll() already running — joining in-flight run.');
      return this.pollInFlight;
    }
    this.pollInFlight = this.runPoll().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async runPoll(): Promise<void> {
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
      console.log(
        '[Epic] No Discord channels configured — still fetching free games for website Deals Pulse.',
      );
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
        const ch = await resolveGuildSendableChannel(this.client, row.epicChannelId, row.guildId);
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

    // Deals Pulse for the website — always refresh from Epic API results,
    // even when Discord re-posts are skipped (post hour / duplicate).
    if (this.stats) {
      const freeNow = games.filter((g) => !g.isUpcoming).slice(0, 5);
      const upcoming = games.filter((g) => g.isUpcoming).slice(0, 3);
      const pulse =
        freeNow.length > 0
          ? freeNow.map((g) => ({
              title: g.title,
              subtitle: 'Free now on Epic Games Store',
            }))
          : upcoming.map((g) => ({
              title: g.title,
              subtitle: 'Upcoming free on Epic',
            }));
      this.stats.setDealsForSource('epic', pulse);
      console.log(`[Epic] Deals Pulse: published ${pulse.length} game(s) to /api/stats.`);
    }

    console.log('[Epic] Building free-games display…');
    const display = buildEpicFreeGamesDisplay(games);
    // Fingerprint matches what we actually put in the message (after size caps).
    const lineup = selectEpicDisplayLineup(games);
    const fingerprint = epicDigestFingerprint(lineup);
    let postedTo = 0;

    for (const target of targets) {
      if (!isPostHourNow(target.settings.epicPostHourUtc ?? null)) {
        console.log(
          `[Epic] Skip channel ${target.channel.id} — post hour UTC ${target.settings.epicPostHourUtc}`,
        );
        continue;
      }

      const channel = target.channel;
      const scope = epicLineupScope(channel.id);
      try {
        const previous = await this.findAllEpicDigests(channel);
        const alreadyPosted = await this.lineupStore.has(scope, fingerprint);

        // Primary dedupe: SQLite survives restarts/deploys. Without this, every
        // Railway restart re-posted the same free games 2–3× in a few minutes.
        if (alreadyPosted) {
          if (previous.length > 1) {
            // Keep newest, delete extras only — do not send a new message.
            const deleted = await this.deleteEpicDigests(previous.slice(1));
            if (deleted > 0) {
              console.log(
                `[Epic] Channel ${channel.id}: lineup already posted — cleaned ${deleted} extra message(s).`,
              );
            }
          } else if (previous.length === 0) {
            // Store says posted but message gone (manual delete) — allow re-post below.
            console.log(
              `[Epic] Channel ${channel.id}: lineup in store but no message found — re-posting.`,
            );
          } else {
            console.log(
              `[Epic] Channel ${channel.id}: free games unchanged (stored fingerprint) — skipping.`,
            );
            continue;
          }
          if (previous.length >= 1) continue;
        } else {
          // Secondary: message content still matches (legacy / pre-store posts)
          const newest = previous[0] ?? null;
          if (newest && this.isCurrentDigestUpToDate(newest, games) && previous.length === 1) {
            await this.lineupStore.add(scope, [fingerprint]);
            console.log(
              `[Epic] Channel ${channel.id}: free games unchanged (message match) — recorded fingerprint, skipping.`,
            );
            continue;
          }
        }

        // New lineup (or missing message) — replace digests with one fresh post.
        const deleted = await this.deleteEpicDigests(previous);
        if (deleted > 0) {
          console.log(
            `[Epic] Channel ${channel.id}: deleted ${deleted} old free-games message(s).`,
          );
        }

        const sentMessage = await channel.send({
          components: display.components,
          flags: display.flags,
        });
        try {
          await sentMessage.react('🎁');
          await sentMessage.react('🆓');
          await sentMessage.react('⭐');
        } catch {
          /* ignore */
        }
        await this.lineupStore.add(scope, [fingerprint]);
        postedTo += 1;
        console.log(
          `[Epic] Digest sent to channel ${channel.id} (fp=${fingerprint.slice(0, 48)}…).`,
        );
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

  /**
   * All bot messages that look like Epic free-games digests, newest first.
   * Includes legacy embeds and older Components V2 posts without a fingerprint.
   */
  private async findAllEpicDigests(channel: SendableChannels): Promise<Message[]> {
    if (!channel.isTextBased()) return [];
    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      const mine = [...recent.values()]
        .filter((msg) => msg.author.id === this.client.user?.id)
        .filter((msg) => this.looksLikeEpicDigest(msg))
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      return mine;
    } catch {
      console.warn('[Epic] Could not fetch recent messages for digest cleanup.');
      return [];
    }
  }

  private looksLikeEpicDigest(msg: Message): boolean {
    if (extractEpicDigestFingerprint(msg) != null) return true;
    if (msg.embeds.some((e) => /epic/i.test(e.title ?? '') || /epic free/i.test(e.title ?? ''))) {
      return true;
    }
    if (msg.embeds.some((e) => /epic/i.test(e.footer?.text ?? ''))) return true;
    const blob = collectMessageTextContent(msg);
    return /epic free games|epic free|🎁 epic|free this week/i.test(blob);
  }

  /** Delete prior digests; returns how many were deleted successfully. */
  private async deleteEpicDigests(messages: Message[]): Promise<number> {
    let deleted = 0;
    for (const msg of messages) {
      try {
        await msg.delete();
        deleted += 1;
      } catch (err) {
        // 10008 unknown message — already gone
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code: unknown }).code
            : undefined;
        if (code !== 10008) {
          this.logger.warn(`Epic: failed to delete old digest ${msg.id}:`, err);
        }
      }
    }
    return deleted;
  }

  /**
   * True when the channel already shows this week's lineup.
   * Prefers embedded fingerprint (legacy posts), then title match from body text.
   * Messages that still contain a visible `epic-digest:` marker with a different
   * lineup (or junk) are treated as outdated so they get deleted and replaced.
   */
  private isCurrentDigestUpToDate(lastMessage: Message, games: EpicFreeGame[]): boolean {
    if (games.length === 0) return false;

    const current = games.filter((g) => !g.isUpcoming);
    const upcoming = games.filter((g) => g.isUpcoming);
    const lineup = [...current, ...upcoming];
    const nextFp = epicDigestFingerprint(lineup);
    const prevFp = extractEpicDigestFingerprint(lastMessage);
    const blob = collectMessageTextContent(lastMessage);

    // Old posts with a visible marker: only skip if fingerprint matches exactly
    if (prevFp != null) {
      const same = prevFp === nextFp;
      console.log(`[Epic] Fingerprint check: ${same}`);
      return same;
    }

    // Visible marker text still in the body (corrupt/partial) → replace to clean up
    if (/epic-digest:/i.test(blob)) {
      console.log('[Epic] Visible epic-digest junk in message — will replace.');
      return false;
    }

    // Clean V2 / embed: same titles all present
    const newTitles = lineup.map((g) => g.title);
    if (newTitles.length === 0) return false;

    if (lastMessage.embeds.length > 0) {
      const lastTitles = lastMessage.embeds[0].fields
        .map((f) => f.name.trim())
        .filter((name) => name !== '\u200b');
      if (
        lastTitles.length === newTitles.length &&
        lastTitles.every((t, i) => t === newTitles[i])
      ) {
        return true;
      }
      // Old embed with different layout but same games — still upgrade once to new UI
      // only if titles match as a set and message already looks like new layout
      return false;
    }

    const allTitlesPresent = newTitles.every((t) => blob.includes(t.slice(0, 40)));
    const headerCount = (blob.match(/###\s/g) ?? []).length;
    // New layout uses one ### per game
    if (allTitlesPresent && headerCount === newTitles.length) {
      console.log('[Epic] Title match (no fingerprint) — up to date.');
      return true;
    }

    if (allTitlesPresent && /epic free games/i.test(blob) && headerCount === 0) {
      // Ambiguous — re-post clean version without digest junk if junk-like
      return !/steam-digest:|epic-digest:/i.test(blob);
    }

    return false;
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

/**
 * Prefer square/portrait art for Components V2 section thumbnails,
 * then wide hero art as a fallback.
 */
function getImage(el: RawElement): string | undefined {
  const preferred = ['Thumbnail', 'DieselStoreFrontWide', 'OfferImageTall', 'OfferImageWide'];
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
