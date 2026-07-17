#!/usr/bin/env node
/**
 * Free home music worker for dzbanek-bot (no paid proxy).
 *
 * YouTube blocks Railway's cloud IP. This process runs on your home PC and
 * extracts audio with your residential IP. Railway calls it over a free tunnel.
 *
 * Setup (once):
 *   1. npm install   (uses node_modules yt-dlp)
 *   2. npm run music-worker
 *   3. In another terminal: npm run music-tunnel
 *   4. Copy the https URL into Railway:
 *        MUSIC_WORKER_URL=https://….trycloudflare.com
 *        MUSIC_WORKER_SECRET=<same as printed below>
 *   5. railway up -y   (or let GitHub auto-deploy)
 *
 * Keep this PC on + both terminals open while using music.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT = Number.parseInt(process.env.MUSIC_WORKER_PORT ?? '8790', 10) || 8790;
const SECRET =
  process.env.MUSIC_WORKER_SECRET?.trim() ||
  createHash('sha256')
    .update(`dzbanek-worker-${homedir()}`)
    .digest('hex')
    .slice(0, 32);

function findYtDlp() {
  if (process.env.YTDLP_BIN?.trim()) return process.env.YTDLP_BIN.trim();
  const candidates = [
    join(ROOT, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe'),
    join(ROOT, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp'),
    join(ROOT, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp-win-x64.exe'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // last resort: PATH
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

const YTDLP = findYtDlp();

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
    '--extractor-args',
    'youtube:player_client=android_vr,tv_simply,mweb,web_embedded,android',
  ];

  console.log(`[worker] yt-dlp ${url}`);
  const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    if (errChunks.length > 40) errChunks.shift();
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
      console.log(`[worker] streaming…`);
    }
    if (!res.writableEnded) res.write(chunk);
  });

  child.stdout?.on('end', () => {
    if (!gotData) {
      const err = Buffer.concat(errChunks).toString('utf8').slice(-600);
      console.error('[worker] no audio:', err);
      fail(502, err || 'yt-dlp produced no audio');
      return;
    }
    if (!res.writableEnded) res.end();
    console.log('[worker] done');
  });

  child.on('error', (err) => {
    fail(500, `failed to spawn yt-dlp (${YTDLP}): ${err.message}`);
  });

  child.on('close', (code) => {
    if (!gotData && !settled) {
      const err = Buffer.concat(errChunks).toString('utf8').slice(-600);
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
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'dzbanek-music-worker',
        ytdlp: YTDLP,
      }),
    );
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/stream') {
    const got = req.headers['x-music-worker-secret'];
    if (got !== SECRET) {
      unauthorized(res);
      return;
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

    streamWithYtDlp(mediaUrl, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  dzbanek free music worker (home IP)');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Local:   http://127.0.0.1:${PORT}/health`);
  console.log(`  yt-dlp:  ${YTDLP}`);
  console.log(`  Secret:  ${SECRET}`);
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Keep this window open');
  console.log('  2. Run in another terminal:  npm run music-tunnel');
  console.log('  3. Put the https URL + this secret on Railway');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
  if (!existsSync(YTDLP) && !YTDLP.includes('yt-dlp')) {
    console.warn('WARN: yt-dlp binary may be missing. Run: npm ci');
  }
});

process.on('unhandledRejection', (e) => console.error(e));
