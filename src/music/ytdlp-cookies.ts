import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../core/logger';

const RUNTIME_COOKIE_PATH = join(tmpdir(), 'dzbanek-ytdlp-cookies.txt');

/** Process-local kill-switch when cookies prove expired / bot-check poison. */
let cookiesInvalidated = false;
let cookiesInvalidatedReason: string | undefined;

/**
 * Resolve a cookies.txt path for yt-dlp.
 *
 * Env (first match wins):
 * - `YTDLP_COOKIES` — absolute path to an existing cookies.txt, OR raw Netscape cookie file contents
 * - `YTDLP_COOKIES_BASE64` — base64-encoded cookies.txt (best for Railway variables)
 * - `YTDLP_COOKIES_CONTENT` — raw cookies.txt body (if your host supports multiline secrets)
 *
 * Set `YTDLP_IGNORE_COOKIES=1` to never pass cookies (recommended when they are
 * rotated/expired — stale cookies often make YouTube bot-check *worse*).
 */
export function ensureYtDlpCookies(logger?: Logger): string | undefined {
  if (process.env.YTDLP_IGNORE_COOKIES === '1' || process.env.YTDLP_IGNORE_COOKIES === 'true') {
    logger?.info('yt-dlp cookies: ignored (YTDLP_IGNORE_COOKIES=1) — using cookie-free clients');
    // Clear path so ytDlpCookieFlags() stays empty even if a leftover file exists.
    delete process.env.YTDLP_COOKIES;
    return undefined;
  }

  if (cookiesInvalidated) {
    logger?.warn(
      `yt-dlp cookies: invalidated at runtime (${cookiesInvalidatedReason ?? 'unknown'}) — cookie-free clients only`,
    );
    return undefined;
  }

  const pathOrInline = process.env.YTDLP_COOKIES?.trim();
  if (pathOrInline && existsSync(pathOrInline) && !pathOrInline.includes('\n')) {
    logger?.info(`yt-dlp cookies: using file ${pathOrInline}`);
    return pathOrInline;
  }

  let raw: string | undefined;
  const b64 = process.env.YTDLP_COOKIES_BASE64?.trim();
  if (b64) {
    try {
      raw = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      logger?.warn('yt-dlp cookies: YTDLP_COOKIES_BASE64 is not valid base64');
    }
  }

  if (!raw) {
    const content = process.env.YTDLP_COOKIES_CONTENT?.trim();
    if (content) raw = content;
  }

  // Inline file body mistakenly put in YTDLP_COOKIES
  if (
    !raw &&
    pathOrInline &&
    (pathOrInline.includes('\n') ||
      pathOrInline.includes('# Netscape') ||
      pathOrInline.includes('youtube.com'))
  ) {
    raw = pathOrInline;
  }

  if (!raw || raw.trim().length < 20) {
    logger?.info(
      'yt-dlp cookies: not set — using cookie-free player clients (android_vr / mweb / …).',
    );
    return undefined;
  }

  // Quick sanity: Netscape rows need tabs. Corrupted / filtered files break yt-dlp.
  const dataLines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const tabbed = dataLines.filter((l) => l.includes('\t')).length;
  if (dataLines.length > 0 && tabbed < dataLines.length * 0.5) {
    logger?.warn(
      'yt-dlp cookies: file looks corrupted (missing tabs) — ignoring cookies so bot-check is not worse.',
    );
    return undefined;
  }

  // Must include session-ish cookies; visitor-only jars are useless and can hurt.
  const names = new Set(
    dataLines.map((l) => l.split('\t')[5]).filter((n): n is string => Boolean(n)),
  );
  const hasSession =
    names.has('LOGIN_INFO') ||
    names.has('SID') ||
    names.has('__Secure-1PSID') ||
    names.has('__Secure-3PSID');
  if (!hasSession) {
    logger?.warn(
      'yt-dlp cookies: no LOGIN_INFO/SID in jar — ignoring (export while logged into YouTube).',
    );
    return undefined;
  }

  writeFileSync(RUNTIME_COOKIE_PATH, raw, 'utf8');
  process.env.YTDLP_COOKIES = RUNTIME_COOKIE_PATH;
  logger?.info(
    `yt-dlp cookies: wrote ${RUNTIME_COOKIE_PATH} (${raw.length} chars, ${dataLines.length} rows)`,
  );
  return RUNTIME_COOKIE_PATH;
}

export function ytDlpCookieFlags(): Record<string, string> {
  if (cookiesInvalidated) return {};
  if (process.env.YTDLP_IGNORE_COOKIES === '1' || process.env.YTDLP_IGNORE_COOKIES === 'true') {
    return {};
  }
  const file = process.env.YTDLP_COOKIES?.trim();
  if (file && existsSync(file)) return { cookies: file };
  return {};
}

