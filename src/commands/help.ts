import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../core/embeds';
import type { Command } from '../core/types';

export const help: Command = {
  data: new SlashCommandBuilder().setName('help').setDescription('List bot commands by category.'),

  async execute(interaction) {
    const music = [
      '`/play` — YouTube / Spotify / SoundCloud (autocomplete + `play_next`)',
      '`/queue` — Paged queue · remove · play next',
      '`/playing` · `/skip` · `/stop` · `/pause` · `/resume`',
      '`/shuffle` · `/loop` · `/remove` · `/lyrics` · `/game`',
      '`/playlist` — Server saved playlist (also used for radio)',
      '`/music-status` — Queue, volume, bridge health',
      'Player buttons: Prev · Pause · Skip · Stop · Loop · Vol · Shuffle · Lyrics',
    ].join('\n');

    const deals = [
      '`/wishlist-add` · `/wishlist-list` · `/wishlist-remove` — sale DMs',
      'Steam digests — top deals (admin channel; cron ~every 6h)',
      'Epic free games — weekly free lineup (admin channel)',
    ].join('\n');

    const levels = [
      '`/rank` — Your level & XP bar',
      '`/leaderboard` — Server XP leaders',
      'Enable leveling in the **web admin** + optional level-up channel',
    ].join('\n');

    const admin = [
      '**Website admin** — channels for news / Steam / Epic / welcome',
      'News keywords — include terms, or `-term` to mute',
      'Welcome role buttons — self-assign roles on join',
      '`/setup` — Server Manage (legacy channel setup)',
      'Music bridge badge on admin = home YouTube worker status',
    ].join('\n');

    const embed = buildInfoEmbed(
      [
        '### 🎵 Music',
        music,
        '',
        '### 🎮 Deals',
        deals,
        '',
        '### 🏅 Levels',
        levels,
        '',
        '### ⚙️ Admin & config',
        admin,
      ].join('\n'),
      'Dzbanek bot · Help',
    );
    embed.setFooter({ text: 'Tip: most server options are in the website admin dashboard.' });

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
