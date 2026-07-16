# Always-on Discord bot + public Website API (stats + OAuth admin).
# Deploy: railway up / fly deploy
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Deno is required for yt-dlp YouTube JS challenge solving (EJS).
# Without it, yt-dlp often only sees storyboard images → "Requested format is not available".
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh \
  && deno --version

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install all deps (tsx + prisma CLI needed at runtime for this repo layout)
RUN npm ci \
  && npx prisma generate

# Ensure yt-dlp binary exists; upgrade to nightly (better YouTube support).
RUN YTDLP_BIN="$(find node_modules/youtube-dl-exec -type f \( -name yt-dlp -o -name yt-dlp.exe \) 2>/dev/null | head -n1)" \
  && if [ -n "$YTDLP_BIN" ]; then \
       chmod +x "$YTDLP_BIN" \
       && "$YTDLP_BIN" --update-to nightly || "$YTDLP_BIN" -U || true \
       && "$YTDLP_BIN" --version; \
     else echo "WARN: yt-dlp binary missing after npm ci"; fi \
  && ffmpeg -version | head -n1 \
  && deno --version

COPY tsconfig.json ./
COPY src ./src/
COPY src/config/config.json ./src/config/config.json

# Marketing site + admin UI (served on the same origin as the API)
COPY public-site ./public-site/

# Runtime data dirs (SQLite: prisma/data/bot.db — volume mounts here on Railway/Fly)
RUN mkdir -p prisma/data data

ENV NODE_ENV=production \
    API_ENABLED=true \
    API_HOST=0.0.0.0 \
    API_PORT=8080 \
    WEBSITE_STATIC_DIR=/app/public-site \
    YTDLP_JS_RUNTIME=deno

EXPOSE 8080

# Refresh yt-dlp nightly on boot; migrate DB; start bot.
CMD ["sh", "-c", "mkdir -p /app/prisma/data /app/data && chmod -R u+rwX /app/prisma/data /app/data; if [ -n \"$PORT\" ]; then export API_PORT=\"$PORT\"; fi; YTDLP_BIN=$(find /app/node_modules/youtube-dl-exec -type f \\( -name yt-dlp -o -name yt-dlp.exe \\) 2>/dev/null | head -n1); if [ -n \"$YTDLP_BIN\" ]; then chmod +x \"$YTDLP_BIN\"; \"$YTDLP_BIN\" --update-to nightly || \"$YTDLP_BIN\" -U || true; fi; npx prisma db push --skip-generate && exec npx tsx src/index.ts"]
