import type { Client, SendableChannels } from 'discord.js';
import type { Config, FeedConfig } from '../config';
import { buildNewsEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import { FeedReader } from './FeedReader';
import type { SeenStore } from './SeenStore';

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Polls configured RSS feeds and posts new-only articles as embeds. */
export class NewsService {
  private readonly reader = new FeedReader();

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async poll(): Promise<void> {
    const channel = await this.resolveChannel();
    if (!channel) return;

    for (const feed of this.config.news.feeds) {
      try {
        await this.pollFeed(feed, channel);
      } catch (error) {
        this.logger.error(`Failed to poll feed "${feed.name}":`, error);
      }
    }
  }

  private async resolveChannel(): Promise<SendableChannels | null> {
    const channel = await this.client.channels.fetch(this.config.news.channelId);
    if (!channel || !channel.isSendable()) {
      this.logger.warn(
        `News channel ${this.config.news.channelId} is missing or not a sendable text channel.`,
      );
      return null;
    }
    return channel;
  }

  private async pollFeed(feed: FeedConfig, channel: SendableChannels): Promise<void> {
    const items = await this.reader.read(feed);
    const fresh = items.filter((item) => item.id && !this.store.has(feed.url, item.id));
    if (fresh.length === 0) return;

    // On the very first run, record the backlog as seen without posting it,
    // so we don't flood the channel with old articles.
    if (this.store.isEmpty(feed.url) && !this.config.news.postOnFirstRun) {
      this.store.add(
        feed.url,
        fresh.map((item) => item.id),
      );
      this.store.save();
      this.logger.info(
        `Seeded ${fresh.length} existing item(s) from "${feed.name}" (not posting backlog).`,
      );
      return;
    }

    // Post oldest-first so the channel reads chronologically.
    const ordered = [...fresh].reverse();
    for (let i = 0; i < ordered.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const batch = ordered.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
      await channel.send({ embeds: batch.map((item) => buildNewsEmbed(item)) });
    }

    this.store.add(
      feed.url,
      ordered.map((item) => item.id),
    );
    this.store.save();
    this.logger.info(`Posted ${ordered.length} new item(s) from "${feed.name}".`);
  }
}
