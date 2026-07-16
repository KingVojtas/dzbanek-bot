import { type Client, type SendableChannels } from 'discord.js';
import type { Config, FeedConfig } from '../config';
import { buildNewsEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import { GuildSettingsRepository, type GuildSettings } from '../db/repositories';
import { isPostHourNow, matchesKeywords } from '../utils/digest-schedule';
import { FeedReader } from './FeedReader';
import type { SeenStore } from './SeenStore';

const MAX_EMBEDS_PER_MESSAGE = 10;

type NewsTarget = {
  channel: SendableChannels;
  settings: GuildSettings | null;
};

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
    const targets = await this.resolveTargets();
    if (targets.length === 0) {
      this.logger.warn('News: no sendable channels configured (legacy or guild settings).');
      return;
    }

    for (const feed of this.config.news.feeds) {
      try {
        await this.pollFeed(feed, targets);
      } catch (error) {
        this.logger.error(`Failed to poll feed "${feed.name}":`, error);
      }
    }
  }

  private async resolveTargets(): Promise<NewsTarget[]> {
    const byChannel = new Map<string, NewsTarget>();

    if (this.config.news.channelId) {
      const ch = await this.fetchSendable(this.config.news.channelId);
      if (ch) byChannel.set(ch.id, { channel: ch, settings: null });
    }

    try {
      const rows = await this.guildSettings.findNewsEnabled();
      for (const row of rows) {
        if (!row.newsChannelId) continue;
        const ch = await this.fetchSendable(row.newsChannelId);
        if (!ch) continue;
        byChannel.set(ch.id, { channel: ch, settings: row });
      }
    } catch (error) {
      this.logger.warn('News: failed to load guild settings for channels:', error);
    }

    return [...byChannel.values()];
  }

  private async fetchSendable(channelId: string): Promise<SendableChannels | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isSendable()) {
        this.logger.warn(`News channel ${channelId} is missing or not a sendable text channel.`);
        return null;
      }
      return channel;
    } catch (error) {
      this.logger.warn(`News: failed to fetch channel ${channelId}:`, error);
      return null;
    }
  }

  private async pollFeed(feed: FeedConfig, targets: NewsTarget[]): Promise<void> {
    const items = await this.reader.read(feed);
    const hasChecks = await Promise.all(
      items.map((item) => (item.id ? this.store.has(feed.url, item.id) : Promise.resolve(true))),
    );
    const fresh = items.filter((_, index) => !hasChecks[index]);
    if (fresh.length === 0) return;

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

    const ordered = [...fresh].reverse();
    let postedChannels = 0;

    for (const target of targets) {
      if (!isPostHourNow(target.settings?.newsPostHourUtc ?? null)) {
        continue;
      }

      const keywords = target.settings?.newsKeywords ?? null;
      const forGuild = ordered.filter((item) => {
        const hay = `${item.title ?? ''} ${item.snippet ?? ''}`;
        return matchesKeywords(hay, keywords);
      });

      if (forGuild.length === 0) continue;

      let ok = false;
      for (let i = 0; i < forGuild.length; i += MAX_EMBEDS_PER_MESSAGE) {
        const batch = forGuild.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
        try {
          await target.channel.send({
            embeds: batch.map((item) => buildNewsEmbed(item)),
          });
          ok = true;
        } catch (error) {
          this.logger.error(
            `News: failed to post "${feed.name}" to channel ${target.channel.id}:`,
            error,
          );
        }
      }
      if (ok) postedChannels += 1;
    }

    await this.store.add(
      feed.url,
      ordered.map((item) => item.id),
    );
    this.logger.info(
      `Posted "${feed.name}" (${ordered.length} new) to ${postedChannels}/${targets.length} channel(s).`,
    );
  }
}
