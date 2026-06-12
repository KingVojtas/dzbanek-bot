import { Collection } from 'discord.js';
import type { Command } from '../core/types';
import { play } from './music/play';
import { playing } from './music/playing';
import { queue } from './music/queue';
import { skip } from './music/skip';
import { stop } from './music/stop';

/** Every slash command the bot exposes. Add new commands here. */
export const commandList: Command[] = [play, queue, playing, skip, stop];

export function buildCommandCollection(): Collection<string, Command> {
  const collection = new Collection<string, Command>();
  for (const command of commandList) {
    collection.set(command.data.name, command);
  }
  return collection;
}