/** Absolute path to the runtime Netscape jar, if available. */
export function getYtDlpCookiePath(): string | undefined {
  const flags = ytDlpCookieFlags();
  return flags.cookies;
}

/**
 * Build a Cookie header string for youtubei.js from the Netscape jar
 * (youtube.com + google.com session cookies).
 */
export function ytCookieHeaderFromJar(): string | undefined {
  const file = getYtDlpCookiePath();
  if (!file || !existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, 'utf8');
    const pairs: string[] = [];
    const seen = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('\t')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0];
      const name = parts[5];
      const value = parts[6];
      if (!name || value === undefined) continue;
      if (!/(^|\.)youtube\.com$|(^|\.)google\.com$|accounts\.google/i.test(domain)) continue;
      // Last write wins for duplicate names across domains (youtube over google often fine).
      if (seen.has(name)) {
        const idx = pairs.findIndex((p) => p.startsWith(`${name}=`));
        if (idx >= 0) pairs[idx] = `${name}=${value}`;
      } else {
        seen.add(name);
        pairs.push(`${name}=${value}`);
      }
    }
    if (
      !pairs.some(
        (p) =>
          p.startsWith('SID=') || p.startsWith('LOGIN_INFO=') || p.startsWith('__Secure-1PSID='),
      )
    ) {
      return undefined;
    }
    return pairs.join('; ');
  } catch {
    return undefined;
  }
}

/**
 * Stop using cookies for the rest of this process (stale jars make bot-check worse).
 * Call when yt-dlp reports expired cookies / login_required with a cookie jar.
 */
export function invalidateYtDlpCookies(reason: string, logger?: Logger): void {
  if (cookiesInvalidated) return;
  cookiesInvalidated = true;
  cookiesInvalidatedReason = reason;
  delete process.env.YTDLP_COOKIES;
  logger?.warn(`yt-dlp cookies: invalidated — ${reason}`);
}

export function areYtDlpCookiesInvalidated(): boolean {
  return cookiesInvalidated;
}

/**
 * True when the cookie jar itself is dead (not just IP bot-check / rate limit).
 * Generic "not a bot" must NOT kill cookies for the rest of the process — that
 * often happens after a few plays on cloud IPs and cookies may still help later
 * (or with a proxy).
 */
export function isCookiePoisonError(errText: string): boolean {
  return /cookies are no longer valid|cookies? (?:have )?rotated|cookie.*invalid/i.test(errText);
}

/** User-facing message when YouTube bot-check / proxy misconfig blocks extraction. */
export function youtubeBotCheckHint(errText: string): string | null {
  if (/407|proxy authentication required|Tunnel connection failed/i.test(errText)) {
    return (
      '❌ **YouTube proxy auth failed** (HTTP 407).\n' +
      'Railway `YTDLP_PROXY` is set but the proxy rejected the username/password.\n' +
      '1. Check user/pass with your proxy provider (or generate a new endpoint)\n' +
      '2. Set a **plain** URL only: `http://user:pass@host:port` — not a Markdown link\n' +
      '3. Redeploy after fixing the variable\n' +
      'Until the proxy works, cloud IPs stay bot-blocked even with cookies.'
    );
  }

  if (
    !/sign in to confirm|not a bot|cookies-from-browser|--cookies|cookies are no longer valid|login_required/i.test(
      errText,
    )
  ) {
    return null;
  }
  const expired = /cookies are no longer valid|rotated/i.test(errText);
  if (expired) {
    return (
      '❌ YouTube cookies on the host are **expired** (browser rotated them).\n' +
      '1. Log into YouTube in a browser\n' +
      '2. Export **fresh** cookies (“Get cookies.txt LOCALLY”)\n' +
      '3. Base64 and update Railway `YTDLP_COOKIES_BASE64`, then redeploy\n' +
      'Tip: export right before setting the env — open youtube.com once after login.\n' +
      'Or set `YTDLP_IGNORE_COOKIES=1` if the jar is stale (cookie-free clients only).'
    );
  }
  return (
    '❌ YouTube is blocking this **server IP** (bot check).\n' +
    'Railway’s cloud IP is flagged — cookies alone usually don’t fix it.\n' +
    '**Pick one fix:**\n' +
    '1. **Residential proxy** on Railway: `YTDLP_PROXY=http://user:pass@host:port`\n' +
    '2. **Home music worker** (free if you have a PC):\n' +
    '   - On your PC: `npm run music-worker` (+ expose with ngrok/Tailscale)\n' +
    '   - Railway: `MUSIC_WORKER_URL=https://your-tunnel` and optional `MUSIC_WORKER_SECRET`\n' +
    '3. Or run the whole bot on a home/residential network.'
  );
}
