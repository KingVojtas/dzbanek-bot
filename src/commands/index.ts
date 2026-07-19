import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { play } from './music/play';
import { playing } from './music/playing';
import { queue } from './music/queue';
import { skip } from './music/skip';
import { stop } from './music/stop';
import { pause } from './music/pause';
import { resume } from './music/resume';
import { shuffle } from './music/shuffle';
import { loop } from './music/loop';
import { remove } from './music/remove';
import { game } from './music/game';
import { lyrics } from './music/lyrics';
import { playlist } from './music/playlist';
import { musicStatus } from './music/music-status';
import { wishlistAdd } from './deals/wishlist-add';
import { wishlistList } from './deals/wishlist-list';
import { wishlistRemove } from './deals/wishlist-remove';
import { stats } from './stats/stats';
import { top } from './stats/top';
import { setup } from './admin/setup';
import { rank } from './leveling/rank';
import { leaderboard } from './leveling/leaderboard';
import { help } from './help';

/** Every slash command the bot exposes. Add new commands here. */
export const commandList: Command[] = [
  help,
  play,
  queue,
  playing,
  skip,
  stop,
  pause,
  resume,
  shuffle,
  loop,
  remove,
  lyrics,
  game,
  playlist,
  musicStatus,
  wishlistAdd,
  wishlistList,
  wishlistRemove,
  stats,
  top,
  rank,
  leaderboard,
  setup,
];

export function buildCommandCollection(): Collection<string, Command> {
  const collection = new Collection<string, Command>();
  for (const command of commandList) {
    collection.set(command.data.name, command);
  }
  return collection;
}
