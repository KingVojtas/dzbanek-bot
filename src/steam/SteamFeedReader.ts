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
 * content: HTML body (in CDATA) starting with <img>, then blurb, then Price/Expires fields.
 *          We strip all images/links so nothing ugly leaks into Discord embeds.
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
 * Parses the feed content body (HTML inside CDATA from game-deals.app).
 *
 * Images and raw links are stripped so they never appear under games in the embed.
 * Extracts the short game blurb + the structured Price/Expires/etc fields.
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
  // Aggressively remove image tags, markdown images, and image URLs.
  // These were leaking raw <img src="..."> and https://...header.jpg links
  // into every game entry in the Discord embed, making it look ugly.
  const noImages = content
    .replace(/<img[^>]*>/gi, '')
    .replace(/!\[[^\]]*?\]\([^)]*?\)/g, '')
    .replace(/https?:\/\/[^\s"'<>()]+?\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s"'<>()]*)?/gi, '');

  // Description = text content before the Price section.
  // Handle both the feed's HTML (<strong>Price:</strong>) and legacy markdown.
  const priceSplit = noImages.split(/<strong>\s*Price:\s*<\/strong>| \*\*Price:\s*\*\*/i);
  let description =
    (priceSplit[0] || '')
      .replace(/<[^>]+>/g, ' ') // strip any remaining HTML tags
      .replace(/\[View Deal\]\([^)]*\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || undefined;

  if (description && description.length > 160) {
    description = description.slice(0, 160).trim() + '…';
  }

  // Price line can be HTML or markdown in the feed.
  // Example HTML: <strong>Price: </strong>€11.99 <s>€59.99</s> (-80%)
  const priceMatch =
    content.match(
      /(?:<strong>\s*Price:\s*<\/strong>| \*\*Price:\s*\*\*)\s*(\S+)\s+(?:<s>|~~)?(\S+)(?:<\/s>|~~)?\s*\(([^)]+)\)/i,
    ) || content.match(/\*\*Price:\s*\*\*\s*(\S+)\s+(\S+)\s+\(([^)]+)\)/);

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
 * Extracts the value from a `**FieldName: **value` or `<strong>FieldName: </strong>value` line.
 * Returns `undefined` if the field is absent. Supports the HTML the feed actually uses.
 */
function extractField(content: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // HTML style from the feed: <strong>Expires: </strong>2026-06-25
  let match = content.match(new RegExp(`<strong>\\s*${escaped}:\\s*</strong>\\s*([^<\\n]+)`, 'i'));
  if (match?.[1]) return match[1].trim();
  // Markdown style
  match = content.match(new RegExp(`\\*\\*${escaped}:\\s*\\*\\*\\s*([^\\n*]+)`));
  return match?.[1]?.trim() || undefined;
}
