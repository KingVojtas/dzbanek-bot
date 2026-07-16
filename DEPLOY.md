# Production (Railway)

- **Admin (use this):** https://bot-production-c393.up.railway.app/admin.html
- **API health:** https://bot-production-c393.up.railway.app/api/health

## YouTube music on Railway (required)

Cloud IPs are often blocked with:

`Sign in to confirm you're not a bot`

**Fix: pass YouTube cookies to yt-dlp**

1. In a desktop browser where you are logged into YouTube, install **Get cookies.txt LOCALLY** (or similar).
2. Open youtube.com → export **cookies.txt** (Netscape format).
3. Base64-encode the file (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\Downloads\cookies.txt"))
```

4. Set on Railway (value is secret — do not commit):

```powershell
railway variables set YTDLP_COOKIES_BASE64="PASTE_BASE64_HERE" --service bot
railway up -y --service bot
```

5. Logs should show `yt-dlp cookies: wrote ...` on startup. Then try `/play` again.

Cookies expire periodically; re-export when music starts failing with the bot-check error again.
- **Marketing site:** https://kingvojtas.github.io/dzbanek-bot-website/

## Discord OAuth redirect (required for login)

Developer Portal → OAuth2 → Redirects → add **exactly**:

```
https://bot-production-c393.up.railway.app/api/auth/callback
```

Without this, Discord login fails after authorize.

## Redeploy

```powershell
npx @railway/cli up -y --service bot
```

Do **not** run a second bot with the same token locally (Discord will kick one offline).
