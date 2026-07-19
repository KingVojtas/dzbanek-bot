/**
 * Probe the home music worker (MUSIC_WORKER_URL) for admin UI and auto-resume.
 */

export type MusicWorkerHealth = {
  configured: boolean;
  ok: boolean;
  status: number | null;
  host: string | null;
  error: string | null;
  checkedAt: string;
};

export async function probeMusicWorker(timeoutMs = 2500): Promise<MusicWorkerHealth> {
  const checkedAt = new Date().toISOString();
  const raw = process.env.MUSIC_WORKER_URL?.trim();
  if (!raw) {
    return {
      configured: false,
      ok: false,
      status: null,
      host: null,
      error: 'MUSIC_WORKER_URL not set',
      checkedAt,
    };
  }

  let host: string | null = null;
  try {
    host = new URL(raw).host;
  } catch {
    host = raw.slice(0, 60);
  }

  const base = raw.replace(/\/$/, '');
  const candidates = [base.endsWith('/health') ? base : `${base}/health`, base];

  let lastErr: string | null = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: process.env.MUSIC_WORKER_SECRET
          ? { Authorization: `Bearer ${process.env.MUSIC_WORKER_SECRET}` }
          : undefined,
      });
      // 404 on / is fine for some workers; 2xx/401/403 means tunnel is up
      const ok = res.ok || res.status === 401 || res.status === 403 || res.status === 404;
      if (ok || res.status < 500) {
        return {
          configured: true,
          ok: res.ok || res.status === 404,
          status: res.status,
          host,
          error: res.ok || res.status === 404 ? null : `HTTP ${res.status}`,
          checkedAt,
        };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    configured: true,
    ok: false,
    status: null,
    host,
    error: lastErr ?? 'unreachable',
    checkedAt,
  };
}
