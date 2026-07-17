#!/usr/bin/env node
/**
 * Home / residential music worker for dzbanek-bot.
 *
 * Railway's cloud IP is bot-blocked by YouTube. Run this on a home PC (or any
 * residential network), expose it (Tailscale / ngrok / Cloudflare Tunnel), and
 * set on Railway:
 *
 *   MUSIC_WORKER_URL=https://your-tunnel-host
 *   MUSIC_WORKER_SECRET=long-random-string   (optional but recommended)
 *
 * Usage:
 *   node scripts/music-worker.mjs
 *   # or:  npm run music-worker
 *
 * Requires: yt-dlp + ffmpeg on PATH (or set YTDLP_BIN / FFMMPEG_BIN).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PORT = Number.parseInt(process.env.MUSIC_WORKER_PORT ?? '8790', 10) || 8790;
const SECRET = process.env.MUSIC_WORKER_SECRET?.trim() || '';
const YTDLP = process.env.YTDLP_BIN?.trim() || 'yt-dlp';

function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function badRequest(res, msg) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function streamWithYtDlp(url, res) {
  const args = [
    url,
    '-o',
    '-',
    '-f',
    'bestaudio/best/18',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--geo-bypass',
    // Prefer cookie-free clients that work on residential IPs.
    '--extractor-args',
    'youtube:player_client=android_vr,tv_simply,mweb,web_embedded,android',
  ];

  const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let settled = false;
  let gotData = false;
  const errChunks = [];

  const fail = (status, msg) => {
    if (settled) return;
    settled = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    } else {
      res.destroy();
    }
  };

  child.stderr?.on('data', (c) => {
    errChunks.push(c);
    if (errChunks.length > 30) errChunks.shift();
  });

  child.stdout?.on('data', (chunk) => {
    if (!gotData) {
      gotData = true;
      settled = true;
      res.writeHead(200, {
        'content-type': 'audio/mp4',
        'cache-control': 'no-store',
        'x-music-worker': 'dzbanek',
      });
    }
    if (!res.writableEnded) res.write(chunk);
  });

  child.stdout?.on('end', () => {
    if (!gotData) {
      const err = Buffer.concat(errChunks).toString('utf8').slice(-500);
      fail(502, err || 'yt-dlp produced no audio');
      return;
    }
    if (!res.writableEnded) res.end();
  });

  child.on('error', (err) => {
    fail(500, `failed to spawn yt-dlp: ${err.message}`);
  });

  child.on('close', (code) => {
    if (!gotData && !settled) {
      const err = Buffer.concat(errChunks).toString('utf8').slice(-500);
      fail(502, err || `yt-dlp exited ${code}`);
    }
  });

  res.on('close', () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'dzbanek-music-worker' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/stream') {
    if (SECRET) {
      const got = req.headers['x-music-worker-secret'];
      if (got !== SECRET) {
        unauthorized(res);
        return;
      }
    }

    let body;
    try {
      body = await readJson(req);
    } catch {
      badRequest(res, 'invalid json');
      return;
    }

    const mediaUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      badRequest(res, 'body.url must be an http(s) URL');
      return;
    }

    console.log(`[worker] stream ${mediaUrl}`);
    streamWithYtDlp(mediaUrl, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dzbanek music worker listening on http://0.0.0.0:${PORT}`);
  console.log(`Health:  GET  /health`);
  console.log(`Stream:  POST /stream  { "url": "https://youtube.com/watch?v=…" }`);
  if (SECRET) console.log('Auth:    x-music-worker-secret required');
  else console.log('Auth:    none (set MUSIC_WORKER_SECRET in production)');
});

// Keep Windows console from closing on unhandled rejection
process.on('unhandledRejection', (e) => console.error(e));
