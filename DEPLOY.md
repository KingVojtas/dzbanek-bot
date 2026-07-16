# Deploy dzbanek-bot (always-on admin + Discord)

GitHub Pages cannot run the bot. For admin/stats without `npm start` on your PC, host this app on **Fly.io**.

## One-time setup

1. **Billing** (required by Fly even on free allowance)  
   Add a card or buy credit:  
   https://fly.io/dashboard/vojtadra150-gmail-com/billing

2. **Discord OAuth redirect**  
   Developer Portal → your app → OAuth2 → Redirects → add **exactly**:
   ```
   https://dzbanek-bot.fly.dev/api/auth/callback
   ```

3. **CLI** (already installed if you used Grok’s setup)
   ```powershell
   flyctl auth login
   ```

4. **Create app + volume + secrets** (from this repo root)
   ```powershell
   flyctl apps create dzbanek-bot --org personal
   flyctl volumes create bot_data --region ams --size 1 --app dzbanek-bot
   powershell -File scripts/fly-set-secrets.ps1
   flyctl deploy
   ```

5. **Website** — set in `dzbanek-bot website/js/config.js`:
   ```js
   var PRODUCTION_API_BASE = 'https://dzbanek-bot.fly.dev';
   ```
   Commit and push the website repo.

6. **Stop local bot** while Fly is running (same Discord token — only one gateway session).

## Verify

```text
https://dzbanek-bot.fly.dev/api/health
https://kingvojtas.github.io/dzbanek-bot-website/admin.html
```

## Useful commands

```powershell
flyctl status
flyctl logs
flyctl secrets list
flyctl deploy
```
