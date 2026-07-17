# Production (Railway)

- **Admin (use this):** https://dzbanek-bot.up.railway.app/admin.html
- **API health:** https://dzbanek-bot.up.railway.app/api/health

## YouTube music on Railway

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

Developer Portal → OAuth2 → Redirects → add **exactly**:

```
https://dzbanek-bot.up.railway.app/api/auth/callback
```

Without this, Discord login fails after authorize.

## Redeploy

```powershell
npx @railway/cli up -y --service bot
```

Do **not** run a second bot with the same token locally (Discord will kick one offline).
