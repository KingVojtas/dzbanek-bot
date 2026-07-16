import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Build the Discord client with the intents this bot needs:
 * - Guilds: slash commands + channel access
 * - GuildVoiceStates: music player (caller's voice channel)
 * - GuildMembers: welcome / goodbye messages (privileged — enable in Developer Portal)
 *
 * No MessageContent — everything else is slash-command driven.
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
    // So leave events still resolve user tag/avatar when the member was not fully cached.
    partials: [Partials.GuildMember, Partials.User],
  });
}
