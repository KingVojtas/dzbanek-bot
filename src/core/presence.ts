import { ActivityType, type Client } from 'discord.js';
import type { Logger } from './logger';
import type { MusicManager } from '../music/MusicManager';

/** Shown under the bot profile (Discord Application “About Me”). Max ~400 chars. */
export const BOT_ABOUT_ME = [
  '🎵 Multi-server music · Steam & Epic deals · news · levels',
  '',
  'Play YouTube, Spotify & SoundCloud. Queue, lyrics, radio playlist.',
  'Daily Steam digests & Epic free games. Rank up by chatting.',
  '',
  '/help · /play · /queue · website admin for setup',
].join('\n');

const ROTATE_MS = 45_000;

type PresenceLine = {
  name: string;
  type: ActivityType;
  /** When true, name is taken from live now-playing if available. */
  preferNowPlaying?: boolean;
};

/**
 * Rotating status lines. When something is playing, “Listening to …” wins.
 */
function buildRotation(serverCount: number): PresenceLine[] {
  const n = Math.max(1, serverCount);
  return [
    { name: 'music', type: ActivityType.Listening, preferNowPlaying: true },
    { name: `/play · ${n} server${n === 1 ? '' : 's'}`, type: ActivityType.Playing },
    { name: 'Steam deals 🔥', type: ActivityType.Watching },
    { name: 'Epic free games 🎁', type: ActivityType.Watching },
    { name: '/help · queue · lyrics', type: ActivityType.Listening },
    { name: 'with the playlist radio', type: ActivityType.Playing },
    { name: 'for level-ups 🏅', type: ActivityType.Competing },
    { name: 'dzbanek vibes', type: ActivityType.Listening },
  ];
}

/**
 * Set About Me (best-effort) + start a cool rotating presence.
 * Call once on ClientReady.
 */
export function startBotPresence(client: Client, logger: Logger, music?: MusicManager): void {
  void applyApplicationBio(client, logger);

  let index = 0;
  const tick = () => {
    try {
      applyPresenceTick(client, music, index);
      index = (index + 1) % 1000;
    } catch (err) {
      logger.debug('Presence update failed:', err);
    }
  };

  tick();
  const timer = setInterval(tick, ROTATE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
}

function applyPresenceTick(client: Client, music: MusicManager | undefined, index: number): void {
  if (!client.user) return;

  const np = music?.getPublicNowPlaying() ?? null;
  if (np?.title && !np.paused) {
    const title = np.title.length > 96 ? `${np.title.slice(0, 93)}…` : np.title;
    const label = np.artist ? `${title} — ${np.artist}` : title;
    client.user.setPresence({
      status: 'online',
      activities: [
        {
          name: label.slice(0, 128),
          type: ActivityType.Listening,
        },
      ],
    });
    return;
  }

  const lines = buildRotation(client.guilds.cache.size);
  const line = lines[index % lines.length]!;
  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: line.name.slice(0, 128),
        type: line.type,
      },
    ],
  });
}

/** PATCH application description (About Me). Safe to ignore failures. */
async function applyApplicationBio(client: Client, logger: Logger): Promise<void> {
  try {
    // discord.js ClientApplication#edit when available
    if (client.application) {
      await client.application.fetch().catch(() => null);
      if (typeof client.application.edit === 'function') {
        await client.application.edit({ description: BOT_ABOUT_ME.slice(0, 400) });
        logger.info('Bot About Me (description) updated.');
        return;
      }
    }
  } catch (err) {
    logger.debug('Could not set application description via application.edit:', err);
  }

  // REST fallback
  try {
    await client.rest.patch('/applications/@me', {
      body: { description: BOT_ABOUT_ME.slice(0, 400) },
    });
    logger.info('Bot About Me (description) updated via REST.');
  } catch (err) {
    logger.debug(
      'Could not set application description (set it in Developer Portal if needed):',
      err,
    );
  }
}
