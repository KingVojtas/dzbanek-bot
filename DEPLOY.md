# Production (Railway)

- **Admin (use this):** https://bot-production-c393.up.railway.app/admin.html
- **API health:** https://bot-production-c393.up.railway.app/api/health
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
