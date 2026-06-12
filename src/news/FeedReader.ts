import Parser from 'rss-parser';
import type { FeedConfig } from '../config';
import type { FeedItem } from '../core/types';

/** Reads an RSS/Atom feed and normalizes its items into `FeedItem`s. */
export class FeedReader {
  private readonly parser = new Parser();

  async read(feed: FeedConfig): Promise<FeedItem[]> {
    const parsed = await this.parser.parseURL(feed.url);
    return (parsed.items ?? []).map((item) => toFeedItem(item, feed.name));
  }
}

function toFeedItem(item: Parser.Item, feedName: string): FeedItem {
  return {
    // Prefer guid: Google News links redirect and carry volatile tracking params,
    // while the guid is stable across fetches.
    id: item.guid ?? item.link ?? item.title ?? '',
    title: item.title ?? 'Untitled',
    link: item.link ?? '',
    snippet: item.contentSnippet?.trim() || undefined,
    image: extractImage(item),
    isoDate: item.isoDate,
    feedName,
  };
}

function extractImage(item: Parser.Item): string | undefined {
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) {
    return item.enclosure.url;
  }
  return undefined;
}
