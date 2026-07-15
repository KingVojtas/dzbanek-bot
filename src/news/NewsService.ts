import { type Client, type SendableChannels } from 'discord.js';
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

    // Deletes the bot's last message in the channel once, immediately before
    // the first new batch is sent — regardless of how many feeds have updates.
    let prevDeleted = false;
    const deleteOnce = async (): Promise<void> => {
      if (prevDeleted) return;
      prevDeleted = true;
      await this.deleteLastBotMessage(channel);
    };

    for (const feed of this.config.news.feeds) {
      try {
        await this.pollFeed(feed, channel, deleteOnce);
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

  private async pollFeed(
    feed: FeedConfig,
    channel: SendableChannels,
    deleteOnce: () => Promise<void>,
  ): Promise<void> {
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

    // Delete the bot's previous message once before sending anything new.
    await deleteOnce();

    // Post oldest-first so the channel reads chronologically.
    const ordered = [...fresh].reverse();
    for (let i = 0; i < ordered.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const batch = ordered.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
      await channel.send({
        content: `**📰 New from ${feed.name}** (${batch.length} article${batch.length === 1 ? '' : 's'})`,
        embeds: batch.map((item) => buildNewsEmbed(item)),
      });
    }

    await this.store.add(
      feed.url,
      ordered.map((item) => item.id),
    );
    this.logger.info(`Posted ${ordered.length} new item(s) from "${feed.name}".`);
  }

  /**
   * Scans the most recent messages in the channel and deletes the last one
   * posted by this bot. Errors are caught silently so a missing or already-
   * deleted message never crashes the poll cycle.
   */
  private async deleteLastBotMessage(channel: SendableChannels): Promise<void> {
    if (!channel.isTextBased()) return;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      const last = recent.find((msg) => msg.author.id === this.client.user?.id);
      if (last) {
        await last.delete();
        this.logger.info(`News: deleted previous bot message (id: ${last.id}).`);
      }
    } catch {
      this.logger.warn('News: could not delete previous message (may already be deleted).');
    }
  }
}
