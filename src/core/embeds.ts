import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import type { EpicFreeGame, FeedItem, SteamDealItem, Track } from './types';

/**
 * Generic short reply embed (errors, confirmations, status).
 * Prefer domain-specific builders (track, queue, news) when available.
 */
export function buildInfoEmbed(description: string, title?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setDescription(description.slice(0, 4096));
  if (title) embed.setTitle(title.slice(0, 256));
  return embed;
}

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Live / Unknown';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

/** Human friendly view count e.g. "1.2M" or "3.4K". */
export function formatViews(count?: number): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (count >= 10_000) return Math.floor(count / 1_000) + 'K views';
  if (count >= 1_000) return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return count.toLocaleString() + ' views';
}

/** Embed for a single track (used by /play and /playing). `label` is the author line. */
export function buildTrackEmbed(track: Track, label: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setAuthor({ name: label })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Duration', value: formatDuration(track.durationSec), inline: true },
    { name: 'Requested by', value: track.requestedBy, inline: true },
  ];

  if (track.uploader) {
    fields.push({ name: 'Uploader', value: track.uploader.slice(0, 100), inline: true });
  }

  const viewsStr = formatViews(track.views);
  if (viewsStr) {
    fields.push({ name: 'Views', value: viewsStr, inline: true });
  }

  if (track.uploadedAt) {
    fields.push({ name: 'Uploaded', value: track.uploadedAt, inline: true });
  }

  // Add a source badge when non-default
  if (track.source && track.source !== 'youtube') {
    const badge =
      track.source === 'spotify'
        ? 'Spotify'
        : track.source === 'soundcloud'
          ? 'SoundCloud'
          : track.source;
    fields.push({ name: 'Source', value: badge, inline: true });
  }

  embed.addFields(fields);

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

/** Embed listing the current track and the next items in the queue. */
export function buildQueueEmbed(current: Track | null, queue: Track[]): EmbedBuilder {
  const lines: string[] = [];
  let totalSec = 0;

  if (current) {
    lines.push(
      `**Now playing:** [${current.title}](${current.url}) \`${formatDuration(current.durationSec)}\``,
    );
    if (current.durationSec > 0) totalSec += current.durationSec;
  }

  if (queue.length > 0) {
    const shown = queue.slice(0, 10);
    lines.push('', '**Up next:**');
    shown.forEach((track, i) => {
      lines.push(
        `\`${i + 1}.\` [${track.title}](${track.url}) \`${formatDuration(track.durationSec)}\``,
      );
      if (track.durationSec > 0) totalSec += track.durationSec;
    });
    if (queue.length > shown.length) {
      lines.push(`…and ${queue.length - shown.length} more.`);
    }
  }

  const footerParts: string[] = [];
  footerParts.push(`${queue.length} track(s) queued`);
  if (totalSec > 0) footerParts.push(`~${formatDuration(totalSec)} total`);
  // We don't have direct loop state here; the caller can append if desired in future.

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('🎶 Queue')
    .setDescription(lines.length > 0 ? lines.join('\n') : 'The queue is empty.')
    .setFooter({ text: footerParts.join(' • ') });
}

/** One row for the server playlist embed (from DB or Track-like data). */
export interface PlaylistEmbedItem {
  title: string;
  url: string;
  durationSec?: number;
  artist?: string | null;
  addedBy?: string | null;
}

/**
 * Embed for the server's saved playlist (not the live queue).
 * Title: "Dzbanek playlist", body: numbered 1. 2. 3. …
 */
