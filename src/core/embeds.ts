import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import type { FeedItem, Track } from './types';

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Live / Unknown';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

/** Embed for a single track (used by /play and /playing). `label` is the author line. */
export function buildTrackEmbed(track: Track, label: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setAuthor({ name: label })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: 'Duration', value: formatDuration(track.durationSec), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true },
    );
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

/** Embed listing the current track and the next items in the queue. */
export function buildQueueEmbed(current: Track | null, queue: Track[]): EmbedBuilder {
  const lines: string[] = [];
  if (current) {
    lines.push(
      `**Now playing:** [${current.title}](${current.url}) \`${formatDuration(current.durationSec)}\``,
    );
  }
  if (queue.length > 0) {
    const shown = queue.slice(0, 10);
    lines.push('', '**Up next:**');
    shown.forEach((track, i) => {
      lines.push(
        `\`${i + 1}.\` [${track.title}](${track.url}) \`${formatDuration(track.durationSec)}\``,
      );
    });
    if (queue.length > shown.length) {
      lines.push(`…and ${queue.length - shown.length} more.`);
    }
  }

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('🎶 Queue')
    .setDescription(lines.length > 0 ? lines.join('\n') : 'The queue is empty.')
    .setFooter({ text: `${queue.length} track(s) queued` });
}

/** Embed for a news article. */
export function buildNewsEmbed(item: FeedItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setFooter({ text: item.feedName });
  if (item.snippet) embed.setDescription(item.snippet.slice(0, 500));
  if (item.image) embed.setImage(item.image);
  if (item.isoDate) {
    const date = new Date(item.isoDate);
    if (!Number.isNaN(date.getTime())) embed.setTimestamp(date);
  }
  return embed;
}
