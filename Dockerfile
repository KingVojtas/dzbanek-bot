# Always-on Discord bot + public Website API (stats + OAuth admin).
# Deploy: fly deploy  (see fly.toml) or railway up
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install all deps (tsx + prisma CLI needed at runtime for this repo layout)
RUN npm ci \
  && npx prisma generate

# Ensure the platform yt-dlp binary exists and is current (YouTube breaks often).
RUN YTDLP_BIN="$(find node_modules/youtube-dl-exec -type f \( -name yt-dlp -o -name yt-dlp.exe \) 2>/dev/null | head -n1)" \
  && if [ -n "$YTDLP_BIN" ]; then chmod +x "$YTDLP_BIN" && "$YTDLP_BIN" -U || true; "$YTDLP_BIN" --version; else echo "WARN: yt-dlp binary missing after npm ci"; fi \
  && ffmpeg -version | head -n1

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
    WEBSITE_STATIC_DIR=/app/public-site

# Fly uses 8080; Railway injects $PORT (we map API_PORT←PORT in start)
EXPOSE 8080

# Volume mounts may be root-owned; ensure writable then migrate + start.
# Refresh yt-dlp on every boot so extractors stay current without rebuilds.
CMD ["sh", "-c", "mkdir -p /app/prisma/data /app/data && chmod -R u+rwX /app/prisma/data /app/data; if [ -n \"$PORT\" ]; then export API_PORT=\"$PORT\"; fi; YTDLP_BIN=$(find /app/node_modules/youtube-dl-exec -type f \\( -name yt-dlp -o -name yt-dlp.exe \\) 2>/dev/null | head -n1); if [ -n \"$YTDLP_BIN\" ]; then chmod +x \"$YTDLP_BIN\"; \"$YTDLP_BIN\" -U || true; fi; npx prisma db push --skip-generate && exec npx tsx src/index.ts"]
