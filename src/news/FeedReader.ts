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
  // Primary: standard enclosure
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) {
    return item.enclosure.url;
  }

  // Common in many feeds (e.g. media:thumbnail, media:content)
  const media =
    (item as Record<string, unknown>)['media:thumbnail'] ||
    (item as Record<string, unknown>)['media:content'];
  const getUrl = (m: unknown): string | undefined => {
    if (m && typeof m === 'object' && 'url' in (m as object)) {
      const u = (m as { url?: unknown }).url;
      return typeof u === 'string' ? u : undefined;
    }
    return undefined;
  };
  const url1 = getUrl(media);
  if (url1) return url1;
  if (Array.isArray(media)) {
    const url2 = getUrl(media[0]);
    if (url2) return url2;
  }

  return undefined;
}
