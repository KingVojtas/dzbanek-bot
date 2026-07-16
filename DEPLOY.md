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

Cloud IPs sometimes need cookies. Optional but recommended:

1. Export Netscape `cookies.txt` from a logged-in YouTube browser session.
2. Filter/base64 if needed (Railway env max **32768** chars for the base64 value).
3. Set `YTDLP_COOKIES_BASE64` on the bot service and redeploy.

```powershell
# After you have a small-enough base64 string in the clipboard:
Get-Clipboard | railway variable set YTDLP_COOKIES_BASE64 --stdin --service bot
railway up -y --service bot
```

Logs should show `yt-dlp cookies: wrote ...` when cookies are loaded.
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
