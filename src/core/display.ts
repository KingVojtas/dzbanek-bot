import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';
import { formatDuration, QUEUE_PAGE_SIZE, queueTotalPages } from './embeds';
import {
  estimateEpicDigestComponents,
  estimateSteamDigestComponents,
  fitRowsToBudget,
} from '../utils/component-budget';

/** Purple accent matching the music player mockup (YouTube default). */
const MUSIC_COLOR = 0x8b5cf6;
/** Spotify brand green. */
const SPOTIFY_COLOR = 0x1db954;
/** SoundCloud brand orange. */
const SOUNDCLOUD_COLOR = 0xff5500;
/** Official Steam brand dark blue (#1b2838). */
const STEAM_COLOR = 0x1b2838;

function musicAccentColor(source?: Track['source']): number {
  if (source === 'spotify') return SPOTIFY_COLOR;
  if (source === 'soundcloud') return SOUNDCLOUD_COLOR;
  return MUSIC_COLOR;
}

function musicSourceLabel(source?: Track['source']): string {
  if (source === 'spotify') return 'Spotify';
  if (source === 'soundcloud') return 'SoundCloud';
  if (source === 'youtube') return 'YouTube';
  return 'Music';
}
/** Near-black matching the Epic free-games mockup. */
const EPIC_COLOR = 0x1a1a1a;

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/**
 * Steam deals per digest.
 * Discord Components V2 allows max **40 components total** (nested count).
 * Each deal is Separator + Section + TextDisplay + Thumbnail ≈ 4, plus intro +
 * optional wishlist row — so 10 deals overflow (API 50035). Keep ≤ 8.
 */
export const STEAM_DIGEST_SIZE = 8;

/**
 * Max free + upcoming rows for Epic (same 40-component budget as Steam).
 * Current and upcoming share this budget (not 8 each).
 */
const EPIC_DIGEST_MAX = 8;

/** Hidden fingerprint prefix used for Steam digests (duplicate detection). */
export const STEAM_DIGEST_MARKER = 'steam-digest:';

// ─── Interaction helpers ─────────────────────────────────────────────────────

/**
 * Send / replace a Components V2 music player message.
 *
 * Discord rejects mixing embeds with `IsComponentsV2`. After `deferReply()` +
 * embed status updates, the deferred message cannot be converted cleanly — so
 * we delete it and `followUp` with a pure V2 payload.
 *
 * Returns the sent message so callers can attach the live progress ticker.
 */
export async function sendMusicPlayerReply(
  interaction: ChatInputCommandInteraction,
  display: {
    components: ContainerBuilder[];
    flags: typeof MessageFlags.IsComponentsV2;
  },
): Promise<Message | null> {
  const payload = {
    components: display.components,
    flags: display.flags,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      try {
        await interaction.deleteReply();
      } catch {
        /* message may already be gone */
      }
      const msg = await interaction.followUp(payload);
      return msg;
    }

    await interaction.reply(payload);
    return await interaction.fetchReply();
  } catch {
    return null;
  }
}

// ─── Progress bar ────────────────────────────────────────────────────────────

/**
 * Visual “slider” for the music player (display-only — Discord has no seek control).
 * Filled portion uses heavy bars; a bullet marks the playhead.
 */
export function buildProgressBar(positionSec: number, durationSec: number, width = 16): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return '─'.repeat(width);
  }
  // Floor position so the bar ticks cleanly once per second with the timer.
  const pos = Math.max(0, Math.floor(positionSec));
  const dur = Math.max(1, Math.floor(durationSec));
  const ratio = Math.min(1, Math.max(0, pos / dur));
  const filled = Math.min(width - 1, Math.max(0, Math.round(ratio * (width - 1))));
  return `${'━'.repeat(filled)}●${'─'.repeat(Math.max(0, width - filled - 1))}`;
}

// ─── Music player ────────────────────────────────────────────────────────────

export interface MusicPlayerDisplayOptions {
  track: Track;
  /** Elapsed playback seconds (from AudioResource.playbackDuration). */
  positionSec?: number;
  queueLength: number;
  paused: boolean;
  loopMode: LoopMode;
  /** e.g. "Now playing" / "Added to queue". */
  label?: string;
  footer?: string;
  /** Title of the next queued track (makes shuffle order visible on the panel). */
  upNextTitle?: string | null;
  /** Highlight the Shuffle button (briefly after a successful shuffle). */
  shuffleHighlight?: boolean;
  /** Playback volume 0–100 (shown on panel + Vol buttons). */
  volumePct?: number;
  /** Music bridge / stream infrastructure warning. */
  bridgeWarning?: string | null;
}

