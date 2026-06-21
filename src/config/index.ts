import './env';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FeedConfig {
  name: string;
  url: string;
}

export interface Config {
  discord: {
    clientId: string;
    /** When set, commands are registered to this guild (instant). Otherwise globally. */
    guildId: string | null;
  };
  news: {
    channelId: string;
    /** Cron expression controlling how often feeds are polled. */
    cron: string;
    feeds: FeedConfig[];
    /** Maximum number of "seen" article ids retained per feed. */
    maxSeenIds: number;
    /** Post the current backlog on the very first run instead of seeding silently. */
    postOnFirstRun: boolean;
  };
  music: {
    /** Leave the voice channel after being idle for this many seconds. */
    idleTimeoutSec: number;
    maxQueueSize: number;
  };
  steam: {
    /** Channel ID where Steam Daily Deal embeds are posted. */
    channelId: string;
    /** Cron expression controlling how often the Steam feed is polled. */
    cron: string;
    /** Maximum number of "seen" deal ids retained (bounds file growth). */
    maxSeenIds: number;
    /** Post the current deals backlog on the very first run instead of seeding silently. */
    postOnFirstRun: boolean;
  };
  /** Default embed color, parsed from a hex string in config.json. */
  embedColor: number;
}

type Json = Record<string, unknown>;

const configDir = dirname(fileURLToPath(import.meta.url));

function loadRawConfig(): Json {
  try {
    return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Json;
  } catch (error) {
    throw new Error(`Failed to read src/config/config.json: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config: "${name}" must be a non-empty string.`);
  }
  return value;
}

function parseColor(value: unknown): number {
  const text = requireString(value, 'embedColor').replace(/^#/, '');
  const color = Number.parseInt(text, 16);
  if (Number.isNaN(color)) {
    throw new Error('Invalid config: "embedColor" must be a hex color like "#5865F2".');
  }
  return color;
}

function loadConfig(): Config {
  const raw = loadRawConfig();
  const discord = (raw.discord ?? {}) as Json;
  const news = (raw.news ?? {}) as Json;
  const music = (raw.music ?? {}) as Json;
  const steam = (raw.steam ?? {}) as Json;

  const feeds = (Array.isArray(news.feeds) ? news.feeds : []) as Json[];
  if (feeds.length === 0) {
    throw new Error('Invalid config: "news.feeds" must contain at least one feed.');
  }

  return {
    discord: {
      clientId: requireString(discord.clientId, 'discord.clientId'),
      guildId: discord.guildId ? requireString(discord.guildId, 'discord.guildId') : null,
    },
    news: {
      channelId: requireString(news.channelId, 'news.channelId'),
      cron: requireString(news.cron, 'news.cron'),
      feeds: feeds.map((feed, i) => ({
        name: requireString(feed.name, `news.feeds[${i}].name`),
        url: requireString(feed.url, `news.feeds[${i}].url`),
      })),
      maxSeenIds: typeof news.maxSeenIds === 'number' ? news.maxSeenIds : 5000,
      postOnFirstRun: Boolean(news.postOnFirstRun),
    },
    music: {
      idleTimeoutSec: typeof music.idleTimeoutSec === 'number' ? music.idleTimeoutSec : 120,
      maxQueueSize: typeof music.maxQueueSize === 'number' ? music.maxQueueSize : 100,
    },
    steam: {
      channelId: requireString(steam.channelId, 'steam.channelId'),
      cron: requireString(steam.cron, 'steam.cron'),
      maxSeenIds: typeof steam.maxSeenIds === 'number' ? steam.maxSeenIds : 500,
      postOnFirstRun: Boolean(steam.postOnFirstRun),
    },
    embedColor: parseColor(raw.embedColor),
  };
}

function loadToken(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.');
  }
  return token;
}

export const config: Config = loadConfig();
export const DISCORD_TOKEN: string = loadToken();
