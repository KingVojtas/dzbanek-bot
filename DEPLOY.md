# Deploy dzbanek-bot (always-on admin + Discord)

GitHub Pages cannot run the bot. Production host: **Railway** (HTTPS public API).

## Live URLs

| What | URL |
|------|-----|
| Public API | https://bot-production-c393.up.railway.app |
| Health | https://bot-production-c393.up.railway.app/api/health |
| Website admin | https://kingvojtas.github.io/dzbanek-bot-website/admin.html |

Website `js/config.js` sets `PRODUCTION_API_BASE` to the Railway API.

## Required: Discord OAuth redirect

Developer Portal → your app → OAuth2 → Redirects → add **exactly**:

```
https://bot-production-c393.up.railway.app/api/auth/callback
```

(Keep the local `http://127.0.0.1:3848/api/auth/callback` if you still use local admin.)

## Redeploy

```powershell
cd path\to\dzbanek-bot
npx @railway/cli up -y --service bot
```

Secrets (from local `.env`):

```powershell
powershell -File scripts/railway-set-secrets.ps1
# then refresh PUBLIC_BASE_URL / OAUTH_REDIRECT_URI if the domain changes
```

## Notes

- **Stop local `npm start`** while Railway is the primary bot (one Discord token = one gateway).
- SQLite data lives on a Railway volume at `/app/prisma/data`.
- Fly.io files (`Dockerfile`, `fly.toml`) remain as an alternative host; Railway is active.
