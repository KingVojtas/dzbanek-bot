import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Client } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import type { Config } from '../config';
import { logger } from '../core/logger';
import {
  GuildSettingsRepository,
  SnapshotRepository,
  StatsRepository,
} from '../db/repositories';

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
  /** First non-null origin used for OAuth redirect after login. */
  primaryWebsiteOrigin: string;
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

// ─── Env helpers ──────────────────────────────────────────────────────────────

function loadApiEnv(): ApiEnv {
  const host = process.env.API_HOST?.trim() || '0.0.0.0';
  const port = Number.parseInt(process.env.API_PORT ?? '3847', 10) || 3847;

  const rawOrigins = process.env.WEBSITE_ORIGIN ?? 'http://127.0.0.1:3000,http://localhost:3000';
  const websiteOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Prefer a real http(s) origin for post-login redirects (skip "null")
  const primaryWebsiteOrigin =
    websiteOrigins.find((o) => o !== 'null' && /^https?:\/\//i.test(o)) ??
    'http://127.0.0.1:3000';

  return {
    host,
    port,
    websiteOrigins,
    primaryWebsiteOrigin,
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

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
  credentials: boolean,
): void {
  const origin = req.headers.origin;
  // Browser sends Origin: null as the string "null" for some local file cases
  if (origin && (origins.includes(origin) || origins.includes('*'))) {
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
    const path = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      applyCors(req, res, env.websiteOrigins, true);
      res.writeHead(204);
      res.end();
      return;
    }

    const isAdmin = path.startsWith('/api/admin') || path.startsWith('/api/auth');
    applyCors(req, res, env.websiteOrigins, isAdmin || path === '/api/stats');

    // ── Health ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        ready: client.isReady(),
      });
      return;
    }

    // ── Public stats ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/stats') {
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
    if (method === 'GET' && path === '/api/auth/login') {
      const config = getConfig();
      if (!env.discordClientSecret) {
        sendJson(res, 503, {
          error: 'OAuth is not configured (DISCORD_CLIENT_SECRET missing).',
        });
        return;
      }

      const params = new URLSearchParams({
        client_id: config.discord.clientId,
        response_type: 'code',
        scope: 'identify guilds',
        redirect_uri: env.oauthRedirectUri,
        prompt: 'consent',
      });
      sendRedirect(res, `https://discord.com/api/oauth2/authorize?${params}`);
      return;
    }

    // ── Auth: callback ────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/auth/callback') {
      const code = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      if (oauthError || !code) {
        sendRedirect(
          res,
          `${env.primaryWebsiteOrigin}/admin.html?error=${encodeURIComponent(oauthError ?? 'missing_code')}`,
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
        logger.warn(`API OAuth token exchange failed: HTTP ${tokenRes.status}`);
        sendRedirect(res, `${env.primaryWebsiteOrigin}/admin.html?error=token_exchange`);
        return;
      }

      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        sendRedirect(res, `${env.primaryWebsiteOrigin}/admin.html?error=no_token`);
        return;
      }

      const meRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!meRes.ok) {
        sendRedirect(res, `${env.primaryWebsiteOrigin}/admin.html?error=user_fetch`);
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

      const cookie = encodeSession(session, env.sessionSecret);
      sendRedirect(res, `${env.primaryWebsiteOrigin}/admin.html`, {
        'Set-Cookie': sessionCookieHeader(cookie, SESSION_TTL_SEC),
      });
      return;
    }

    // ── Auth: me ──────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/auth/me') {
      const cookies = parseCookies(req);
      const user = decodeSession(cookies[COOKIE_NAME], env.sessionSecret);
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
    if (method === 'POST' && path === '/api/auth/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader() });
      return;
    }

    // ── Admin routes require session ──────────────────────────────────────
    if (path.startsWith('/api/admin')) {
      const cookies = parseCookies(req);
      const user = decodeSession(cookies[COOKIE_NAME], env.sessionSecret);
      if (!user) {
        sendJson(res, 401, { error: 'Not authenticated' });
        return;
      }

      // GET /api/admin/guilds
      if (method === 'GET' && path === '/api/admin/guilds') {
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

      // /api/admin/guilds/:id/settings | stats
      const guildMatch = path.match(/^\/api\/admin\/guilds\/(\d{17,20})\/(settings|stats)$/);
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
          sendJson(res, 200, {
            guildId: settings.guildId,
            newsEnabled: settings.newsEnabled,
            newsChannelId: settings.newsChannelId,
            steamEnabled: settings.steamEnabled,
            steamChannelId: settings.steamChannelId,
            epicEnabled: settings.epicEnabled,
            epicChannelId: settings.epicChannelId,
            updatedAt: settings.updatedAt.toISOString(),
            updatedByUserId: settings.updatedByUserId,
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
            } = {};

            if (typeof body.newsEnabled === 'boolean') update.newsEnabled = body.newsEnabled;
            if (typeof body.steamEnabled === 'boolean') update.steamEnabled = body.steamEnabled;
            if (typeof body.epicEnabled === 'boolean') update.epicEnabled = body.epicEnabled;

            if ('newsChannelId' in body) update.newsChannelId = normalizeChannelId(body.newsChannelId) ?? null;
            if ('steamChannelId' in body) update.steamChannelId = normalizeChannelId(body.steamChannelId) ?? null;
            if ('epicChannelId' in body) update.epicChannelId = normalizeChannelId(body.epicChannelId) ?? null;

            const saved = await guildSettingsRepo.upsert(guildId, update, user.id);
            sendJson(res, 200, {
              guildId: saved.guildId,
              newsEnabled: saved.newsEnabled,
              newsChannelId: saved.newsChannelId,
              steamEnabled: saved.steamEnabled,
              steamChannelId: saved.steamChannelId,
              epicEnabled: saved.epicEnabled,
              epicChannelId: saved.epicChannelId,
              updatedAt: saved.updatedAt.toISOString(),
              updatedByUserId: saved.updatedByUserId,
            });
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

    sendJson(res, 404, { error: 'Not found' });
  }

  server.listen(env.port, env.host, () => {
    logger.info(`Website API listening on http://${env.host}:${env.port}`);
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
