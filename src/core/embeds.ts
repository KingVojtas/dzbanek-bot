import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import type { FeedItem, SteamDealItem, Track } from './types';

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

/** Embed for a single track (used by /play and /playing). `label` is the author line. */
export function buildTrackEmbed(track: Track, label: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setAuthor({ name: label })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: 'Duration', value: formatDuration(track.durationSec), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true },
    );
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

/** Embed listing the current track and the next items in the queue. */
export function buildQueueEmbed(current: Track | null, queue: Track[]): EmbedBuilder {
  const lines: string[] = [];
  if (current) {
    lines.push(
      `**Now playing:** [${current.title}](${current.url}) \`${formatDuration(current.durationSec)}\``,
    );
  }
  if (queue.length > 0) {
    const shown = queue.slice(0, 10);
    lines.push('', '**Up next:**');
    shown.forEach((track, i) => {
      lines.push(
        `\`${i + 1}.\` [${track.title}](${track.url}) \`${formatDuration(track.durationSec)}\``,
      );
    });
    if (queue.length > shown.length) {
      lines.push(`…and ${queue.length - shown.length} more.`);
    }
  }

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('🎶 Queue')
    .setDescription(lines.length > 0 ? lines.join('\n') : 'The queue is empty.')
    .setFooter({ text: `${queue.length} track(s) queued` });
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
        '.\nClick any title to open its Steam store page.',
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
 *
 * Example output:
 *   ~~41,99€~~ -> **8,39€** (-80%)
 *   ⭐ **Very Positive** (95%)
 *   [View on Steam →](url)
 */
function buildFieldValue(
  item: SteamDealItem,
  apiPrice: string | null,
  reviewStr: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(apiPrice ?? buildFallbackPrice(item));
  if (reviewStr) lines.push(reviewStr);
  lines.push(`[View on Steam →](${item.link})`);
  return lines.join('\n').slice(0, 1024);
}

/** Fallback price line built from RSS feed fields when the Steam API is unavailable. */
function buildFallbackPrice(item: SteamDealItem): string {
  const parts: string[] = [];
  if (item.salePrice) parts.push(`💰 **${item.salePrice}**`);
  if (item.originalPrice) parts.push(`~~${item.originalPrice}~~`);
  if (item.discount) parts.push(`🏷️ **${item.discount}**`);
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

/** Embed for a news article. */
export function buildNewsEmbed(item: FeedItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setFooter({ text: item.feedName });
  if (item.snippet) embed.setDescription(item.snippet.slice(0, 500));
  if (item.image) embed.setImage(item.image);
  if (item.isoDate) {
    const date = new Date(item.isoDate);
    if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);
  }
  return embed;
}
