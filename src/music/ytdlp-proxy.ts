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
/**
 * Strip common copy-paste wrappers that make `new URL()` fail:
 * Markdown `[label](http://…)`, `[http://…]`, `(http://…)`, `<http://…>`.
 */
function sanitizeProxyInput(raw: string): string {
  let s = raw.trim();

  // Markdown link: [label](http://user:pass@host:port)
  const md = s.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
  if (md) {
    const label = md[1].trim();
    const href = md[2].trim();
    s = href.includes('://') ? href : label.includes('://') ? label : href;
  }

  if (
    (s.startsWith('[') && s.endsWith(']')) ||
    (s.startsWith('(') && s.endsWith(')')) ||
    (s.startsWith('<') && s.endsWith('>'))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Mismatched wrappers e.g. `[http://host:port)` from bad paste
  s = s
    .replace(/^[[(<]+/, '')
    .replace(/[\])>]+$/, '')
    .trim();
  return s;
}

export function resolveYtProxyUrl(): string | undefined {
  const raw =
    process.env.YTDLP_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.ALL_PROXY?.trim();
  if (!raw) return undefined;
  const cleaned = sanitizeProxyInput(raw);
  if (!cleaned) return undefined;
  const withScheme = cleaned.includes('://') ? cleaned : `http://${cleaned}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return undefined;
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
  const raw = process.env.YTDLP_PROXY?.trim();
  const proxy = resolveYtProxyUrl();
  if (proxy) {
    logger?.info(`YouTube proxy: ${redactProxyUrl(proxy)}`);
    if (raw && raw !== proxy) {
      logger?.warn(
        'YouTube proxy: cleaned paste wrappers (Markdown [url](url) / brackets) — set a plain http://user:pass@host:port next time',
      );
    }
  } else if (raw) {
    logger?.warn(
      `YouTube proxy: YTDLP_PROXY is set but invalid (${raw.length} chars) — expected http://user:pass@host:port`,
    );
  } else {
    logger?.info('YouTube proxy: not set (YTDLP_PROXY / HTTPS_PROXY)');
  }
}

/**
 * fetch() that routes through the YouTube proxy (undici ProxyAgent).
 * Used by youtubei.js so Innertube shares the same egress as yt-dlp.
 *
 * youtubei.js often passes a Request object; undici needs a URL string + init.
 */
export function createYtProxyFetch(): typeof fetch | undefined {
  const proxy = resolveYtProxyUrl();
  if (!proxy) return undefined;

  const agent = new ProxyAgent(proxy);

  const proxiedFetch = ((input: unknown, init?: unknown) => {
    const baseInit =
      typeof init === 'object' && init !== null ? { ...(init as Record<string, unknown>) } : {};

    let url: string;
    const fromRequest: Record<string, unknown> = {};

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === 'object' && 'url' in input) {
      const req = input as Request;
      url = req.url;
      if (!('method' in baseInit)) fromRequest.method = req.method;
      if (!('headers' in baseInit)) fromRequest.headers = req.headers;
      if (
        !('body' in baseInit) &&
        req.method &&
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.body
      ) {
        fromRequest.body = req.body;
        fromRequest.duplex = 'half';
      }
    } else {
      url = String(input);
    }

    return undiciFetch(url, {
      ...fromRequest,
      ...baseInit,
      dispatcher: agent,
    } as never);
  }) as typeof fetch;

  return proxiedFetch;
}
