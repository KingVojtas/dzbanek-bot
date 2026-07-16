import { existsSync, writeFileSync } from 'node:fs';
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

/** User-facing message when YouTube bot-check blocks extraction. */
export function youtubeBotCheckHint(errText: string): string | null {
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
    '❌ YouTube is blocking this server (bot check).\n' +
    '**Try in order:**\n' +
    '1. Set a **residential** proxy: Railway `YTDLP_PROXY=http://user:pass@host:port` (or socks5://…)\n' +
    '2. Export **fresh** cookies → `YTDLP_COOKIES_BASE64` (helps with proxy; alone dies fast on cloud IPs)\n' +
    '3. If cookies are known-stale: `YTDLP_IGNORE_COOKIES=1`\n' +
    'See: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies'
  );
}
