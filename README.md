# 🤖 dzbanek-bot

A feature-rich Discord bot built with **TypeScript** and **discord.js v14**. It plays YouTube music in voice channels, posts RSS news articles automatically, and delivers a daily curated digest of the best Steam game deals — complete with live pricing, review filtering, and automatic channel cleanup.

---

## ✨ Features

### 🎵 YouTube Music Player

Play audio from YouTube directly in your voice channel via slash commands. Supports search queries and URLs, a multi-track queue, skip/stop controls, and an idle auto-disconnect timer.

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `/play <query or URL>` | Join your voice channel and play a track (or add it to the queue). |
| `/queue`               | Show the current queue and now-playing track.                      |
| `/playing`             | Show only the currently playing track.                             |
| `/skip`                | Skip the current track and play the next one.                      |
| `/stop`                | Stop playback, clear the queue, and leave the voice channel.       |

### 📰 RSS News Feed

Polls any number of RSS feeds on a cron schedule and posts new articles as rich embeds to a dedicated text channel. Deduplication is handled with a persistent JSON store so articles are never reposted across restarts.

- Configurable list of feeds (name + URL) in `config.json`.
- First run seeds the backlog silently so the channel isn't flooded on startup.
- Before each new batch, the bot's previous message is automatically deleted to keep the channel clean.

### 🎮 Steam Daily Deals

