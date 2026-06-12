# Discord Bot — Music & News

A TypeScript Discord bot with two features:

- **🎵 Music player** — plays audio from YouTube in your voice channel, with a queue.
- **📰 News** — polls RSS feeds on a schedule and posts new articles as rich embeds to a fixed channel, never duplicating.

Built with [discord.js](https://discord.js.org) v14, slash commands, and a clean, modular architecture.

---

## Commands

| Command         | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `/play <query>` | Play a song from a YouTube URL **or** a search term. Joins the voice channel you're currently in. |
| `/queue`        | Show the current queue and what's playing.                                                        |
| `/playing`      | Show the track that's playing right now.                                                          |
| `/skip`         | Skip the current track and advance to the next one.                                               |
| `/stop`         | Stop playback, clear the queue, and leave the voice channel.                                      |

The bot also posts news automatically — no command needed.

---

## Prerequisites

- **Node.js ≥ 22.12** (developed on Node 26).
- **FFmpeg** on your `PATH` (`ffmpeg -version` should work). Audio is transcoded through it.
- That's it — a recent **yt-dlp** binary is downloaded automatically when you run `npm install`.

> YouTube occasionally requires a JavaScript runtime to solve playback challenges; the Node.js you already have satisfies this.

---

## Setup

```bash
# 1. Install dependencies (also downloads the yt-dlp binary)
npm install

# 2. Add your bot token
cp .env.example .env
#   then edit .env and set DISCORD_TOKEN=...

# 3. Review the configuration (channel ID, feeds, guild ID, etc.)
#   src/config/config.json

# 4. Register the slash commands with Discord
npm run deploy

# 5. Start the bot
npm run dev      # development (auto-reload)
# or
npm start        # plain run
```

### Inviting the bot

The bot needs the `bot` and `applications.commands` OAuth2 scopes, plus these permissions:

- **News channel:** View Channel, Send Messages, Embed Links
- **Voice:** Connect, Speak

---

## Configuration

Non-secret settings live in [`src/config/config.json`](src/config/config.json); the only secret (the token) lives in `.env`.

```jsonc
{
  "discord": {
    "clientId": "923262419923513445", // your application ID (public)
    "guildId": "1497774735419773029", // register commands here instantly; null = global (~1h)
  },
  "news": {
    "channelId": "1514977585006907492", // where news embeds are posted
    "cron": "*/15 * * * *", // poll every 15 minutes
    "feeds": [
      {
        "name": "Reuters (via Google News)",
        "url": "https://news.google.com/rss/search?q=site%3Areuters.com&hl=en-US&gl=US&ceid=US%3Aen",
      },
      { "name": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/technology-lab" },
    ],
    "maxSeenIds": 5000, // how many "already-posted" ids to remember per feed
    "postOnFirstRun": false, // true = post the current backlog the first time
  },
  "music": {
    "idleTimeoutSec": 120, // leave voice after being idle this long
    "maxQueueSize": 100,
  },
  "embedColor": "#5865F2",
}
```

### How news de-duplication works

- Each article is identified by its RSS `guid` (falling back to its link). The set of already-posted ids is stored in `data/seen.json` so the bot never reposts across restarts.
- **First run:** to avoid flooding the channel with old articles, the bot records the current backlog as "seen" **without posting it**. Only articles published after that point get posted. Set `postOnFirstRun: true` if you'd rather post the existing backlog once.
- Add or remove feeds by editing `news.feeds` — each just needs a `name` and an RSS `url`.

---

## Scripts

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Run with auto-reload (`tsx watch`).   |
| `npm start`         | Run the bot.                          |
| `npm run deploy`    | Register slash commands with Discord. |
| `npm run typecheck` | Type-check with `tsc` (no emit).      |
| `npm run lint`      | Lint with ESLint.                     |
| `npm run format`    | Format with Prettier.                 |

---

## Troubleshooting

- **A song won't play / "Could not load that track."** YouTube changes often break extraction. Update the bundled yt-dlp: delete `node_modules/youtube-dl-exec` and reinstall, or run the binary's self-update. The playback backend is isolated in `src/music/sources/YouTubeSource.ts` and can be swapped if needed.
- **No audio at all.** Make sure `ffmpeg -version` works and the bot has **Connect** + **Speak** permissions in the voice channel.
- **Slash commands don't appear.** Run `npm run deploy`. Guild-scoped commands (with a `guildId`) appear instantly; global commands take up to an hour.
- **News isn't posting.** It only posts articles newer than the first run (see above). Confirm the bot can see and post in the configured `channelId`.

---

## Security

The bot token grants full control of the bot — keep it only in `.env` (which is git-ignored) and **never commit it**. If a token is ever exposed, reset it in the [Discord Developer Portal](https://discord.com/developers/applications).