/**
 * Components V2 music player: album art accessory, progress bar, transport controls.
 * Must be sent with `flags: MessageFlags.IsComponentsV2` (no embeds).
 */
export function buildMusicPlayerDisplay(opts: MusicPlayerDisplayOptions): {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
} {
  const { track, queueLength, paused, loopMode } = opts;
  const positionSec = Math.max(0, opts.positionSec ?? 0);
  const durationSec = track.durationSec > 0 ? track.durationSec : 0;
  const artist = (track.uploader ?? track.requestedBy ?? 'Unknown').slice(0, 80);
  const label = opts.label ?? (paused ? 'Paused' : 'Now Playing');
  const progress = buildProgressBar(positionSec, durationSec);
  const posLabel = formatDuration(positionSec);
  const durLabel = durationSec > 0 ? formatDuration(durationSec) : 'Live';
  const sourceLabel = musicSourceLabel(track.source);
  const accent = musicAccentColor(track.source);
  const shuffleHighlight = Boolean(opts.shuffleHighlight);
  const volumePct = Math.min(100, Math.max(0, Math.round(opts.volumePct ?? 100)));

  const loopLabel =
    loopMode === 'track' ? '🔁 Track' : loopMode === 'queue' ? '🔁 Queue' : '🔁 Off';

  // Prefer original platform page (Spotify/SC) for the title link when present
  const linkUrl = track.sourceUrl || track.url;
  const titleLine = linkUrl
    ? `### [${track.title.slice(0, 200)}](${linkUrl})`
    : `### ${track.title.slice(0, 200)}`;

  const body = [
    `**Music Player** · ${sourceLabel}`,
    titleLine,
    `*${artist}*`,
    '',
    `\`${progress}\``,
    `\`${posLabel}\`  /  \`${durLabel}\``,
    '',
    `**${label}** · Queue: **${queueLength}** · Vol **${volumePct}%** · ${loopLabel}`,
  ];

  if (opts.upNextTitle) {
    body.push(`-# ⏭ Up next: **${opts.upNextTitle.slice(0, 80)}**`);
  }

  if (opts.bridgeWarning) {
    body.push(`-# ⚠️ ${opts.bridgeWarning.slice(0, 180)}`);
  } else if (opts.footer) {
    body.push(`-# ${opts.footer}`);
  } else if (shuffleHighlight) {
    body.push('-# 🔀 Queue shuffled');
  } else if (track.source === 'spotify') {
    body.push('-# Audio matched on YouTube · metadata from Spotify');
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(body.join('\n').slice(0, 4000)),
  );

  if (track.thumbnail) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(track.thumbnail).setDescription(track.title.slice(0, 100)),
    );
  }

  // Row 1: transport (5 max). Row 2: volume + shuffle.
  const transport = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:previous')
      .setLabel('Prev')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setLabel(loopMode === 'off' ? 'Loop' : loopMode === 'track' ? 'Repeat' : 'Queue')
      .setEmoji('🔁')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
  );

  const extras = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:volume:down')
      .setLabel('Vol −')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volumePct <= 0),
    new ButtonBuilder()
      .setCustomId('music:volume:up')
      .setLabel('Vol +')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volumePct >= 100),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel(shuffleHighlight ? 'Shuffled' : 'Shuffle')
      .setEmoji('🔀')
      .setStyle(shuffleHighlight ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:lyrics')
      .setLabel('Lyrics')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
  );

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addSectionComponents(section)
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(transport, extras);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

// ─── Queue pagination ────────────────────────────────────────────────────────

/**
 * Prev / page indicator / Next buttons for `/queue`.
 * Custom ids: `queue:page:<n>` (0-based). The middle button is decorative.
 */
