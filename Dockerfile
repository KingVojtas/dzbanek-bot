# Always-on Discord bot + public Website API (stats + OAuth admin).
# Deploy: fly deploy  (see fly.toml)
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

COPY tsconfig.json ./
COPY src ./src/
COPY src/config/config.json ./src/config/config.json

# Runtime data dirs (SQLite: prisma/data/bot.db — volume mounts here on Railway/Fly)
RUN mkdir -p prisma/data data

ENV NODE_ENV=production \
    API_ENABLED=true \
    API_HOST=0.0.0.0 \
    API_PORT=8080

# Fly uses 8080; Railway injects $PORT (we map API_PORT←PORT in start)
EXPOSE 8080

# Volume mounts may be root-owned; ensure writable then migrate + start.
# Run as root so the bind-mount is usable (common on PaaS volume mounts).
CMD ["sh", "-c", "mkdir -p /app/prisma/data /app/data && chmod -R u+rwX /app/prisma/data /app/data; if [ -n \"$PORT\" ]; then export API_PORT=\"$PORT\"; fi; npx prisma db push --skip-generate && exec npx tsx src/index.ts"]
