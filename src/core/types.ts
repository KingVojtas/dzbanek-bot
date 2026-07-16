import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Readable } from 'node:stream';
import type { Config } from '../config';
import type { Logger } from './logger';
import type { LevelingService } from '../leveling/LevelingService';
import type { MusicManager } from '../music/MusicManager';
import type { NewsService } from '../news/NewsService';
import type { StatsStore } from '../stats/StatsStore';
import type { WishlistStore } from '../wishlist/WishlistStore';

/** Shared services injected into every command's `execute`. */
export interface Services {
  config: Config;
  logger: Logger;
  music: MusicManager;
  news: NewsService;
  /** Optional for features that need them (stats, wishlist commands). */
  stats?: StatsStore;
  wishlist?: WishlistStore;
  /** Chat XP / leveling (requires Message Content intent). */
  leveling?: LevelingService;
}

/** Loop modes for music queue. */
export type LoopMode = 'off' | 'track' | 'queue';

/** A slash command: its definition plus its handler. */
export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, services: Services): Promise<void>;
}

/** A single playable item in the music queue. */
export interface Track {
  title: string;
  url: string;
  durationSec: number;
  thumbnail?: string;
  /** Display name of who requested the track. */
  requestedBy: string;
  /** Discord user id of the requester (for stats when playback actually starts). */
  requestedById?: string;

  /** Uploader / channel / artist name (from yt-dlp channel/uploader or Spotify). */
  uploader?: string;
  /** View count (raw number from platform). */
  views?: number;
  /** ISO date string or short human string for when the track was uploaded/published. */
  uploadedAt?: string;
  /** Origin of the track for display purposes. */
  source?: 'youtube' | 'spotify' | 'soundcloud' | 'other';
}

/**
 * A source that can turn user input into tracks and open an audio stream.
 * Keeping playback behind this interface lets us swap the YouTube backend
 * (e.g. yt-dlp -> youtubei.js) without touching the rest of the bot.
 */
export interface TrackSource {
  resolve(input: string, requestedBy: string): Promise<Track[]>;
  stream(track: Track): Promise<Readable>;
}

/** A free game from the Epic Games Store weekly promotion. */
export interface EpicFreeGame {
  title: string;
  description: string;
  /** Original retail price string, e.g. "$19.99". */
  originalPrice: string;
  /** Canonical Epic Store product URL. */
  storeUrl: string;
  /** OfferImageWide URL for the embed hero image. */
  image?: string;
  /** Publisher / seller name. */
  seller?: string;
  /** ISO date when the free offer ends (or when the upcoming offer ends). */
  endDate?: string;
  /** True when the game is not yet free but will be free next week. */
  isUpcoming: boolean;
  /** ISO date when the upcoming free offer starts. Only set when isUpcoming is true. */
  upcomingStartDate?: string;
}

/** A normalized Steam deal from the game-deals.app RSS feed. */
export interface SteamDealItem {
  /** Feed guid — unique per deal, used as the dedup key. */
  id: string;
  /** Full feed title, e.g. "Hades II (-50% €12.49)". */
  title: string;
  /** Game name with the price/discount suffix stripped. */
  gameName: string;
  /** Steam store page URL. */
  link: string;
  /** Discounted sale price, e.g. "€12.49". */
  salePrice?: string;
  /** Original undiscounted price, e.g. "€24.99". */
  originalPrice?: string;
  /** Discount percentage string, e.g. "-50%". */
  discount?: string;
  /** Deal expiry date string, e.g. "2026-06-25". */
  expires?: string;
  publisher?: string;
  /** IGDB aggregate rating, e.g. "83/100". */
  igdbRating?: string;
  /** Metacritic score string, e.g. "80/100". */
  metascore?: string;
  /** Composite deal score from game-deals.app, e.g. "81.5/100". */
  dealScore?: string;
  /** Comma-separated genre list. */
  genres?: string;
  /** Short game description extracted from the feed body. */
  description?: string;
  /** Steam CDN header image URL, derived from the Steam app ID in the link. */
  image?: string;
  isoDate?: string;
}

/** A normalized RSS/Atom article. */
export interface FeedItem {
  id: string;
  title: string;
  link: string;
  snippet?: string;
  image?: string;
  isoDate?: string;
  feedName: string;
}
