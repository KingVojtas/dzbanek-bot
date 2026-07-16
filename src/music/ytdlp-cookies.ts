import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../core/logger';

const RUNTIME_COOKIE_PATH = join(tmpdir(), 'dzbanek-ytdlp-cookies.txt');

/**
 * Resolve a cookies.txt path for yt-dlp.
 *
 * Railway/cloud YouTube often requires auth cookies ("Sign in to confirm you're not a bot").
 *
 * Env (first match wins):
 * - `YTDLP_COOKIES` — absolute path to an existing cookies.txt, OR raw Netscape cookie file contents
 * - `YTDLP_COOKIES_BASE64` — base64-encoded cookies.txt (best for Railway variables)
 * - `YTDLP_COOKIES_CONTENT` — raw cookies.txt body (if your host supports multiline secrets)
 */
export function ensureYtDlpCookies(logger?: Logger): string | undefined {
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
  if (!raw && pathOrInline && (pathOrInline.includes('\n') || pathOrInline.includes('# Netscape') || pathOrInline.includes('youtube.com'))) {
    raw = pathOrInline;
  }

  if (!raw || raw.trim().length < 20) {
    logger?.warn(
      'yt-dlp cookies: not configured. Cloud hosts often need YTDLP_COOKIES_BASE64 or music will fail with "Sign in to confirm you\'re not a bot".',
    );
    return undefined;
  }

  writeFileSync(RUNTIME_COOKIE_PATH, raw, 'utf8');
  process.env.YTDLP_COOKIES = RUNTIME_COOKIE_PATH;
  logger?.info(`yt-dlp cookies: wrote ${RUNTIME_COOKIE_PATH} (${raw.length} chars)`);
  return RUNTIME_COOKIE_PATH;
}

export function ytDlpCookieFlags(): Record<string, string> {
  const file = process.env.YTDLP_COOKIES?.trim();
  if (file && existsSync(file)) return { cookies: file };
  return {};
}

/** User-facing message when YouTube bot-check blocks extraction. */
export function youtubeBotCheckHint(errText: string): string | null {
  if (!/sign in to confirm|not a bot|cookies-from-browser|--cookies/i.test(errText)) {
    return null;
  }
  return (
    '❌ YouTube is blocking this server (bot check).\n' +
    'An admin must add **YouTube cookies** on the host:\n' +
    '1. Export cookies (extension “Get cookies.txt LOCALLY” while logged into YouTube)\n' +
    '2. Base64 the file and set Railway env `YTDLP_COOKIES_BASE64`\n' +
    '3. Redeploy the bot\n' +
    'See: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies'
  );
}
