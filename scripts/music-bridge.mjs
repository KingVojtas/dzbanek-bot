#!/usr/bin/env node
/**
 * Permanent free YouTube bridge for Railway (no paid proxy).
 *
 * Keeps the home music worker + Cloudflare quick tunnel alive, and whenever the
 * public URL changes, updates Railway:
 *   MUSIC_WORKER_URL / MUSIC_WORKER_SECRET
 *
 * Install once (Task Scheduler at logon):
 *   npm run music-bridge:install
 *
 * Or run manually (leave this window open / minimized):
 *   npm run music-bridge
 *
 * Your PC must be on for YouTube playback. The Discord bot still runs on Railway.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const STATE_FILE = join(DATA_DIR, 'music-bridge-state.json');
const PORT = Number.parseInt(process.env.MUSIC_WORKER_PORT ?? '8790', 10) || 8790;
const SECRET =
  process.env.MUSIC_WORKER_SECRET?.trim() ||
  'dzbanek-home-free-2026';

const RESTART_DELAY_MS = 4_000;
const HEALTH_EVERY_MS = 20_000;

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[bridge ${ts}]`, ...args);
}

function saveState(partial) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    let prev = {};
    if (existsSync(STATE_FILE)) {
      prev = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
    writeFileSync(STATE_FILE, JSON.stringify({ ...prev, ...partial, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log('state save failed:', e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnLogged(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MUSIC_WORKER_PORT: String(PORT),
      MUSIC_WORKER_SECRET: SECRET,
    },
    ...opts,
  });
  return child;
}

async function waitForLocalHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

function updateRailwayUrl(url) {
  const args = [
    'variable',
    'set',
    `MUSIC_WORKER_URL=${url}`,
    `MUSIC_WORKER_SECRET=${SECRET}`,
    '--service',
    'bot',
  ];
  try {
    // Prefer global railway; fall back to npx
    try {
      execFileSync('railway', args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    } catch {
      execFileSync('npx', ['--yes', '@railway/cli', ...args], {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
        shell: true,
      });
    }
    log('Railway updated: MUSIC_WORKER_URL =', url);
    saveState({ musicWorkerUrl: url, secret: SECRET });
    return true;
  } catch (e) {
    log('Railway update FAILED:', e.message || e);
    log('Set manually: railway variable set MUSIC_WORKER_URL="' + url + '" --service bot');
    return false;
  }
}

function startWorker() {
  log('starting music worker on port', PORT);
  const child = spawnLogged(process.execPath, [join(ROOT, 'scripts', 'music-worker.mjs')]);
  child.stdout?.on('data', (d) => {
    const s = d.toString();
    if (/listening|error|fail/i.test(s)) process.stdout.write(`[worker] ${s}`);
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[worker] ${d}`));
  child.on('exit', (code, signal) => {
    log(`worker exited code=${code} signal=${signal}`);
  });
  return child;
}

/**
 * Start cloudflared quick tunnel and resolve the public https URL from logs.
 */
function startTunnel() {
  return new Promise((resolve, reject) => {
    log('starting Cloudflare quick tunnel…');
    const child = spawnLogged(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--yes', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${PORT}`],
      { shell: process.platform === 'win32' },
    );

    let settled = false;
    let buffer = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      buffer += text;
      // cloudflared prints: https://xxxx.trycloudflare.com
      const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        log('tunnel URL:', m[0]);
        resolve({ child, url: m[0] });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code, signal) => {
      if (!settled) {
        reject(new Error(`cloudflared exited before URL (code=${code} signal=${signal})`));
      } else {
        log(`tunnel exited code=${code} signal=${signal}`);
      }
    });
    setTimeout(() => {
      if (!settled) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('Timed out waiting for tunnel URL (60s)'));
      }
    }, 60_000);
  });
}

async function runLoop() {
  log('══════════════════════════════════════════════════════');
  log('  Dzbanek permanent music bridge (FREE, home IP)');
  log('══════════════════════════════════════════════════════');
  log('  Secret:', SECRET);
  log('  Keep this PC on. Bot stays on Railway.');
  log('══════════════════════════════════════════════════════');

  let lastUrl = '';
  saveState({ secret: SECRET, port: PORT });

  for (;;) {
    let worker = null;
    let tunnel = null;
    try {
      worker = startWorker();
      const ok = await waitForLocalHealth();
      if (!ok) throw new Error('worker health check failed');

      const t = await startTunnel();
      tunnel = t.child;
      const url = t.url;

      if (url !== lastUrl) {
        updateRailwayUrl(url);
        lastUrl = url;
      } else {
        log('tunnel URL unchanged');
      }

      // Stay up until either process dies; health-check local worker + public tunnel
      await new Promise((resolve) => {
        let done = false;
        let publicFails = 0;
        const health = setInterval(async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
              signal: AbortSignal.timeout(3_000),
            });
            if (!res.ok) throw new Error('bad local health');
          } catch {
            log('worker health failed — restarting bridge');
            finish();
            return;
          }
          // Public tunnel can die while local worker is fine — force full restart
          if (lastUrl) {
            try {
              const pub = await fetch(`${lastUrl}/health`, {
                signal: AbortSignal.timeout(8_000),
              });
              if (!pub.ok) throw new Error(`public HTTP ${pub.status}`);
              publicFails = 0;
            } catch (e) {
              publicFails += 1;
              log(`public tunnel health fail (${publicFails}):`, e.message || e);
              if (publicFails >= 2) {
                log('public tunnel dead — restarting bridge');
                finish();
              }
            }
          }
        }, HEALTH_EVERY_MS);

        function finish() {
          if (done) return;
          done = true;
          clearInterval(health);
          resolve();
        }

        worker.once('exit', () => {
          log('worker died');
          finish();
        });
        tunnel.once('exit', () => {
          log('tunnel died');
          finish();
        });
      });
    } catch (e) {
      log('bridge cycle error:', e.message || e);
    } finally {
      try {
        worker?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      try {
        tunnel?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }

    log(`restarting in ${RESTART_DELAY_MS / 1000}s…`);
    await sleep(RESTART_DELAY_MS);
  }
}

// Prevent unhandled crash
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

runLoop();
