import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Client } from 'discord.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Config } from '../config';
import { logger } from '../core/logger';
import {
  GuildSettingsRepository,
  type GuildSettings,
  SnapshotRepository,
  StatsRepository,
} from '../db/repositories';
import { postGuildLog } from '../logging/GuildLog';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiServerOptions {
  client: Client;
  getConfig: () => Config;
}

interface SessionUser {
  id: string;
  username: string;
  avatar: string | null;
  exp: number;
}

interface ApiEnv {
  host: string;
  port: number;
  websiteOrigins: string[];
  /** Origin used after OAuth when no valid return= is provided (API self-host). */
  primaryWebsiteOrigin: string;
  /** Same as primary when serving static site from this process. */
  selfOrigin: string;
  /** Absolute path to marketing site files, or null if not found. */
  staticDir: string | null;
  discordClientSecret: string | undefined;
  sessionSecret: string;
  oauthRedirectUri: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'dzbanek_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
const SNOWFLAKE_RE = /^\d{17,20}$/;
const DISCORD_API = 'https://discord.com/api/v10';

const startedAt = Date.now();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ─── Env helpers ──────────────────────────────────────────────────────────────

function resolveStaticDir(): string | null {
  const fromEnv = process.env.WEBSITE_STATIC_DIR?.trim();
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (existsSync(path.join(abs, 'admin.html'))) return abs;
    logger.warn(`WEBSITE_STATIC_DIR set but admin.html not found in ${abs}`);
  }

  // Sibling folder next to the bot repo (common local layout)
  const candidates = [
    path.resolve(process.cwd(), '..', 'dzbanek-bot website'),
    path.resolve(process.cwd(), '..', 'dzbanek-bot-website'),
    path.resolve(process.cwd(), 'website'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'admin.html'))) return dir;
  }
  return null;
}

function loadApiEnv(): ApiEnv {
  const host = process.env.API_HOST?.trim() || '0.0.0.0';
  // Default 3848 — stats + admin + (optional) static site
  const port = Number.parseInt(process.env.API_PORT ?? '3848', 10) || 3848;
  const selfOrigin = `http://127.0.0.1:${port}`;
  const staticDir = resolveStaticDir();

  // Prefer API self-origin first so OAuth never returns to a dead Live Server port
  const rawOrigins =
    process.env.WEBSITE_ORIGIN ??
    [
      selfOrigin,
      `http://localhost:${port}`,
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'null',
    ].join(',');
  const websiteOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Always land on the API-hosted site when we serve static files (Live Server often off)
  const primaryWebsiteOrigin =
    process.env.WEBSITE_PRIMARY_ORIGIN?.trim() ||
    (staticDir ? selfOrigin : null) ||
    websiteOrigins.find((o) => o !== 'null' && /^https?:\/\//i.test(o)) ||
    selfOrigin;

  return {
    host,
    port,
    websiteOrigins,
    primaryWebsiteOrigin,
    selfOrigin,
    staticDir,
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || undefined,
    sessionSecret: process.env.SESSION_SECRET?.trim() || 'change-me-to-long-random',
    oauthRedirectUri:
      process.env.OAUTH_REDIRECT_URI?.trim() ||
      `http://127.0.0.1:${port}/api/auth/callback`,
  };
}

// ─── Session (HMAC-signed cookie) ─────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeSession(user: SessionUser, secret: string): string {
  const payload = b64url(
    JSON.stringify({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      exp: user.exp,
    }),
  );
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

function decodeSession(token: string | undefined, secret: string): SessionUser | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expected = signPayload(payload, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionUser;
    if (!data?.id || typeof data.exp !== 'number') return null;
    if (data.exp * 1000 < Date.now()) return null;
    return {
      id: String(data.id),
      username: String(data.username ?? ''),
      avatar: data.avatar ?? null,
      exp: data.exp,
    };
  } catch {
    return null;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

/**
 * Session from cookie (same-origin / proxy) or Authorization Bearer
 * (cross-origin admin UI on another port — cookies often blocked).
 */
function sessionFromRequest(req: IncomingMessage, secret: string): SessionUser | null {
  const cookies = parseCookies(req);
  const fromCookie = decodeSession(cookies[COOKIE_NAME], secret);
  if (fromCookie) return fromCookie;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    return decodeSession(token, secret);
  }
  return null;
}

function sessionCookieHeader(value: string, maxAgeSec: number): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  // Secure only when OAuth redirect is https (production)
  if (process.env.OAUTH_REDIRECT_URI?.startsWith('https://')) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage, limit = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRedirect(res: ServerResponse, location: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function isLocalDevOrigin(origin: string): boolean {
  // Static site ports vary (Live Server, serve, Vite, etc.)
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
  credentials: boolean,
): void {
  const origin = req.headers.origin;
  // Browser sends Origin: null as the string "null" for some local file cases
  const allowed =
    !!origin &&
    (origins.includes(origin) ||
      origins.includes('*') ||
      (origin === 'null' && origins.includes('null')) ||
      isLocalDevOrigin(origin));

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Vary', 'Origin');
  } else if (!origin && origins.includes('null')) {
    // non-browser / same-origin — nothing to set
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Cookie',
  );
}

function normalizeChannelId(value: unknown): string | null | undefined {
  // undefined = field not provided; null = clear
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('Invalid channel ID (expected Discord snowflake)');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!SNOWFLAKE_RE.test(trimmed)) {
    throw new Error('Invalid channel ID (expected Discord snowflake)');
  }
  return trimmed;
}

