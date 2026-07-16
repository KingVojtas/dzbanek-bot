import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Logger } from '../core/logger';

/**
 * HTTP(S)/SOCKS proxy for YouTube extraction (yt-dlp + youtubei.js).
 *
 * Env (first match wins):
 * - `YTDLP_PROXY` — preferred (bot-only; does not affect Discord/Steam)
 * - `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` — standard names
 *
 * Examples:
 * - `http://user:pass@host:port`
 * - `socks5://user:pass@host:port`
 *
 * Prefer **residential** proxies. Datacenter proxies are often blocked like Railway.
 */
export function resolveYtProxyUrl(): string | undefined {
  const raw =
    process.env.YTDLP_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.ALL_PROXY?.trim();
  if (!raw) return undefined;
  const withScheme = raw.includes('://') ? raw : `http://${raw}`;
  try {
    void new URL(withScheme);
  } catch {
    return undefined;
  }
  return withScheme;
}

/** yt-dlp `--proxy` flag when configured. */
export function ytDlpProxyFlags(): Record<string, string> {
  const proxy = resolveYtProxyUrl();
  return proxy ? { proxy } : {};
}

/** Redact credentials for logs. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return '[invalid-proxy]';
  }
}

export function logYtProxy(logger?: Logger): void {
  const proxy = resolveYtProxyUrl();
  if (proxy) {
    logger?.info(`YouTube proxy: ${redactProxyUrl(proxy)}`);
  } else {
    logger?.info('YouTube proxy: not set (YTDLP_PROXY / HTTPS_PROXY)');
  }
}

/**
 * fetch() that routes through the YouTube proxy (undici ProxyAgent).
 * Used by youtubei.js so Innertube shares the same egress as yt-dlp.
 *
 * Types are cast: undici vs DOM fetch types differ across @types packages.
 */
export function createYtProxyFetch(): typeof fetch | undefined {
  const proxy = resolveYtProxyUrl();
  if (!proxy) return undefined;

  const agent = new ProxyAgent(proxy);

  // youtubei.js only needs a fetch-compatible function; cast past undici/DOM mismatch.
  const proxiedFetch = ((input: unknown, init?: unknown) => {
    return undiciFetch(
      input as never,
      {
        ...(typeof init === 'object' && init ? init : {}),
        dispatcher: agent,
      } as never,
    );
  }) as typeof fetch;

  return proxiedFetch;
}
