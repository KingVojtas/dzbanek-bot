# Production (Railway)

- **Admin (use this):** https://dzbanek-bot.up.railway.app/admin.html
- **API health:** https://dzbanek-bot.up.railway.app/api/health

## YouTube music on Railway (free home bridge)

**Preferred free setup** (no paid proxy): run the worker on your PC and expose it with Cloudflare.

```powershell
# On your home PC (leave running / install at logon):
npm run music-bridge
# or permanent:
npm run music-bridge:install
```

The bridge starts the worker + a **quick tunnel** and updates Railway `MUSIC_WORKER_URL` / `MUSIC_WORKER_SECRET` when the URL changes.

### Named tunnel (stable URL — recommended)

Quick tunnels (`*.trycloudflare.com`) get a **new hostname** when the bridge restarts. For a fixed URL:

1. Create a [Cloudflare named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (Zero Trust → Tunnels).
2. Route `https://music.yourdomain.com` → `http://127.0.0.1:8790`.
3. On Railway set once:

```
MUSIC_WORKER_URL=https://music.yourdomain.com
MUSIC_WORKER_SECRET=same-secret-as-home-worker
```

4. Run only the worker at home (`npm run music-worker`) behind `cloudflared` for that tunnel — no need for the ephemeral quick-tunnel bridge.

Admin UI shows a **Bridge online/offline** badge from `GET /api/health` → `musicWorker`.

### Other YouTube protections

Two separate YouTube protections can break playback:

### 1. JS challenge (“Requested format is not available” / only storyboards)

Docker image installs **Deno** and the bot runs yt-dlp with:

- `--js-runtimes deno`
- `--remote-components ejs:github`
- yt-dlp **nightly** (updated on each boot)

Redeploy after pulling latest `Dockerfile` if you see format errors.

### 2. Bot check (“Sign in to confirm you're not a bot”)

Railway (and other cloud) IPs are often blocked. Prefer **both**:

1. **Residential proxy (main fix)** — set `YTDLP_PROXY` to a plain URL, **not** a Markdown link:

   ```
   http://user:pass@host:port
   ```

   or `socks5://user:pass@host:port`. Do **not** paste `[http://…](http://…)` — that makes the proxy invalid and YouTube stays blocked.

2. **Fresh cookies (helps with proxy)** — export Netscape `cookies.txt` while logged into YouTube, base64 it (Railway env max **32768** chars), set `YTDLP_COOKIES_BASE64`.

```powershell
# Proxy (plain URL only):
railway variable set YTDLP_PROXY --service bot --stdin
# paste: http://user:pass@host:port   then Ctrl+Z / EOF

# Cookies:
Get-Clipboard | railway variable set YTDLP_COOKIES_BASE64 --stdin --service bot
railway up -y --service bot
```

On boot, logs should show:

- `YouTube proxy: http://***@host:port` (not “not set”)
- `yt-dlp cookies: wrote ...` when cookies load
- `YouTube probe OK (...)` when extraction works
- **Marketing site:** https://kingvojtas.github.io/dzbanek-bot-website/

## Discord OAuth redirect (required for login)

Railway env must match the **live** public domain (not an old `bot-production-*.up.railway.app` URL):

```
PUBLIC_BASE_URL=https://dzbanek-bot.up.railway.app
OAUTH_REDIRECT_URI=https://dzbanek-bot.up.railway.app/api/auth/callback
WEBSITE_PRIMARY_ORIGIN=https://dzbanek-bot.vojtas.io
WEBSITE_ORIGIN=https://dzbanek-bot.vojtas.io,https://kingvojtas.github.io,https://dzbanek-bot.up.railway.app,http://127.0.0.1:3848,http://localhost:3848
```

Developer Portal → OAuth2 → Redirects → add **exactly**:

```
https://dzbanek-bot.up.railway.app/api/auth/callback
```

Without this (or if `OAUTH_REDIRECT_URI` still points at a deleted Railway hostname), Discord login lands on Railway’s “Not Found / train has not arrived” page.

Post-login return supports `admin.html` and `check.html` via `?return=` on `/api/auth/login`.

## Redeploy

```powershell
npx @railway/cli up -y --service bot
```

Do **not** run a second bot with the same token locally (Discord will kick one offline).