// ─── Snapshot helper (exported for index.ts) ──────────────────────────────────

export async function takeDailySnapshot(client: Client): Promise<void> {
  const snapshots = new SnapshotRepository();
  const stats = new StatsRepository();
  const date = SnapshotRepository.todayUtc();

  if (await snapshots.hasSnapshot(date)) {
    logger.debug(`Daily snapshot for ${date} already exists.`);
    return;
  }

  let approxUsers = 0;
  for (const guild of client.guilds.cache.values()) {
    approxUsers += guild.memberCount ?? 0;
  }

  const agg = await stats.getGlobalAggregate();
  await snapshots.createSnapshot({
    date,
    servers: client.guilds.cache.size,
    approxUsers,
    totalPlays: agg.totalPlays,
    uniqueUsersTracked: agg.uniqueUsersTracked,
  });

  const pruned = await snapshots.pruneOlderThan(90);
  logger.info(
    `Daily snapshot saved for ${date} (servers=${client.guilds.cache.size}, approxUsers=${approxUsers}` +
      (pruned > 0 ? `, pruned ${pruned} old row(s)` : '') +
      ').',
  );
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startApiServer(options: ApiServerOptions): Server {
  const { client, getConfig } = options;
  const env = loadApiEnv();
  const statsRepo = new StatsRepository();
  const snapshotRepo = new SnapshotRepository();
  const guildSettingsRepo = new GuildSettingsRepository();

  if (env.sessionSecret === 'change-me-to-long-random') {
    logger.warn(
      'API: SESSION_SECRET is using the default value. Set a long random secret in production.',
    );
  }

  if (env.staticDir) {
    logger.info(`Serving marketing site from ${env.staticDir} → ${env.selfOrigin}/`);
  } else {
    logger.warn(
      'No website static folder found (expected sibling "dzbanek-bot website"). ' +
        'OAuth will still work but you must run Live Server / npx serve yourself. ' +
        'Set WEBSITE_STATIC_DIR to the site folder to embed it on this port.',
    );
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger.error('API request error:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const host = req.headers.host ?? `localhost:${env.port}`;
    const url = new URL(req.url ?? '/', `http://${host}`);
    const reqPath = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      applyCors(req, res, env.websiteOrigins, true);
      res.writeHead(204);
      res.end();
      return;
    }

    const isAdmin = reqPath.startsWith('/api/admin') || reqPath.startsWith('/api/auth');
    applyCors(req, res, env.websiteOrigins, isAdmin || reqPath === '/api/stats');

    // ── Health ────────────────────────────────────────────────────────────
    if (method === 'GET' && reqPath === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        ready: client.isReady(),
      });
      return;
    }

    // ── Public stats ──────────────────────────────────────────────────────
    if (method === 'GET' && reqPath === '/api/stats') {
      let approxUsers = 0;
      for (const guild of client.guilds.cache.values()) {
        approxUsers += guild.memberCount ?? 0;
      }
      const totals = await statsRepo.getGlobalAggregate();
      const history = await snapshotRepo.getHistory(90);

      sendJson(res, 200, {
        servers: client.guilds.cache.size,
        approxUsers,
        totalPlays: totals.totalPlays,
        totalSkips: totals.totalSkips,
        totalWishlistAdds: totals.totalWishlistAdds,
        uniqueUsersTracked: totals.uniqueUsersTracked,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        generatedAt: new Date().toISOString(),
        history,
      });
      return;
    }

    // ── Auth: login ───────────────────────────────────────────────────────
    if (method === 'GET' && reqPath === '/api/auth/login') {
      const config = getConfig();
      if (!env.discordClientSecret) {
        sendJson(res, 503, {
          error: 'OAuth is not configured (DISCORD_CLIENT_SECRET missing).',
        });
        return;
      }

      // Prefer API self-origin when we host the site — Live Server is often not running.
      const returnOrigin = env.staticDir
        ? env.selfOrigin
        : resolveReturnOrigin(
            url.searchParams.get('return') ?? req.headers.referer ?? null,
            env,
          );
      const state = b64url(JSON.stringify({ r: returnOrigin, t: Date.now() }));

      const params = new URLSearchParams({
        client_id: config.discord.clientId,
        response_type: 'code',
        scope: 'identify guilds',
        redirect_uri: env.oauthRedirectUri,
        prompt: 'consent',
        state,
      });
      sendRedirect(res, `https://discord.com/api/oauth2/authorize?${params}`);
      return;
    }

    // ── Auth: callback ────────────────────────────────────────────────────
    if (method === 'GET' && reqPath === '/api/auth/callback') {
      const code = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      // Always prefer self-hosted admin when static files are available (avoids :5500 refused)
      const returnOrigin = env.staticDir
        ? env.selfOrigin
        : resolveReturnOriginFromState(url.searchParams.get('state'), env);

      if (oauthError || !code) {
        sendRedirect(
          res,
          `${returnOrigin}/admin.html?error=${encodeURIComponent(oauthError ?? 'missing_code')}`,
        );
        return;
      }

      if (!env.discordClientSecret) {
        sendJson(res, 503, { error: 'OAuth is not configured.' });
        return;
      }

      const config = getConfig();
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: env.discordClientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: env.oauthRedirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text().catch(() => '');
        logger.warn(
          `API OAuth token exchange failed: HTTP ${tokenRes.status} body=${errText.slice(0, 300)} ` +
            `(client_id=${config.discord.clientId}, redirect_uri=${env.oauthRedirectUri}, secret_len=${env.discordClientSecret.length})`,
        );
        sendRedirect(res, `${returnOrigin}/admin.html?error=token_exchange`);
        return;
      }

      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        sendRedirect(res, `${returnOrigin}/admin.html?error=no_token`);
        return;
      }

      const meRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!meRes.ok) {
        sendRedirect(res, `${returnOrigin}/admin.html?error=user_fetch`);
        return;
      }

      const me = (await meRes.json()) as {
        id: string;
        username: string;
        global_name?: string | null;
        avatar: string | null;
      };

      const session: SessionUser = {
        id: me.id,
        username: me.global_name || me.username,
        avatar: me.avatar,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
      };

      const token = encodeSession(session, env.sessionSecret);
      // Handoff token in query for cross-origin admin (cookie alone often fails :5500→:3848).
      const redirectUrl = `${returnOrigin}/admin.html?session=${encodeURIComponent(token)}`;
      sendRedirect(res, redirectUrl, {
        'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_SEC),
      });
      return;
    }

    // ── Auth: me ──────────────────────────────────────────────────────────
    if (method === 'GET' && reqPath === '/api/auth/me') {
      const user = sessionFromRequest(req, env.sessionSecret);
      if (!user) {
        sendJson(res, 401, { error: 'Not authenticated' });
        return;
      }
      sendJson(res, 200, {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        exp: user.exp,
      });
      return;
    }

    // ── Auth: logout ──────────────────────────────────────────────────────
    if (method === 'POST' && reqPath === '/api/auth/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader() });
      return;
    }

    // ── Admin routes require session ──────────────────────────────────────
    if (reqPath.startsWith('/api/admin')) {
      const user = sessionFromRequest(req, env.sessionSecret);
      if (!user) {
        sendJson(res, 401, { error: 'Not authenticated' });
        return;
      }

      // GET /api/admin/guilds
      if (method === 'GET' && reqPath === '/api/admin/guilds') {
        const guilds: Array<{
          id: string;
          name: string;
          icon: string | null;
          memberCount: number;
        }> = [];

        for (const guild of client.guilds.cache.values()) {
          try {
            const member = await guild.members.fetch(user.id);
            const perms = member.permissions;
            if (
              perms.has(PermissionFlagsBits.Administrator) ||
              perms.has(PermissionFlagsBits.ManageGuild)
            ) {
              guilds.push({
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                memberCount: guild.memberCount ?? 0,
              });
            }
          } catch {
            // User is not in this guild (or member fetch failed)
          }
        }

        guilds.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, { guilds });
        return;
      }

      // /api/admin/guilds/:id/channels
      const channelsMatch = reqPath.match(/^\/api\/admin\/guilds\/(\d{17,20})\/channels$/);
      if (channelsMatch && method === 'GET') {
        const guildId = channelsMatch[1]!;
        const allowed = await userCanManageGuild(client, user.id, guildId);
        if (!allowed) {
          sendJson(res, 403, { error: 'Forbidden: missing Manage Guild permission or bot not in guild' });
          return;
        }
        // Optional ?include=id1,id2 — always resolve saved channel IDs to real names
        const includeRaw = url.searchParams.get('include') || '';
        const includeIds = includeRaw
          .split(',')
          .map((s) => s.trim())
          .filter((id) => SNOWFLAKE_RE.test(id));
        const channels = await listGuildTextChannels(client, guildId, includeIds);
        sendJson(res, 200, { channels });
        return;
      }

      // /api/admin/guilds/:id/settings/reset | stats/reset
      const resetMatch = reqPath.match(/^\/api\/admin\/guilds\/(\d{17,20})\/(settings|stats)\/reset$/);
      if (resetMatch && method === 'POST') {
        const guildId = resetMatch[1]!;
        const kind = resetMatch[2]!;
        const allowed = await userCanManageGuild(client, user.id, guildId);
        if (!allowed) {
          sendJson(res, 403, { error: 'Forbidden: missing Manage Guild permission or bot not in guild' });
          return;
        }
        if (kind === 'settings') {
          const saved = await guildSettingsRepo.reset(guildId, user.id);
          void postGuildLog(
            client,
            guildId,
            'config',
            'Config reset',
            'Feed settings were reset to defaults via the web admin.',
            user.username,
          );
          sendJson(res, 200, settingsToJson(saved));
          return;
        }
        await statsRepo.resetGuild(guildId);
        void postGuildLog(
          client,
          guildId,
          'config',
          'Stats reset',
          'Per-server music/stats counters were cleared via the web admin.',
          user.username,
        );
        sendJson(res, 200, { ok: true, guildId });
        return;
      }

      // /api/admin/guilds/:id/settings | stats
      const guildMatch = reqPath.match(/^\/api\/admin\/guilds\/(\d{17,20})\/(settings|stats)$/);
      if (guildMatch) {
        const guildId = guildMatch[1]!;
        const action = guildMatch[2]!;

        const allowed = await userCanManageGuild(client, user.id, guildId);
        if (!allowed) {
          sendJson(res, 403, { error: 'Forbidden: missing Manage Guild permission or bot not in guild' });
          return;
        }

        if (action === 'settings' && method === 'GET') {
          const settings = await guildSettingsRepo.getOrDefault(guildId);
          const json = settingsToJson(settings);
          // Always attach resolved Discord names for saved channel IDs (fixes “Unknown channel”)
          const names = await resolveChannelNames(client, [
            settings.newsChannelId,
            settings.steamChannelId,
            settings.epicChannelId,
            settings.logChannelId,
            settings.welcomeChannelId,
            settings.goodbyeChannelId,
          ]);
          sendJson(res, 200, {
            ...json,
            newsChannelName: names.get(settings.newsChannelId ?? '') ?? null,
            steamChannelName: names.get(settings.steamChannelId ?? '') ?? null,
            epicChannelName: names.get(settings.epicChannelId ?? '') ?? null,
            logChannelName: names.get(settings.logChannelId ?? '') ?? null,
            welcomeChannelName: names.get(settings.welcomeChannelId ?? '') ?? null,
            goodbyeChannelName: names.get(settings.goodbyeChannelId ?? '') ?? null,
          });
          return;
        }

        if (action === 'settings' && method === 'PATCH') {
          let body: Record<string, unknown>;
          try {
            const raw = await readBody(req);
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }

          try {
            const update: {
              newsEnabled?: boolean;
              newsChannelId?: string | null;
              steamEnabled?: boolean;
              steamChannelId?: string | null;
              epicEnabled?: boolean;
              epicChannelId?: string | null;
              musicEnabled?: boolean;
              logChannelId?: string | null;
              welcomeEnabled?: boolean;
              welcomeChannelId?: string | null;
              welcomeMessage?: string | null;
              goodbyeEnabled?: boolean;
              goodbyeChannelId?: string | null;
              goodbyeMessage?: string | null;
              steamMinDiscount?: number | null;
              steamMinReviewScore?: number | null;
              newsKeywords?: string | null;
              steamPostHourUtc?: number | null;
              epicPostHourUtc?: number | null;
              newsPostHourUtc?: number | null;
            } = {};

            if (typeof body.newsEnabled === 'boolean') update.newsEnabled = body.newsEnabled;
            if (typeof body.steamEnabled === 'boolean') update.steamEnabled = body.steamEnabled;
            if (typeof body.epicEnabled === 'boolean') update.epicEnabled = body.epicEnabled;
            if (typeof body.musicEnabled === 'boolean') update.musicEnabled = body.musicEnabled;
            if (typeof body.welcomeEnabled === 'boolean') update.welcomeEnabled = body.welcomeEnabled;
            if (typeof body.goodbyeEnabled === 'boolean') update.goodbyeEnabled = body.goodbyeEnabled;

            if ('newsChannelId' in body) update.newsChannelId = normalizeChannelId(body.newsChannelId) ?? null;
            if ('steamChannelId' in body) update.steamChannelId = normalizeChannelId(body.steamChannelId) ?? null;
            if ('epicChannelId' in body) update.epicChannelId = normalizeChannelId(body.epicChannelId) ?? null;
            if ('logChannelId' in body) update.logChannelId = normalizeChannelId(body.logChannelId) ?? null;
            if ('welcomeChannelId' in body) {
              update.welcomeChannelId = normalizeChannelId(body.welcomeChannelId) ?? null;
            }
            if ('goodbyeChannelId' in body) {
              update.goodbyeChannelId = normalizeChannelId(body.goodbyeChannelId) ?? null;
            }
            if ('welcomeMessage' in body) {
              update.welcomeMessage = normalizeGreetingMessage(body.welcomeMessage);
            }
            if ('goodbyeMessage' in body) {
              update.goodbyeMessage = normalizeGreetingMessage(body.goodbyeMessage);
            }

            if ('steamMinDiscount' in body) {
              update.steamMinDiscount = normalizeOptionalInt(
                body.steamMinDiscount,
                0,
                100,
                'steamMinDiscount',
              );
            }
            if ('steamMinReviewScore' in body) {
              update.steamMinReviewScore = normalizeOptionalInt(
                body.steamMinReviewScore,
                0,
                9,
                'steamMinReviewScore',
              );
            }
            if ('newsKeywords' in body) {
              update.newsKeywords = normalizeKeywords(body.newsKeywords);
            }
            if ('steamPostHourUtc' in body) {
              update.steamPostHourUtc = normalizeOptionalInt(
                body.steamPostHourUtc,
                0,
                23,
                'steamPostHourUtc',
              );
            }
            if ('epicPostHourUtc' in body) {
              update.epicPostHourUtc = normalizeOptionalInt(
                body.epicPostHourUtc,
                0,
                23,
                'epicPostHourUtc',
              );
            }
            if ('newsPostHourUtc' in body) {
              update.newsPostHourUtc = normalizeOptionalInt(
                body.newsPostHourUtc,
                0,
                23,
                'newsPostHourUtc',
              );
            }

            const saved = await guildSettingsRepo.upsert(guildId, update, user.id);
            const summary = [
              `Music: ${saved.musicEnabled ? 'on' : 'off'}`,
              `News: ${saved.newsEnabled ? 'on' : 'off'} ${saved.newsChannelId ? `<#${saved.newsChannelId}>` : ''}`,
              `Steam: ${saved.steamEnabled ? 'on' : 'off'} ${saved.steamChannelId ? `<#${saved.steamChannelId}>` : ''}`,
              `Epic: ${saved.epicEnabled ? 'on' : 'off'} ${saved.epicChannelId ? `<#${saved.epicChannelId}>` : ''}`,
              `Log channel: ${saved.logChannelId ? `<#${saved.logChannelId}>` : 'none'}`,
            ].join('\n');
            void postGuildLog(
              client,
              guildId,
              'config',
              'Settings updated',
              summary,
              user.username,
            );
            sendJson(res, 200, settingsToJson(saved));
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : 'Invalid settings',
            });
          }
          return;
        }

        if (action === 'stats' && method === 'GET') {
          const guildStats = await statsRepo.getGuild(guildId);
          if (!guildStats) {
            sendJson(res, 200, {
              guildId,
              totalPlays: 0,
              totalDurationSec: 0,
              totalSkips: 0,
              totalWishlistAdds: 0,
              uniqueUsers: 0,
              topTracks: [],
            });
            return;
          }

          const topTracks = Object.entries(guildStats.topTracks)
            .map(([key, t]) => ({ key, title: t.title, plays: t.plays, lastPlayed: t.lastPlayed }))
            .sort((a, b) => b.plays - a.plays)
            .slice(0, 10);

          sendJson(res, 200, {
            guildId,
            totalPlays: guildStats.totalPlays,
            totalDurationSec: guildStats.totalDurationSec,
            totalSkips: guildStats.totalSkips,
            totalWishlistAdds: guildStats.totalWishlistAdds,
            uniqueUsers: Object.keys(guildStats.users).length,
            topTracks,
          });
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // ── Static marketing site (same port as API → OAuth never hits a dead port)
    if ((method === 'GET' || method === 'HEAD') && env.staticDir && !reqPath.startsWith('/api/')) {
      const served = await tryServeStatic(env.staticDir, reqPath, method, res);
      if (served) return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  server.listen(env.port, env.host, () => {
    logger.info(`Website API listening on http://${env.host}:${env.port}`);
    if (env.staticDir) {
      logger.info(`Admin UI: ${env.selfOrigin}/admin.html`);
    }
  });

  server.on('error', (error) => {
    logger.error('Website API server error:', error);
  });

  return server;
}

async function userCanManageGuild(
  client: Client,
  userId: string,
  guildId: string,
): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return false;
  try {
    const member = await guild.members.fetch(userId);
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild)
    );
  } catch {
    return false;
  }
}

