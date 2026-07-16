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

# Runtime data dirs (SQLite lives under prisma/data; volume mounted in fly.toml)
RUN mkdir -p prisma/data data \
  && chown -R node:node /app

ENV NODE_ENV=production \
    API_ENABLED=true \
    API_HOST=0.0.0.0 \
    API_PORT=8080

# Drop privileges after build
USER node

EXPOSE 8080

# Ensure schema exists on the volume, then start bot + API
CMD ["sh", "-c", "npx prisma db push --skip-generate && exec npx tsx src/index.ts"]