export function buildQueuePageRow(
  page: number,
  queueLength: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const totalPages = queueTotalPages(queueLength, QUEUE_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:page:${safePage - 1}`)
      .setLabel('Prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId('queue:noop')
      .setLabel(`${safePage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`queue:page:${safePage + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`queue:refresh:${safePage}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Select menus for the current queue page: remove a track, or move it to play-next.
 * Values are 0-based queue indices.
 */
export function buildQueueManageRows(
  page: number,
  queue: Track[],
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const totalPages = queueTotalPages(queue.length, QUEUE_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * QUEUE_PAGE_SIZE;
  const pageTracks = queue.slice(start, start + QUEUE_PAGE_SIZE);
  if (pageTracks.length === 0) return [];

  const removeOptions = pageTracks.map((track, i) => {
    const idx = start + i;
    const n = idx + 1;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`Remove #${n}`.slice(0, 100))
      .setDescription(track.title.slice(0, 100))
      .setValue(String(idx))
      .setEmoji('🗑️');
  });

  const playNextOptions = pageTracks.map((track, i) => {
    const idx = start + i;
    const n = idx + 1;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`Play next #${n}`.slice(0, 100))
      .setDescription(track.title.slice(0, 100))
      .setValue(String(idx))
      .setEmoji('⏭️');
  });

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`queue:rm:${safePage}`)
        .setPlaceholder('🗑️ Remove a track from this page…')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(removeOptions),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`queue:pn:${safePage}`)
        .setPlaceholder('⏭️ Move a track to play next…')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(playNextOptions),
    ),
  ];
}

// ─── Steam sales ─────────────────────────────────────────────────────────────

/**
 * Components V2 Steam digest: one section per deal with header image thumbnail.
 * Link buttons aren't available alongside a thumbnail accessory, so Store links
 * live in the section text (and the title is clickable).
 */
/** Stable fingerprint for a digest (deal ids, sorted by display order). */
export function steamDigestFingerprint(items: SteamDealItem[]): string {
  return items.map((i) => i.id).join('|');
}

export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
  minDiscountPct?: number | null,
): {
  components: (ContainerBuilder | ActionRowBuilder<StringSelectMenuBuilder>)[];
  flags: typeof MessageFlags.IsComponentsV2;
} {
  // Fit under Discord's 40-component V2 budget (wishlist row costs extra).
  let top = items.slice(0, STEAM_DIGEST_SIZE);
  const hasWishlist = top.length > 0;
  const fit = fitRowsToBudget(top.length, (n) =>
    estimateSteamDigestComponents(n, hasWishlist && n > 0),
  );
  top = top.slice(0, fit);
  const best = topDiscountPct(top);
  const threshold = minDiscountPct && minDiscountPct > 0 ? minDiscountPct : null;
  const fingerprint = steamDigestFingerprint(top);

  const title =
    threshold != null
      ? `## [Steam Sales — ${threshold}% Off or More](${STEAM_SPECIALS_URL})`
      : best > 0
        ? `## [Steam Sales — Best Deals (up to ${best}% off)](${STEAM_SPECIALS_URL})`
        : `## [Steam Sales](${STEAM_SPECIALS_URL})`;

  // Do NOT put fingerprint text in the message — Discord still shows `-#` lines.
  // Duplicate detection uses store links / titles in the message body (see services).
  void fingerprint;

  const intro = [
    title,
    top.length > 0
      ? `**Top ${top.length}** deal${top.length !== 1 ? 's' : ''}` +
        (best > 0 ? ` · deepest discounts first` : '')
      : 'No deals matched your filters.',
    '-# Use the dropdown to wishlist games for sale DMs.',
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(STEAM_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(intro.slice(0, 4000)));

  for (const item of top) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addSectionComponents(
      buildSteamDealSection(item, prices.get(item.id) ?? null, reviews.get(item.id)),
    );
  }

  const components: (ContainerBuilder | ActionRowBuilder<StringSelectMenuBuilder>)[] = [container];
  const wishlistRow = buildWishlistSelectRow(top);
  if (wishlistRow) components.push(wishlistRow);

  return {
    components,
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildSteamDealSection(
  item: SteamDealItem,
  apiPrice: string | null,
  reviewStr: string | undefined,
): SectionBuilder {
  const discount = item.discount?.replace(/[()]/g, '').trim() || '';
  const priceLine = apiPrice ?? fallbackPriceLine(item);
  const title = item.gameName.slice(0, 120);

  const lines = [
    item.link ? `### [${title}](${item.link})` : `### ${title}`,
    discount ? `**${discount}**  ·  ${priceLine}` : priceLine,
  ];

  if (reviewStr) lines.push(reviewStr.slice(0, 120));

  const extras: string[] = [];
  if (item.expires) extras.push(`Expires **${item.expires}**`);
  if (item.link) extras.push(`[Store →](${item.link})`);
  if (extras.length) lines.push(extras.join(' · '));

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );

  if (item.image) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(item.image).setDescription(title.slice(0, 100)),
    );
  }

  return section;
}

