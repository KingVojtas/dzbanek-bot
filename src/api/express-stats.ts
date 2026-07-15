import type { Server } from 'node:http';
import cors from 'cors';
import type { Client } from 'discord.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from '../core/logger';

export interface ExpressStatsOptions {
  client: Client;
}

interface ExpressStatsEnv {
  host: string;
  port: number;
  websiteOrigins: string[];
}

function loadExpressStatsEnv(): ExpressStatsEnv {
  const host = process.env.EXPRESS_STATS_HOST?.trim() || '0.0.0.0';
  const port = Number.parseInt(process.env.EXPRESS_STATS_PORT ?? '3848', 10) || 3848;

  const rawOrigins = process.env.WEBSITE_ORIGIN ?? 'http://127.0.0.1:3000,http://localhost:3000';
  const websiteOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { host, port, websiteOrigins };
}

function approxUserCount(client: Client): number {
  let total = 0;
  for (const guild of client.guilds.cache.values()) {
    total += guild.memberCount ?? 0;
  }
  return total;
}

/**
 * Minimal Express sidecar for public website stats.
 * Listens on a separate port from the main Website API (`src/api/server.ts`).
 */
export function startExpressStatsServer(options: ExpressStatsOptions): Server {
  const { client } = options;
  const env = loadExpressStatsEnv();
  const allowed = env.websiteOrigins;

  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser tools (curl, server-side fetch) often omit Origin.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowed.includes(origin) || allowed.includes('*')) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      methods: ['GET', 'OPTIONS'],
    }),
  );

  app.get('/api/stats', (_req: Request, res: Response) => {
    res.json({
      serverCount: client.guilds.cache.size,
      userCount: approxUserCount(client),
      uptime: Math.floor(process.uptime()),
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      ready: client.isReady(),
    });
  });

  // CORS package rejects disallowed origins via next(err); keep the process alive.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal server error';
    if (message.includes('not allowed by CORS')) {
      res.status(403).json({ error: 'Origin not allowed by CORS' });
      return;
    }
    logger.error('Express stats request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(env.port, env.host, () => {
    logger.info(`Express stats API listening on http://${env.host}:${env.port}`);
  });

  server.on('error', (error) => {
    logger.error('Express stats server error:', error);
  });

  return server;
}
