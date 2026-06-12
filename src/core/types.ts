import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import type { Readable } from 'node:stream';
import type { Config } from '../config';
import type { Logger } from './logger';
import type { MusicManager } from '../music/MusicManager';
import type { NewsService } from '../news/NewsService';

/** Shared services injected into every command's `execute`. */
export interface Services {
  config: Config;
  logger: Logger;
  music: MusicManager;
  news: NewsService;
}

/** A slash command: its definition plus its handler. */
export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, services: Services): Promise<void>;
}

/** A single playable item in the music queue. */
export interface Track {
  title: string;
  url: string;
  durationSec: number;
  thumbnail?: string;
  requestedBy: string;
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