function fallbackPriceLine(item: SteamDealItem): string {
  if (item.salePrice && item.originalPrice) {
    return `~~${item.originalPrice}~~ → **${item.salePrice}**`;
  }
  if (item.salePrice) return `**${item.salePrice}**`;
  if (item.originalPrice) return item.originalPrice;
  return 'See store';
}

function topDiscountPct(items: SteamDealItem[]): number {
  return items.reduce((max, item) => {
    if (!item.discount) return max;
    const n = parseInt(item.discount.replace(/\D/g, ''), 10);
    return !Number.isNaN(n) && n > max ? n : max;
  }, 0);
}

function extractSteamAppId(link: string): string | undefined {
  return link.match(/store\.steampowered\.com\/app\/(\d+)/)?.[1];
}

function buildWishlistSelectRow(
  top: SteamDealItem[],
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const selectOptions = top
    .map((item) => {
      const appId = extractSteamAppId(item.link);
      const value = appId ?? `name:${item.gameName.toLowerCase().slice(0, 80)}`;
      const discount = item.discount ? ` ${item.discount}` : '';
      return new StringSelectMenuOptionBuilder()
        .setLabel(item.gameName.slice(0, 100))
        .setValue(value.slice(0, 100))
        .setDescription(`Add to bot wishlist${discount}`.slice(0, 100));
    })
    .slice(0, 25);

  if (selectOptions.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId('wishlist:add')
    .setPlaceholder('❤️ Add to my wishlist (get notified on sales)')
    .setMinValues(1)
    .setMaxValues(Math.min(5, selectOptions.length))
    .addOptions(selectOptions);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

// ─── Epic free games ─────────────────────────────────────────────────────────

/** Hidden fingerprint prefix for Epic digests (duplicate detection). */
export const EPIC_DIGEST_MARKER = 'epic-digest:';

/** Stable fingerprint for an Epic free-games lineup (titles + free/upcoming). */
export function epicDigestFingerprint(games: EpicFreeGame[]): string {
  return games.map((g) => `${g.isUpcoming ? 'U' : 'F'}:${g.title.trim().toLowerCase()}`).join('|');
}

/**
 * Components V2 Epic free-games digest — same layout language as Steam sales:
 * header + count line, separator, one section per game (title · price · dates · thumbnail).
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
} {
  // Prefer free-now rows, then fill remaining slots with upcoming (shared budget).
  const freeAll = games.filter((g) => !g.isUpcoming);
  const upcomingAll = games.filter((g) => g.isUpcoming);
  let freeSlots = Math.min(freeAll.length, EPIC_DIGEST_MAX);
  let current = freeAll.slice(0, freeSlots);
  let upcoming = upcomingAll.slice(0, Math.max(0, EPIC_DIGEST_MAX - current.length));
  // Shrink until under component budget
  while (
    current.length + upcoming.length > 1 &&
    estimateEpicDigestComponents(current.length, upcoming.length, current.length === 0) > 38
  ) {
    if (upcoming.length > 0) upcoming = upcoming.slice(0, -1);
    else current = current.slice(0, -1);
  }
  const lineup = [...current, ...upcoming];
  const fingerprint = epicDigestFingerprint(lineup);

  const title =
    current.length > 0
      ? `## [Epic Free Games — ${current.length} Free Now](${EPIC_FREE_URL})`
      : `## [Epic Free Games](${EPIC_FREE_URL})`;

  const countBits: string[] = [];
  if (current.length > 0) {
    countBits.push(`**${current.length}** free now`);
  }
  if (upcoming.length > 0) {
    countBits.push(`**${upcoming.length}** coming next`);
  }
  const subtitle =
    countBits.length > 0
      ? countBits.join(' · ') + ' · claim on the Epic Games Store'
      : 'No free games listed right now — check back soon.';

  // Do NOT put fingerprint text in the message — Discord still shows `-#` lines.
  void fingerprint;

  const intro = [title, subtitle, '-# Free to keep when claimed during the promo window.'].join(
    '\n',
  );

  const container = new ContainerBuilder()
    .setAccentColor(EPIC_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(intro.slice(0, 4000)));

  if (current.length > 0) {
    for (const game of current) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(buildEpicGameSection(game));
    }
  } else {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### This week\n🕐 Nothing free right now — see upcoming below or check the store.',
      ),
    );
  }

  if (upcoming.length > 0) {
    // Light section label (Steam-style: only separators between rows, not big headers)
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🔜 **Coming next** · ${upcoming.length} title${upcoming.length === 1 ? '' : 's'}`,
      ),
    );
    for (const game of upcoming) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(buildEpicGameSection(game));
    }
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

/**
 * One game row — mirrors Steam deal sections:
 *   ### Title (link)
 *   **100% OFF** · ~~$X~~ → **FREE**
 *   Seller
 *   Until date · Claim →
 *   + thumbnail
 */
function buildEpicGameSection(game: EpicFreeGame): SectionBuilder {
  const title = game.title.slice(0, 120);
  const lines: string[] = [game.storeUrl ? `### [${title}](${game.storeUrl})` : `### ${title}`];

  if (game.isUpcoming) {
    // Match Steam’s “discount · price” first line pattern
    const worth = game.originalPrice ? `Worth **${game.originalPrice}**` : 'Free soon';
    lines.push(`**Coming soon**  ·  ${worth}`);
    if (game.seller) lines.push(game.seller.slice(0, 80));

    const extras: string[] = [];
    if (game.upcomingStartDate) extras.push(`From **${epicDate(game.upcomingStartDate)}**`);
    if (game.endDate) extras.push(`Until **${epicDate(game.endDate)}**`);
    if (game.storeUrl) extras.push(`[Store →](${game.storeUrl})`);
    if (extras.length) lines.push(extras.join(' · '));
  } else {
    const priceLine = game.originalPrice ? `~~${game.originalPrice}~~ → **FREE**` : '**FREE**';
    lines.push(`**100% OFF**  ·  ${priceLine}`);
    if (game.seller) lines.push(game.seller.slice(0, 80));

    const extras: string[] = [];
    if (game.endDate) extras.push(`Until **${epicDate(game.endDate)}**`);
    if (game.storeUrl) extras.push(`[Claim →](${game.storeUrl})`);
    if (extras.length) lines.push(extras.join(' · '));
  }

  // Optional short blurb (Steam sometimes shows review; keep one line max)
  if (game.description) {
    const short = game.description.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (short) lines.push(`-# ${short}${game.description.length > 100 ? '…' : ''}`);
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );

  if (game.image) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(game.image).setDescription(title.slice(0, 100)),
    );
  }

  return section;
}

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