Every day at **3:33 AM** the bot fetches the latest Steam discounts from [game-deals.app](https://game-deals.app), filters them by user review quality, and posts a single polished digest embed.

**Pipeline per poll:**

1. **Fetch deals** from the `game-deals.app` RSS feed.
2. **Fetch user reviews** from the Steam appreviews API for every deal in parallel.
3. **Filter** — only keep games rated _Very Positive_ or _Overwhelmingly Positive_ (≥ 80 % positive, ≥ 10 reviews).
4. **Fetch live prices** from the Steam Store API for the top 10 filtered games.
5. **Delete** the previous digest message from the channel.
6. **Post** one embed listing all deals with prices and review scores.

Each deal field looks like:

```
~~41,99€~~ → **8,39€** (-80%)
⭐ **Very Positive** (95%)
📅 Expires **2026-06-25**
[View on Steam →](https://store.steampowered.com/app/...)
```

Additional lines (IGDB/Meta scores, genres, short description) may appear when available.

---

## 🛠️ Tech Stack

|             |                                                  |
| ----------- | ------------------------------------------------ |
| Runtime     | Node.js ≥ 22.12                                  |
| Language    | TypeScript (ESM, no build step — runs via `tsx`) |
| Discord     | discord.js v14, slash commands                   |
| Audio       | @discordjs/voice + FFmpeg + yt-dlp               |
| RSS parsing | rss-parser                                       |
| Scheduling  | croner                                           |
| Pricing     | Steam Store appdetails API                       |
| Reviews     | Steam appreviews API                             |

---

## 🚀 Setup

### Prerequisites

- **Node.js ≥ 22.12**
- **FFmpeg** available on your `PATH` (`ffmpeg -version` should work)
- A Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

### Install

```bash
# 1. Clone and install dependencies (also downloads the yt-dlp binary)
git clone https://github.com/your-username/dzbanek-bot.git
cd dzbanek-bot
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and set:  DISCORD_TOKEN=your_token_here

# 3. Review config (channel IDs, feed URLs, cron schedule, etc.)
#    src/config/config.json

# 4. Register slash commands with Discord
npm run deploy

# 5. Start the bot
npm run dev       # development — auto-reloads on file changes
npm start         # production
```

### Bot permissions

The bot needs the following OAuth2 scopes: `bot`, `applications.commands`

| Feature     | Required permissions                                      |
| ----------- | --------------------------------------------------------- |
| Music       | Connect, Speak (voice channel)                            |
| News        | View Channel, Send Messages, Embed Links, Manage Messages |
| Steam Deals | View Channel, Send Messages, Embed Links, Manage Messages |

> **Manage Messages** is needed to delete the bot's own previous embed before posting a new one.

---

## ⚙️ Configuration

All non-secret settings live in `src/config/config.json`. The only secret is `DISCORD_TOKEN` in `.env`.

```jsonc
{
  "discord": {
    "clientId": "...", // your bot's application ID
    "guildId": "...", // guild for instant command registration; null = global (~1 h)
  },
  "news": {
    "channelId": "...", // text channel for news articles
    "cron": "*/15 * * * *", // how often to poll feeds
    "feeds": [
      { "name": "Reuters", "url": "https://..." },
      { "name": "Ars Technica", "url": "https://..." },
    ],
    "maxSeenIds": 5000, // cap on stored article IDs per feed
    "postOnFirstRun": false, // true = post existing backlog on first start
  },
  "music": {
    "idleTimeoutSec": 120, // disconnect from voice after N seconds of silence
    "maxQueueSize": 100,
  },
  "steam": {
    "channelId": "...", // text channel for the deals digest
    "cron": "33 3 * * *", // every day at 3:33 AM
    "maxSeenIds": 500,
    "postOnFirstRun": true, // post current deals immediately on first start
  },
  "embedColor": "#5865F2",
}
```

### Changing the Steam pricing currency

Open `src/steam/SteamPriceApi.ts` and change the `PRICE_CC` constant:

```ts
const PRICE_CC = 'de'; // 'de' = EUR | 'us' = USD | 'gb' = GBP | 'pl' = PLN
```

### Changing the review quality threshold

Open `src/steam/SteamReviewApi.ts`:

```ts
const PASSING_SCORE = 8; // 8 = Very Positive, 9 = Overwhelmingly Positive
const MIN_POSITIVE_PCT = 80; // fallback: accept if >= 80 % positive
const MIN_REVIEWS = 10; // require at least this many reviews
```

---

## 🌐 Website API

When the bot starts it also serves a small HTTP API (Node built-in `http`, no extra deps) used by the marketing / admin site.

| Variable                | Default                                   | Purpose                                                            |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `API_ENABLED`           | `true`                                    | Set `false` to disable the API without removing other vars         |
| `API_HOST`              | `0.0.0.0`                                 | Bind address                                                       |
| `API_PORT`              | `3848`                                    | Listen port (stats + admin for the marketing site)                 |
| `EXPRESS_STATS_ENABLED` | `false` (opt-in `true`)                   | Optional second Express stats listener                             |
| `EXPRESS_STATS_HOST`    | `0.0.0.0`                                 | Bind address for the Express stats sidecar                         |
| `EXPRESS_STATS_PORT`    | `3849`                                    | Port when Express sidecar is enabled (must not equal `API_PORT`)   |
| `WEBSITE_ORIGIN`        | localhost origins                         | Comma-separated CORS origins (shared by main API + Express stats)  |
| `DISCORD_CLIENT_SECRET` | —                                         | OAuth2 client secret (Developer Portal → OAuth2)                   |
| `SESSION_SECRET`        | placeholder                               | HMAC key for the `dzbanek_session` cookie                          |
| `OAUTH_REDIRECT_URI`    | `http://127.0.0.1:3848/api/auth/callback` | Must match a Discord OAuth2 redirect URL                           |

OAuth `client_id` comes from `config.json` → `discord.clientId`. Scopes: `identify guilds`.

### Public routes (main API, port 3848)

| Method | Path          | Description                                                                          |
| ------ | ------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/api/health` | `{ ok, uptimeSec, ready }`                                                           |
| `GET`  | `/api/stats`  | Live aggregates + last 90 daily snapshots (`servers`, `approxUsers`, `uptimeSec`, …) |

Example:

```bash
curl -s http://127.0.0.1:3848/api/stats
# { "servers": 12, "approxUsers": 3456, "uptimeSec": 86400, ... }
```

### Optional Express stats sidecar

Opt in with `EXPRESS_STATS_ENABLED=true` on a free port (default `3849`). The main API already serves stats on **3848**.

### Auth / admin routes

| Method  | Path                             | Description                                                                |
| ------- | -------------------------------- | -------------------------------------------------------------------------- |
| `GET`   | `/api/auth/login`                | Redirect to Discord OAuth                                                  |
| `GET`   | `/api/auth/callback`             | Exchange code, set session cookie, redirect to site `/admin.html`          |
| `GET`   | `/api/auth/me`                   | Current session user (401 if missing)                                      |
| `POST`  | `/api/auth/logout`               | Clear session cookie                                                       |
| `GET`   | `/api/admin/guilds`              | Guilds where the user has Manage Server / Admin **and** the bot is present |
| `GET`   | `/api/admin/guilds/:id/settings` | Per-guild news / Steam / Epic channel settings                             |
| `PATCH` | `/api/admin/guilds/:id/settings` | Update those settings (JSON body)                                          |
| `GET`   | `/api/admin/guilds/:id/stats`    | Optional per-guild stats summary                                           |

Guild-level toggles (when enabled with a channel ID) cause news / Steam / Epic posts to fan out to **all** configured channels, including the legacy single channel in `config.json` (deduped by channel ID).

Daily snapshots run on `ClientReady` (if missing for today) and on cron `5 0 * * *` (UTC); rows older than 90 days are pruned.

### CORS

Browsers block `fetch()` from a different origin (scheme + host + port) unless the API returns the right `Access-Control-*` headers.

Both the main API and the Express stats sidecar read the same allowlist:

```env
# Exact origins of your website (no trailing slash). Comma-separated.
WEBSITE_ORIGIN=https://your-site.example,http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5500
```

Localhost / `127.0.0.1` any port is also allowed for the main Website API in development. Prefer an explicit list for production.

If the site and API share one domain via reverse proxy (e.g. `https://example.com/api/stats` → `:3848`), same-origin `fetch('/api/stats')` works without CORS; keep `WEBSITE_ORIGIN` set for local dev.

### Frontend snippet (Express stats)

HTML placeholders:

```html
<span id="server-count">—</span>
<span id="user-count">—</span>
<span id="uptime">—</span>
```

```js
const STATS_URL = 'http://YOUR_VPS_IP:3848/api/stats'; // or https://api.example.com/api/stats

function formatUptime(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function loadLiveStats() {
  try {
    const res = await fetch(STATS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const servers = document.getElementById('server-count');
    const users = document.getElementById('user-count');
    const uptime = document.getElementById('uptime');

    if (servers) servers.textContent = String(data.serverCount ?? '—');
    if (users) users.textContent = String(data.userCount ?? '—');
    if (uptime) uptime.textContent = formatUptime(data.uptime);
  } catch (err) {
    console.error('Failed to load bot stats:', err);
  }
}

loadLiveStats();
// Optional: refresh every 60s
// setInterval(loadLiveStats, 60_000);
```

The page’s origin must appear in `WEBSITE_ORIGIN` or the browser will block the request.

---

## 📁 Project Structure

```
src/
  index.ts                Composition root — wires everything together.
  deploy-commands.ts      One-shot slash command registration.
  api/server.ts           Website HTTP API (stats, OAuth, admin guild settings).
  api/express-stats.ts    Express sidecar: simple public stats for the marketing site.
  config/                 Typed config loader (config.json + DISCORD_TOKEN env).
  core/
    types.ts              Shared interfaces (Command, Track, FeedItem, SteamDealItem, …).
    client.ts             Discord client factory.
    embeds.ts             EmbedBuilder factories for all message types.
    logger.ts             Leveled logger singleton.
  db/repositories/        Prisma repositories (stats, snapshots, guild settings, …).
  commands/music/         One file per slash command.
  events/                 ready + interactionCreate handlers.
  music/                  Voice connection, audio player, queue, yt-dlp source.
  news/                   FeedReader, SeenStore, NewsService.
  steam/
    SteamFeedReader.ts    Parses the game-deals.app RSS feed.
    SteamPriceApi.ts      Fetches live prices from the Steam Store API.
    SteamReviewApi.ts     Fetches and filters by user review score.
    SteamDealService.ts   Orchestrates the full deals pipeline.
  epic/                   Epic free games poller.
data/                     Runtime state (seen.json) — git-ignored.
prisma/                   SQLite schema + bot.db
```

---

## 📜 Scripts

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Run with auto-reload (`tsx watch`).   |
| `npm start`         | Run the bot.                          |
| `npm run deploy`    | Register slash commands with Discord. |
| `npm run typecheck` | Type-check with `tsc --noEmit`.       |
| `npm run lint`      | Lint with ESLint.                     |
| `npm run format`    | Format with Prettier.                 |

---

## 🔧 Troubleshooting

| Problem                                  | Fix                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Song won't play / "Could not load track" | Update yt-dlp: delete `node_modules/youtube-dl-exec` and reinstall.                                                     |
| No audio                                 | Check `ffmpeg -version` works and the bot has Connect + Speak permissions.                                              |
| Slash commands missing                   | Run `npm run deploy`. Guild commands appear instantly; global takes ~1 h.                                               |
| News not posting                         | Check `postOnFirstRun` and confirm the bot has access to the `channelId`.                                               |
| Steam deals not posting                  | Confirm the channel ID, bot permissions, and that `postOnFirstRun: true` is set.                                        |
| All Steam deals skipped                  | Every deal in the current feed may have Mixed/Negative reviews. Lower `PASSING_SCORE` in `SteamReviewApi.ts` if needed. |
| Can't delete previous message            | Grant the bot **Manage Messages** permission in the deals/news channel.                                                 |

---

## 🔒 Security

The bot token grants full control of the bot account. Keep it **only** in `.env` (which is git-ignored) and never commit it. If a token is ever exposed, immediately reset it in the [Discord Developer Portal](https://discord.com/developers/applications).
