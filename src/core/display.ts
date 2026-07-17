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
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';
import { formatDuration } from './embeds';

/** Purple accent matching the music player mockup. */
const MUSIC_COLOR = 0x8b5cf6;
/** Warm red/orange matching the Steam sales mockup. */
const STEAM_COLOR = 0xc73e1d;
/** Near-black matching the Epic free-games mockup. */
const EPIC_COLOR = 0x1a1a1a;

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/** Max game rows per digest (keeps Components V2 under Discord limits). */
const DIGEST_MAX_ITEMS = 8;

// ─── Progress bar ────────────────────────────────────────────────────────────

/**
 * Visual “slider” for the music player (display-only — Discord has no seek control).
 * Filled portion uses heavy bars; a bullet marks the playhead.
 */
export function buildProgressBar(positionSec: number, durationSec: number, width = 16): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return '─'.repeat(width);
  }
  const ratio = Math.min(1, Math.max(0, positionSec / durationSec));
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

  const loopLabel =
    loopMode === 'track' ? '🔁 Track' : loopMode === 'queue' ? '🔁 Queue' : '🔁 Off';

  const titleLine = track.url
    ? `### [${track.title.slice(0, 200)}](${track.url})`
    : `### ${track.title.slice(0, 200)}`;

  const body = [
    '**Music Player**',
    titleLine,
    `*${artist}*`,
    '',
    `\`${progress}\``,
    `\`${posLabel}\`  /  \`${durLabel}\``,
    '',
    `**${label}** · Queue: **${queueLength}** track${queueLength === 1 ? '' : 's'} · ${loopLabel}`,
  ];

  if (opts.footer) {
    body.push(`-# ${opts.footer}`);
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(body.join('\n').slice(0, 4000)),
  );

  if (track.thumbnail) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder().setURL(track.thumbnail).setDescription(track.title.slice(0, 100)),
    );
  }

  const controls = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:previous')
      .setLabel('Previous')
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
      .setCustomId('music:loop')
      .setLabel('Loop')
      .setEmoji('🔁')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );

  const container = new ContainerBuilder()
    .setAccentColor(MUSIC_COLOR)
    .addSectionComponents(section)
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(controls);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

// ─── Steam sales ─────────────────────────────────────────────────────────────

/**
 * Components V2 Steam digest: one section per deal with header image thumbnail.
 * Link buttons aren't available alongside a thumbnail accessory, so Store links
 * live in the section text (and the title is clickable).
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
  minDiscountPct?: number | null,
): {
  components: (ContainerBuilder | ActionRowBuilder<StringSelectMenuBuilder>)[];
  flags: typeof MessageFlags.IsComponentsV2;
} {
  const top = items.slice(0, DIGEST_MAX_ITEMS);
  const best = topDiscountPct(top);
  const threshold = minDiscountPct && minDiscountPct > 0 ? minDiscountPct : best > 0 ? 50 : null;

  const title =
    threshold != null
      ? `## [Steam Sales — ${threshold}% Off or More](${STEAM_SPECIALS_URL})`
      : `## [Steam Sales](${STEAM_SPECIALS_URL})`;

  const intro = [
    title,
    top.length > 0
      ? `**${top.length}** deal${top.length !== 1 ? 's' : ''} right now` +
        (best > 0 ? ` · up to **${best}% off**` : '')
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

/**
 * Components V2 Epic free-games card: “This Week” / “Next Week” with banner thumbnails.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
} {
  const current = games.filter((g) => !g.isUpcoming).slice(0, DIGEST_MAX_ITEMS);
  const upcoming = games.filter((g) => g.isUpcoming).slice(0, DIGEST_MAX_ITEMS);

  const container = new ContainerBuilder()
    .setAccentColor(EPIC_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## [Epic Free Games](${EPIC_FREE_URL})\nClaim free titles this week — no purchase needed.`,
      ),
    );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      current.length > 0
        ? `### This Week · ${current.length} free`
        : '### This Week\n🕐 No free games right now — check back soon.',
    ),
  );

  for (const game of current) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addSectionComponents(buildEpicGameSection(game));
  }

  if (upcoming.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Next Week · ${upcoming.length} upcoming`),
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

function buildEpicGameSection(game: EpicFreeGame): SectionBuilder {
  const title = game.title.slice(0, 120);
  const lines: string[] = [game.storeUrl ? `### [${title}](${game.storeUrl})` : `### ${title}`];

  if (game.isUpcoming) {
    lines.push('**Coming soon**');
    if (game.upcomingStartDate) lines.push(`Free from **${epicDate(game.upcomingStartDate)}**`);
    if (game.endDate) lines.push(`Until **${epicDate(game.endDate)}**`);
    if (game.originalPrice) lines.push(`Worth ${game.originalPrice}`);
  } else {
    lines.push(game.originalPrice ? `**FREE**  ·  ~~${game.originalPrice}~~` : '**FREE**');
    if (game.endDate) lines.push(`Until **${epicDate(game.endDate)}**`);
  }

  if (game.storeUrl) {
    lines.push(`[Claim →](${game.storeUrl})`);
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

/** Collect plain text from a Components V2 message for fingerprinting. */
export function collectMessageTextContent(message: {
  content?: string | null;
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
  components?: readonly { toJSON?: () => unknown; data?: unknown }[];
}): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const f of embed.fields ?? []) chunks.push(f.name);
  }

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.content === 'string') chunks.push(obj.content);
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) walk(child);
    }
    // discord.js Component wrappers expose .data
    if (obj.data && typeof obj.data === 'object') walk(obj.data);
    // Some structures nest under accessory / items
    if (obj.accessory) walk(obj.accessory);
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) walk(item);
    }
  };

  for (const top of message.components ?? []) {
    if (top && typeof top === 'object' && 'toJSON' in top && typeof top.toJSON === 'function') {
      try {
        walk(top.toJSON());
      } catch {
        walk(top);
      }
    } else {
      walk(top);
    }
  }

  return chunks.join('\n');
}