function settingsToJson(settings: GuildSettings) {
  return {
    guildId: settings.guildId,
    newsEnabled: settings.newsEnabled,
    newsChannelId: settings.newsChannelId,
    steamEnabled: settings.steamEnabled,
    steamChannelId: settings.steamChannelId,
    epicEnabled: settings.epicEnabled,
    epicChannelId: settings.epicChannelId,
    musicEnabled: settings.musicEnabled ?? true,
    logChannelId: settings.logChannelId ?? null,
    welcomeEnabled: settings.welcomeEnabled ?? false,
    welcomeChannelId: settings.welcomeChannelId ?? null,
    welcomeMessage: settings.welcomeMessage ?? null,
    goodbyeEnabled: settings.goodbyeEnabled ?? false,
    goodbyeChannelId: settings.goodbyeChannelId ?? null,
    goodbyeMessage: settings.goodbyeMessage ?? null,
    steamMinDiscount: settings.steamMinDiscount ?? null,
    steamMinReviewScore: settings.steamMinReviewScore ?? null,
    newsKeywords: settings.newsKeywords ?? null,
    steamPostHourUtc: settings.steamPostHourUtc ?? null,
    epicPostHourUtc: settings.epicPostHourUtc ?? null,
    newsPostHourUtc: settings.newsPostHourUtc ?? null,
    updatedAt: settings.updatedAt.toISOString(),
    updatedByUserId: settings.updatedByUserId,
  };
}