export function buildPlaylistEmbed(
  items: PlaylistEmbedItem[],
  playlistName = 'Dzbanek playlist',
): EmbedBuilder {
  if (items.length === 0) {
    return new EmbedBuilder()
      .setColor(config.embedColor)
      .setTitle(`🎵 ${playlistName}`)
      .setDescription('The playlist is empty.\nUse `/playlist add` to save songs.')
      .setFooter({ text: '0 songs' });
  }

  const maxShown = 25;
  const shown = items.slice(0, maxShown);
  let totalSec = 0;

  const lines = shown.map((item, i) => {
    const label = item.artist ? `${item.artist} — ${item.title}` : item.title;
    const duration =
      item.durationSec && item.durationSec > 0 ? ` \`${formatDuration(item.durationSec)}\`` : '';
    if (item.durationSec && item.durationSec > 0) totalSec += item.durationSec;
    // Discord embed description max 4096; keep each line reasonably short
    const title = label.slice(0, 120);
    return `**${i + 1}.** [${title}](${item.url})${duration}`;
  });

  if (items.length > shown.length) {
    lines.push(`\n…and **${items.length - shown.length}** more.`);
  }

  const footerParts = [`${items.length} song${items.length === 1 ? '' : 's'}`];
  if (totalSec > 0) footerParts.push(`~${formatDuration(totalSec)} total`);

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(`🎵 ${playlistName}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: footerParts.join(' • ') });
}

/** Steam's brand dark-blue color (#1b2838). */
const STEAM_COLOR = 0x1b2838;

/** Official Steam favicon — used as the digest thumbnail. */
const STEAM_THUMBNAIL = 'https://store.steampowered.com/favicon.ico';

/** Steam specials page — used as the digest title URL. */
const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';

/** Maximum number of deals shown in one digest embed (Discord allows 25 fields max). */
const DIGEST_MAX_ITEMS = 10;

/**
 * Builds a single digest embed listing up to 10 new Steam deals.
 *
 * Layout:
 *   Thumbnail : Steam logo
 *   Title     : 🎮 Steam Daily Deals  (links to Steam specials)
 *   Description: deal count + best discount teaser
 *   Fields    : one row per deal — game name as the field name,
 *               price/discount/expiry + "View on Steam" link as the value
 *   Footer    : Steam Deals • game-deals.app
 *   Timestamp : time the embed was built
 */
export function buildSteamDealsDigestEmbed(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
): EmbedBuilder {
  const top = items.slice(0, DIGEST_MAX_ITEMS);
  const best = topDiscountPct(top);

  const embed = new EmbedBuilder()
    .setColor(STEAM_COLOR)
    .setTitle('🎮 Steam Daily Deals')
    .setURL(STEAM_SPECIALS_URL)
    .setThumbnail(STEAM_THUMBNAIL)
    .setDescription(
      `**${top.length} new deal${top.length !== 1 ? 's' : ''}** just dropped on Steam` +
        (best > 0 ? ` — up to **${best}% off**` : '') +
        '.\n\n' +
        "Use the **dropdown below** to add games to your bot wishlist (you'll get DMs when they go on sale). " +
        'Click "View on Steam" to see the deal (and add to your official Steam wishlist there).',
    )
    .setFooter({ text: 'Steam Deals • game-deals.app' })
    .setTimestamp();

  for (const [i, item] of top.entries()) {
    embed.addFields({
      name: `${i + 1}. ${item.gameName.slice(0, 250)}`,
      value: buildFieldValue(item, prices.get(item.id) ?? null, reviews.get(item.id)),
      inline: false,
    });
  }

  return embed;
}

/**
 * Formats the value shown under each deal's field name.
 * Keeps it clean and compact: price, review, optional ratings/genres/expiry, and link.
 * No descriptions or image links (they made the embed ugly and bloated).
 */
function buildFieldValue(
  item: SteamDealItem,
  apiPrice: string | null,
  reviewStr: string | undefined,
): string {
  const lines: string[] = [];

  // Price line (live API preferred)
  lines.push(apiPrice ?? buildFallbackPrice(item));

  if (reviewStr) lines.push(reviewStr);

  // Extra quality signals
  const ratings: string[] = [];
  if (item.igdbRating) ratings.push(`IGDB ${item.igdbRating}`);
  if (item.metascore) ratings.push(`Meta ${item.metascore}`);
  if (item.dealScore) ratings.push(`Deal ${item.dealScore}`);
  if (ratings.length) lines.push(ratings.join(' • '));

  if (item.genres) {
    lines.push(`🎮 ${item.genres}`);
  }

  if (item.expires) {
    lines.push(`📅 Expires **${item.expires}**`);
  }

  lines.push(`[View on Steam →](${item.link})`);

  return lines.join('\n').slice(0, 1024);
}

/** Fallback price line built from RSS feed fields when the Steam API is unavailable. */
function buildFallbackPrice(item: SteamDealItem): string {
  const parts: string[] = [];
  if (item.salePrice && item.originalPrice && item.discount) {
    parts.push(`~~${item.originalPrice}~~ → **${item.salePrice}** (${item.discount})`);
  } else {
    if (item.salePrice) parts.push(`**${item.salePrice}**`);
    if (item.originalPrice) parts.push(`~~${item.originalPrice}~~`);
    if (item.discount) parts.push(`(${item.discount})`);
  }
  if (item.expires) parts.push(`📅 ${item.expires}`);
  return parts.length > 0 ? parts.join('  ') : 'Free to play';
}

/** Returns the highest absolute discount percentage across the given items. */
function topDiscountPct(items: SteamDealItem[]): number {
  return items.reduce((max, item) => {
    if (!item.discount) return max;
    const n = parseInt(item.discount.replace(/\D/g, ''), 10);
    return !Number.isNaN(n) && n > max ? n : max;
  }, 0);
}

/** Epic Games Store dark color (#2F2D2E). */
const EPIC_COLOR = 0x2f2d2e;

const EPIC_THUMBNAIL = 'https://store.epicgames.com/favicon.ico';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/**
 * Builds a single embed listing all currently-free and upcoming-free Epic games.
 *
 * Layout:
 *   Thumbnail : Epic favicon
 *   Title     : 🎁 Epic Games — Free This Week  (links to free games page)
 *   Description: count + CTA
 *   Fields    : one row per current free game, then a separator, then upcoming
 *   Image     : OfferImageWide of the first currently-free game
 *   Footer    : Epic Games Store • Free Games
 *   Timestamp : time the embed was built
 */
export function buildEpicFreeGamesEmbed(games: EpicFreeGame[]): EmbedBuilder {
  const current = games.filter((g) => !g.isUpcoming);
  const upcoming = games.filter((g) => g.isUpcoming);

  const embed = new EmbedBuilder()
    .setColor(EPIC_COLOR)
    .setTitle('🎁 Epic Games — Free This Week')
    .setURL(EPIC_FREE_URL)
    .setThumbnail(EPIC_THUMBNAIL)
    .setDescription(
      current.length > 0
        ? `**${current.length} free game${current.length !== 1 ? 's' : ''}** available right now — no purchase needed.\nClick a title to claim on the Epic Games Store.`
        : '🕐 No games are free right now. Check back soon!',
    )
    .setFooter({ text: 'Epic Games Store • Free Games' })
    .setTimestamp();

  // Currently free games
  for (const game of current) {
    embed.addFields({ name: game.title, value: epicFieldValue(game), inline: false });
  }

  // Hero image from the first currently-free game (or first upcoming if none)
  const heroImage = (current[0] ?? upcoming[0])?.image;
  if (heroImage) embed.setImage(heroImage);

  // Upcoming free games section
  if (upcoming.length > 0) {
    embed.addFields({ name: '\u200b', value: '**🔜 Coming Next Week**', inline: false });
    for (const game of upcoming) {
      embed.addFields({ name: game.title, value: epicFieldValue(game), inline: false });
    }
  }

  return embed;
}

/** Formats the value for one Epic game field. */
function epicFieldValue(game: EpicFreeGame): string {
  const lines: string[] = [];

  if (game.description) {
    const shortDesc = game.description.replace(/\s+/g, ' ').slice(0, 120);
    lines.push(shortDesc + (game.description.length > 120 ? '…' : ''));
  }

  if (game.isUpcoming) {
    if (game.upcomingStartDate) lines.push(`🕐 Free from **${epicDate(game.upcomingStartDate)}**`);
    if (game.endDate) lines.push(`📅 Until **${epicDate(game.endDate)}**`);
    if (game.originalPrice) lines.push(`Worth ${game.originalPrice}`);
    lines.push(`[View on Epic \u2192](${game.storeUrl})`);
  } else {
    lines.push(game.originalPrice ? `~~${game.originalPrice}~~ \u2192 **FREE**` : '**FREE**');
    if (game.endDate) lines.push(`📅 Until **${epicDate(game.endDate)}**`);
    if (game.seller) lines.push(`🏢 ${game.seller.slice(0, 60)}`);
    lines.push(`[Claim for Free \u2192](${game.storeUrl})`);
  }

  return lines.join('\n').slice(0, 1024);
}

/** Formats an ISO date string to a readable date, e.g. "25 Jun 2026". */
function epicDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Embed for a news article. */
export function buildNewsEmbed(item: FeedItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setAuthor({ name: item.feedName })
    .setFooter({ text: '📰 News' });

  if (item.snippet) {
    // Clean up whitespace and limit length for nicer display
    const cleanSnippet = item.snippet.replace(/\s+/g, ' ').trim().slice(0, 300);
    embed.setDescription(cleanSnippet + (item.snippet.length > 300 ? '…' : ''));
  }

  if (item.image) embed.setImage(item.image);

  if (item.isoDate) {
    const date = new Date(item.isoDate);
    if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);
  }

  return embed;
}
