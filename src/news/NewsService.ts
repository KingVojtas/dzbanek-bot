import { type Client, type SendableChannels } from 'discord.js';
import type { Config, FeedConfig } from '../config';
import { buildNewsEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import { GuildSettingsRepository } from '../db/repositories';
import { FeedReader } from './FeedReader';
import type { SeenStore } from './SeenStore';

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Polls configured RSS feeds and posts new-only articles as embeds. */
export class NewsService {
  private readonly reader = new FeedReader();
  private readonly guildSettings = new GuildSettingsRepository();

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async poll(): Promise<void> {
    const channels = await this.resolveChannels();
    if (channels.length === 0) {
      this.logger.warn('News: no sendable channels configured (legacy or guild settings).');
      return;
    }

    // Append new posts as a real feed (do not delete previous bot messages).
    // Steam/Epic digests still replace their own previous message separately.
    for (const feed of this.config.news.feeds) {
      try {
        await this.pollFeed(feed, channels);
      } catch (error) {
        this.logger.error(`Failed to poll feed "${feed.name}":`, error);
      }
    }
  }

  /**
   * Collect unique channel IDs from legacy config + enabled GuildSettings,
   * then resolve each to a sendable channel.
   */
  private async resolveChannels(): Promise<SendableChannels[]> {
    const channelIds = new Set<string>();

    if (this.config.news.channelId) {
      channelIds.add(this.config.news.channelId);
    }

    try {
      const rows = await this.guildSettings.findNewsEnabled();
      for (const row of rows) {
        if (row.newsChannelId) channelIds.add(row.newsChannelId);
      }
    } catch (error) {
      this.logger.warn('News: failed to load guild settings for channels:', error);
    }

    const channels: SendableChannels[] = [];
    for (const channelId of channelIds) {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !channel.isSendable()) {
          this.logger.warn(`News channel ${channelId} is missing or not a sendable text channel.`);
          continue;
        }
        channels.push(channel);
      } catch (error) {
        this.logger.warn(`News: failed to fetch channel ${channelId}:`, error);
      }
    }
    return channels;
  }

  private async pollFeed(feed: FeedConfig, channels: SendableChannels[]): Promise<void> {
    const items = await this.reader.read(feed);
    const hasChecks = await Promise.all(
      items.map((item) => (item.id ? this.store.has(feed.url, item.id) : Promise.resolve(true))),
    );
    const fresh = items.filter((_, index) => !hasChecks[index]);
    if (fresh.length === 0) return;

    // On the very first run, record the backlog as seen without posting it,
    // so we don't flood the channel with old articles.
    if ((await this.store.isEmpty(feed.url)) && !this.config.news.postOnFirstRun) {
      await this.store.add(
        feed.url,
        fresh.map((item) => item.id),
      );
      this.logger.info(
        `Seeded ${fresh.length} existing item(s) from "${feed.name}" (not posting backlog).`,
      );
      return;
    }

    // Post oldest-first so the channel reads chronologically.
    const ordered = [...fresh].reverse();
    for (const channel of channels) {
      for (let i = 0; i < ordered.length; i += MAX_EMBEDS_PER_MESSAGE) {
        const batch = ordered.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
        try {
          await channel.send({
            embeds: batch.map((item) => buildNewsEmbed(item)),
          });
        } catch (error) {
          this.logger.error(`News: failed to post "${feed.name}" to channel ${channel.id}:`, error);
        }
      }
    }

    await this.store.add(
      feed.url,
      ordered.map((item) => item.id),
    );
    this.logger.info(
      `Posted ${ordered.length} new item(s) from "${feed.name}" to ${channels.length} channel(s).`,
    );
  }
}
