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
 * Example output: `~~41,99€~~ → **8,39€** (-80%)`
 */
export function formatSteamPrice(info: SteamPriceInfo): string {
  return `~~${info.initialFormatted}~~ → **${info.finalFormatted}** (-${info.discountPercent}%)`;
}

// ─── Game name lookup (for wishlist display) ─────────────────────────────────

interface RawAppDetails {
  success: boolean;
  data?: {
    name?: string;
  };
}

/**
 * Fetches the official game name for a Steam AppID.
 * Returns null on failure (rate limit, private, etc).
 */
export async function fetchGameName(appId: string): Promise<string | null> {
  const url = `${API_URL}?appids=${appId}&cc=${PRICE_CC}`;
  console.log(`[Steam API] Fetching name for app ${appId}…`);

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

  let json: Record<string, RawAppDetails>;
  try {
    json = (await response.json()) as Record<string, RawAppDetails>;
  } catch (error) {
    console.error(`[Steam API] JSON parse error for app ${appId}:`, error);
    return null;
  }

  const entry = json[appId];
  if (!entry?.success) {
    console.warn(`[Steam API] success=false for app ${appId}.`);
    return null;
  }

  const name = entry.data?.name?.trim();
  if (name) {
    console.log(`[Steam API] App ${appId} name: ${name}`);
    return name;
  }
  return null;
}

// ─── Name → App ID search (for wishlist name resolution) ─────────────────────

interface StoreSearchItem {
  id: number;
  name: string;
}

interface StoreSearchResponse {
  total: number;
  items?: StoreSearchItem[];
}

/**
 * Searches the Steam Store for a game by name and returns the first matching App ID.
 * Used to auto-resolve names like "ark survival evolved" → "346110".
 */
export async function searchSteamAppIdByName(query: string): Promise<string | null> {
  const term = encodeURIComponent(query.trim());
  const url = `https://store.steampowered.com/api/storesearch/?term=${term}&cc=${PRICE_CC}&l=english`;
  console.log(`[Steam API] Searching for App ID by name: "${query}"`);

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    console.error(`[Steam API] Search network error for "${query}":`, error);
    return null;
  }

  if (!response.ok) {
    console.warn(`[Steam API] Search HTTP ${response.status} for "${query}".`);
    return null;
  }

  let json: StoreSearchResponse;
  try {
    json = (await response.json()) as StoreSearchResponse;
  } catch (error) {
    console.error(`[Steam API] Search JSON parse error for "${query}":`, error);
    return null;
  }

  if (json.total > 0 && json.items && json.items.length > 0) {
    const first = json.items[0];
    const appId = String(first.id);
    console.log(`[Steam API] Resolved "${query}" → App ID ${appId} (${first.name})`);
    return appId;
  }

  console.warn(`[Steam API] No results for name search: "${query}"`);
  return null;
}

/**
 * Normalizes a wishlist input (AppID, URL, or name) to the best storable value.
 * Tries hard to return a real numeric App ID when possible by searching.
 */
export async function resolveToAppIdOrName(input: string): Promise<string> {
  const trimmed = input.trim();

  // URL with app ID
  const match = trimmed.match(/store\.steampowered\.com\/app\/(\d+)/);
  if (match) {
    return match[1];
  }

  // Already looks like numeric App ID
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  // Name: search for App ID
  const foundId = await searchSteamAppIdByName(trimmed);
  if (foundId) {
    return foundId;
  }

  // Fallback
  return `name:${trimmed.toLowerCase()}`;
}