function normalizeOptionalInt(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}, or empty`);
  }
  return n;
}

function normalizeKeywords(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('newsKeywords must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) throw new Error('newsKeywords must be at most 500 characters');
  return trimmed;
}

function normalizeGreetingMessage(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('greeting message must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 1000) throw new Error('greeting message must be at most 1000 characters');
  return trimmed;
}

type ChannelListItem = {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  parentName: string | null;
  botCanSend: boolean;
};

function isSelectableTextChannel(channel: {
  type: number;
  isTextBased?: () => boolean;
}): boolean {
  if (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  ) {
    return true;
  }
  // Fallback for uncommon text-like types (still postable for digests)
  try {
    return typeof channel.isTextBased === 'function' && channel.isTextBased() && 'name' in channel;
  } catch {
    return false;
  }
}

function channelToListItem(
  channel: {
    id: string;
    name: string;
    type: number;
    parentId: string | null;
    parent?: { name: string } | null;
    permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
  },
  me: unknown,
): ChannelListItem {
  let botCanSend = false;
  if (me && typeof channel.permissionsFor === 'function') {
    try {
      const perms = channel.permissionsFor(me);
      botCanSend = Boolean(
        perms?.has(PermissionFlagsBits.ViewChannel) &&
          perms.has(PermissionFlagsBits.SendMessages) &&
          perms.has(PermissionFlagsBits.EmbedLinks),
      );
    } catch {
      botCanSend = false;
    }
  }
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    parentName: channel.parent?.name ?? null,
    botCanSend,
  };
}

async function resolveChannelNames(
  client: Client,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id && SNOWFLAKE_RE.test(id))))];
  await Promise.all(
    unique.map(async (id) => {
      try {
        const ch =
          client.channels.cache.get(id) ?? (await client.channels.fetch(id).catch(() => null));
        if (ch && 'name' in ch && typeof (ch as { name?: unknown }).name === 'string') {
          map.set(id, (ch as { name: string }).name);
        }
      } catch {
        /* skip */
      }
    }),
  );
  return map;
}

async function listGuildTextChannels(
  client: Client,
  guildId: string,
  includeIds: string[] = [],
): Promise<ChannelListItem[]> {
  const guild =
    client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return [];

  try {
    await guild.channels.fetch();
  } catch {
    /* use cache */
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const out: ChannelListItem[] = [];
  const seen = new Set<string>();

  for (const channel of guild.channels.cache.values()) {
    // Skip threads; keep postable guild text channels
    if (typeof channel.isThread === 'function' && channel.isThread()) continue;
    if (!isSelectableTextChannel(channel)) continue;
    if (!('name' in channel) || typeof channel.name !== 'string') continue;

    const item = channelToListItem(
      channel as {
        id: string;
        name: string;
        type: number;
        parentId: string | null;
        parent?: { name: string } | null;
        permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
      },
      me,
    );
    out.push(item);
    seen.add(String(item.id));
  }

  // Resolve saved channel IDs via global client fetch (more reliable than guild cache alone)
  for (const rawId of includeIds) {
    const id = String(rawId);
    if (seen.has(id)) continue;
    try {
      const ch =
        client.channels.cache.get(id) ??
        guild.channels.cache.get(id) ??
        (await client.channels.fetch(id).catch(() => null)) ??
        (await guild.channels.fetch(id).catch(() => null));
      if (!ch || !('name' in ch) || typeof (ch as { name?: unknown }).name !== 'string') continue;
      // Only include if it belongs to this guild (when guildId is available)
      const chGuildId =
        'guildId' in ch
          ? String((ch as { guildId?: string }).guildId ?? '')
          : 'guild' in ch && (ch as { guild?: { id?: string } }).guild
            ? String((ch as { guild: { id: string } }).guild.id)
            : guildId;
      if (chGuildId && chGuildId !== guildId) continue;

      out.push(
        channelToListItem(
          ch as {
            id: string;
            name: string;
            type: number;
            parentId: string | null;
            parent?: { name: string } | null;
            permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
          },
          me,
        ),
      );
      seen.add(id);
    } catch {
      /* leave unresolved */
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Pick a post-login website origin. Prefer an explicit allowlisted return URL,
 * otherwise fall back to primaryWebsiteOrigin.
 */
function resolveReturnOrigin(raw: string | null, env: ApiEnv): string {
  if (!raw) return env.primaryWebsiteOrigin;
  try {
    const asUrl = raw.includes('://') ? new URL(raw) : null;
    const origin = asUrl ? asUrl.origin : raw.replace(/\/$/, '');
    if (!origin || origin === 'null') return env.primaryWebsiteOrigin;

    if (
      env.websiteOrigins.includes(origin) ||
      env.websiteOrigins.includes('*') ||
      isLocalDevOrigin(origin)
    ) {
      return origin;
    }
  } catch {
    /* ignore */
  }
  return env.primaryWebsiteOrigin;
}

function resolveReturnOriginFromState(state: string | null, env: ApiEnv): string {
  if (!state) return env.primaryWebsiteOrigin;
  try {
    const json = Buffer.from(state, 'base64url').toString('utf8');
    const data = JSON.parse(json) as { r?: string };
    return resolveReturnOrigin(data.r ?? null, env);
  } catch {
    return env.primaryWebsiteOrigin;
  }
}

/**
 * Serve a file from the marketing site directory. Returns true if a response was sent.
 */
async function tryServeStatic(
  staticDir: string,
  urlPath: string,
  method: string,
  res: ServerResponse,
): Promise<boolean> {
  let rel = decodeURIComponent(urlPath.split('?')[0] || '/');
  if (rel === '/' || rel === '') rel = '/index.html';
  // Prevent path traversal (Windows-safe)
  const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.resolve(staticDir, normalized.replace(/^[/\\]+/, ''));
  const relative = path.relative(staticDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return true;
  }

  let finalPath = filePath;
  if (!existsSync(finalPath) || statSync(finalPath).isDirectory()) {
    const asHtml = finalPath.endsWith('.html') ? finalPath : `${finalPath}.html`;
    const indexInDir = path.join(finalPath, 'index.html');
    if (existsSync(asHtml) && statSync(asHtml).isFile()) {
      finalPath = asHtml;
    } else if (existsSync(indexInDir) && statSync(indexInDir).isFile()) {
      finalPath = indexInDir;
    } else {
      return false;
    }
  }

  const ext = path.extname(finalPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const st = statSync(finalPath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await pipeline(createReadStream(finalPath), res);
  return true;
}