// ─── Duplicate helpers (Components V2 has no embeds) ─────────────────────────

/** Collect plain text from a Components V2 (or legacy embed) message for fingerprinting. */
export function collectMessageTextContent(message: {
  content?: string | null;
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
  components?: readonly unknown[];
}): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const f of embed.fields ?? []) chunks.push(f.name);
  }

  const walk = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    const obj = node as Record<string, unknown>;

    if (typeof obj.content === 'string') chunks.push(obj.content);

    // discord.js v14 component wrappers
    if (typeof obj.toJSON === 'function') {
      try {
        walk(obj.toJSON(), depth + 1);
      } catch {
        /* ignore */
      }
    }
    if (obj.data && typeof obj.data === 'object') walk(obj.data, depth + 1);

    // Nested component trees (Container → Section → TextDisplay)
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) walk(child, depth + 1);
    }
    if (obj.accessory) walk(obj.accessory, depth + 1);
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) walk(item, depth + 1);
    }

    // Some structures expose text under .value (legacy field-like)
    if (typeof obj.value === 'string' && obj.value.length < 2000) chunks.push(obj.value);
  };

  for (const top of message.components ?? []) {
    walk(top);
  }

  return chunks.join('\n');
}

/** Extract `steam-digest:…` marker from a prior digest message, if present. */
export function extractSteamDigestFingerprint(message: {
  content?: string | null;
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
  components?: readonly unknown[];
}): string | null {
  return extractDigestMarker(message, STEAM_DIGEST_MARKER);
}

/** Extract `epic-digest:…` marker from a prior free-games message, if present. */
export function extractEpicDigestFingerprint(message: {
  content?: string | null;
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
  components?: readonly unknown[];
}): string | null {
  return extractDigestMarker(message, EPIC_DIGEST_MARKER);
}

function extractDigestMarker(
  message: {
    content?: string | null;
    embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
    components?: readonly unknown[];
  },
  marker: string,
): string | null {
  const blob = collectMessageTextContent(message);
  const idx = blob.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  const rest = blob.slice(start);
  const match = rest.match(/^([^\s\n]+)/);
  return match?.[1] ?? null;
}
