/**
 * Fetches live pricing data for Steam apps via the Steam Store appdetails API.
 *
 * Endpoint: https://store.steampowered.com/api/appdetails?appids=<ID>&filters=price_overview&cc=<CC>
 *
 * The `cc` country code controls the currency returned.
 * Change PRICE_CC below to match your preferred currency:
 *   'de' → EUR  |  'us' → USD  |  'gb' → GBP  |  'pl' → PLN  |  'cz' → CZK
 */

const PRICE_CC = 'de'; // country code → determines currency
const API_URL = 'https://store.steampowered.com/api/appdetails';

// ─── Raw API types ─────────────────────────────────────────────────────────────

interface RawPriceOverview {
  currency: string;
  initial: number; // price in cents (e.g. 1999 = $19.99)
  final: number; // discounted price in cents
  discount_percent: number; // e.g. 75
  initial_formatted: string; // pre-formatted by Steam, e.g. "19,99€" or "$19.99"
  final_formatted: string; // e.g. "4,99€" or "$4.99"
}

interface RawAppEntry {
  success: boolean;
  data?: { price_overview?: RawPriceOverview };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface SteamPriceInfo {
  /** Pre-formatted original price from Steam, e.g. "41,99€" */
  initialFormatted: string;
  /** Pre-formatted discounted price from Steam, e.g. "8,39€" */
  finalFormatted: string;
  /** Numeric discount percentage, e.g. 80 */
  discountPercent: number;
}

/**
 * Extracts the Steam numeric app ID from a store page URL.
 * "https://store.steampowered.com/app/960170/DJMAX_RESPECT_V/" → "960170"
 */
export function extractAppId(link: string): string | null {
  const match = link.match(/store\.steampowered\.com\/app\/(\d+)\//);
  return match?.[1] ?? null;
}

/**
 * Fetches price info for one app from the Steam Store API.
 * Returns null when the game is free-to-play, region-locked, or the request fails.
 */
export async function fetchSteamPrice(appId: string): Promise<SteamPriceInfo | null> {
  const url = `${API_URL}?appids=${appId}&filters=price_overview&cc=${PRICE_CC}`;
  console.log(`[Steam API] Fetching price for app ${appId}…`);

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    console.error(`[Steam API] Network error for app ${appId}:`, error);
    return null;
  }

  if (!response.ok) {
    console.warn(`[Steam API] HTTP ${response.status} for app ${appId}.`);
    return null;
  }

  let json: Record<string, RawAppEntry>;
  try {
    json = (await response.json()) as Record<string, RawAppEntry>;
  } catch (error) {
    console.error(`[Steam API] JSON parse error for app ${appId}:`, error);
    return null;
  }

  const entry = json[appId];
  if (!entry?.success) {
    console.warn(`[Steam API] success=false for app ${appId}.`);
    return null;
  }

  const price = entry.data?.price_overview;
  if (!price) {
    // Free-to-play games have no price_overview object.
    console.log(
      `[Steam API] No price_overview for app ${appId} (free-to-play or not yet released).`,
    );
    return null;
  }

  console.log(
    `[Steam API] App ${appId}: ${price.initial_formatted} → ${price.final_formatted} (-${price.discount_percent}%)`,
  );

  return {
    initialFormatted: price.initial_formatted,
    finalFormatted: price.final_formatted,
    discountPercent: price.discount_percent,
  };
}

/**
 * Formats a SteamPriceInfo into a Discord markdown price string.
 *
 * Example output: `~~41,99€~~ -> **8,39€** (-80%)`
 */
export function formatSteamPrice(info: SteamPriceInfo): string {
  return `~~${info.initialFormatted}~~ -> **${info.finalFormatted}** (-${info.discountPercent}%)`;
}
