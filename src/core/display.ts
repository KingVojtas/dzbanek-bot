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
/** Official Steam brand dark blue (#1b2838). */
const STEAM_COLOR = 0x1b2838;
/** Near-black matching the Epic free-games mockup. */
const EPIC_COLOR = 0x1a1a1a;

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/** Always show this many Steam deals when the feed allows. */
export const STEAM_DIGEST_SIZE = 10;

/** Max game rows for Epic (Components V2 limits). */
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
 */
export async function sendMusicPlayerReply(
  interaction: {
    deferred: boolean;
    replied: boolean;
    deleteReply: () => Promise<unknown>;
    followUp: (options: {
      components: ContainerBuilder[];
      flags: typeof MessageFlags.IsComponentsV2;
    }) => Promise<unknown>;
    editReply: (options: {
      components: ContainerBuilder[];
      flags: typeof MessageFlags.IsComponentsV2;
    }) => Promise<unknown>;
    reply: (options: {
      components: ContainerBuilder[];
      flags: typeof MessageFlags.IsComponentsV2;
    }) => Promise<unknown>;
  },
  display: {
    components: ContainerBuilder[];
    flags: typeof MessageFlags.IsComponentsV2;
  },
): Promise<void> {
  const payload = {
    components: display.components,
    flags: display.flags,
  };

  if (interaction.deferred || interaction.replied) {
    try {
      await interaction.deleteReply();
    } catch {
      /* message may already be gone */
    }
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
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

  // Discord allows 5 buttons per row: Pause · Skip · Stop · Loop · Shuffle
  const controls = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
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
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  const best = topDiscountPct(top);
  const threshold = minDiscountPct && minDiscountPct > 0 ? minDiscountPct : null;
  const fingerprint = steamDigestFingerprint(top);

  const title =
    threshold != null
      ? `## [Steam Sales — ${threshold}% Off or More](${STEAM_SPECIALS_URL})`
      : best > 0
        ? `## [Steam Sales — Best Deals (up to ${best}% off)](${STEAM_SPECIALS_URL})`
        : `## [Steam Sales](${STEAM_SPECIALS_URL})`;

  const intro = [
    title,
    top.length > 0
      ? `**Top ${top.length}** deal${top.length !== 1 ? 's' : ''}` +
        (best > 0 ? ` · deepest discounts first` : '')
      : 'No deals matched your filters.',
    '-# Use the dropdown to wishlist games for sale DMs.',
    // Hidden marker for reliable duplicate detection across Components V2.
    `-# ${STEAM_DIGEST_MARKER}${fingerprint}`,
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
  const current = games.filter((g) => !g.isUpcoming).slice(0, EPIC_DIGEST_MAX);
  const upcoming = games.filter((g) => g.isUpcoming).slice(0, EPIC_DIGEST_MAX);

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
  const blob = collectMessageTextContent(message);
  const idx = blob.indexOf(STEAM_DIGEST_MARKER);
  if (idx === -1) return null;
  const start = idx + STEAM_DIGEST_MARKER.length;
  // Fingerprint is deal ids joined by | until whitespace / end of line
  const rest = blob.slice(start);
  const match = rest.match(/^([^\s\n]+)/);
  return match?.[1] ?? null;
}
