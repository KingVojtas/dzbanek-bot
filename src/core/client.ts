import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Build the Discord client with the minimal, non-privileged intents this bot
 * needs: guild metadata (for slash commands + channels) and voice state (so the
 * music player can see which channel the caller is in). No MessageContent or
 * GuildMembers — everything is driven by slash commands.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}
