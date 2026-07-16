import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Build the Discord client with the intents this bot needs:
 * - Guilds: slash commands + channel access
 * - GuildVoiceStates: music player (caller's voice channel)
 * - GuildMembers: welcome / goodbye (privileged — Developer Portal)
 * - GuildMessages + MessageContent: chat XP leveling (Message Content is privileged)
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // So leave events still resolve user tag/avatar when the member was not fully cached.
    partials: [Partials.GuildMember, Partials.User],
  });
}
