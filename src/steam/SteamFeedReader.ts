import Parser from 'rss-parser';
import type { SteamDealItem } from '../core/types';

export const STEAM_FEED_URL = 'https://game-deals.app/rss/discounts/steam';

/**
 * Reads the game-deals.app Steam discount RSS feed and normalises each item.
 *
 * Feed item anatomy
 * ─────────────────
 * title  : "DJMAX RESPECT V (-80% €8.39)"
 * link   : https://store.steampowered.com/app/960170/…
 * guid   : steam_960170_25June   ← stable dedup key
 * content: markdown body with a description paragraph followed by
 *          structured **Key: **Value lines (Price, Expires, Publisher, …)
 */
export class SteamFeedReader {
  private readonly parser = new Parser();

  async read(): Promise<SteamDealItem[]> {
    console.log(`[Steam] Fetching RSS feed from: ${STEAM_FEED_URL}`);

    let parsed: Awaited<ReturnType<Parser['parseURL']>>;
    try {
      parsed = await this.parser.parseURL(STEAM_FEED_URL);
    } catch (error) {
      console.error('[Steam] ERROR: Failed to fetch/parse RSS feed:', error);
      throw error;
    }

    const rawCount = parsed.items?.length ?? 0;
    console.log(`[Steam] Feed downloaded. ${rawCount} raw item(s) received.`);

    if (rawCount === 0) {
      console.warn(
        '[Steam] WARNING: Feed returned 0 items — the feed may be empty or temporarily unreachable.',
      );
    }

    const items = (parsed.items ?? []).map((item, i) => {
      const deal = toSteamDealItem(item);
      console.log(
        `[Steam]   [${i + 1}/${rawCount}] "${deal.gameName}" | ` +
          `${deal.salePrice ?? '?'} (was ${deal.originalPrice ?? '?'}, ${deal.discount ?? '?'}) | ` +
          `expires: ${deal.expires ?? 'N/A'} | score: ${deal.dealScore ?? 'N/A'} | ` +
          `id: ${deal.id}`,
      );
      return deal;
    });

    console.log(`[Steam] Parsed ${items.length} deal item(s) from feed.`);
    return items;
  }
}

// ─── Item mapping ──────────────────────────────────────────────────────────────

function toSteamDealItem(item: Parser.Item): SteamDealItem {
  // rss-parser puts <content:encoded> (or <description>) into item.content.
  const content = item.content ?? item.contentSnippet ?? '';
  const link = item.link ?? '';
  return {
    id: item.guid ?? link ?? item.title ?? '',
    title: item.title ?? 'Unknown Deal',
    gameName: extractGameName(item.title ?? ''),
    link,
    image: extractAppImage(link),
    isoDate: item.isoDate,
    ...parseContent(content),
  };
}

/**
 * Strips the trailing price/discount annotation from the feed title.
 * "DJMAX RESPECT V (-80% €8.39)"  →  "DJMAX RESPECT V"
 */
function extractGameName(title: string): string {
  const match = title.match(/^(.+?)\s+\(-?\d+%/);
  return match ? match[1].trim() : title;
}

/**
 * Derives the Steam CDN header image URL from a store page link.
 * "https://store.steampowered.com/app/960170/…"
 *   →  "https://cdn.akamai.steamstatic.com/steam/apps/960170/header.jpg"
 */
function extractAppImage(link: string): string | undefined {
  const match = link.match(/store\.steampowered\.com\/app\/(\d+)\//);
  if (!match) return undefined;
  return `https://cdn.akamai.steamstatic.com/steam/apps/${match[1]}/header.jpg`;
}

// ─── Content parsing ───────────────────────────────────────────────────────────

/**
 * Parses the markdown-formatted feed content body.
 *
 * The body always follows this structure:
 *
 *   [game description paragraph(s)]
 *
 *   **Price: **€8.39 €41.99 (-80%)
 *   **Expires: **2026-06-25
 *   **Publisher: **Neowiz           ← optional
 *   **IGDB Rating: **79/100         ← optional
 *   **Metascore: **84/100           ← optional
 *   **Deal Score: **79.2/100        ← optional
 *   **Genres: **Music, Arcade       ← optional
 *   **Source: **Steam Game
 */
function parseContent(content: string): {
  description?: string;
  salePrice?: string;
  originalPrice?: string;
  discount?: string;
  expires?: string;
  publisher?: string;
  igdbRating?: string;
  metascore?: string;
  dealScore?: string;
  genres?: string;
} {
  // Description = everything before the first **Price:** block.
  const priceSplit = content.split(/\*\*Price:\s*\*\*/);
  const description =
    priceSplit[0]
      ?.replace(/\[View Deal\]\([^)]*\)/gi, '') // strip inline "View Deal" links
      ?.trim() || undefined;

  // "**Price: **€8.39 €41.99 (-80%)"
  // Groups: 1 = sale price, 2 = original price, 3 = discount string
  const priceMatch = content.match(/\*\*Price:\s*\*\*\s*(\S+)\s+(\S+)\s+\(([^)]+)\)/);

  return {
    description,
    salePrice: priceMatch?.[1]?.trim(),
    originalPrice: priceMatch?.[2]?.trim(),
    discount: priceMatch?.[3]?.trim(),
    expires: extractField(content, 'Expires'),
    publisher: extractField(content, 'Publisher'),
    igdbRating: extractField(content, 'IGDB Rating'),
    metascore: extractField(content, 'Metascore'),
    dealScore: extractField(content, 'Deal Score'),
    genres: extractField(content, 'Genres'),
  };
}

/**
 * Extracts the value from a `**FieldName: **value` line.
 * Returns `undefined` if the field is absent.
 */
function extractField(content: string, name: string): string | undefined {
  // Escape any regex-special chars in the field name (e.g. nothing here, but safe).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`\\*\\*${escaped}:\\s*\\*\\*\\s*([^\\n*]+)`));
  return match?.[1]?.trim() || undefined;
}
