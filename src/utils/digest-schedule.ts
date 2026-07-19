/**
 * Whether digests should be delivered on this poll for a guild's preferred UTC hour.
 * null/undefined hour = every successful host poll (legacy behaviour).
 */
export function isPostHourNow(hourUtc: number | null | undefined, now = new Date()): boolean {
  if (hourUtc == null || !Number.isFinite(hourUtc)) return true;
  const h = Math.trunc(Number(hourUtc));
  if (h < 0 || h > 23) return true;
  return now.getUTCHours() === h;
}

/** Parse discount percent from feed strings like "-80%", "80%", "−75 %". */
export function parseDiscountPercent(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * Case-insensitive keyword filter for news posts.
 * - Empty / null = match all
 * - Comma-separated include terms: any match passes
 * - Prefix with `-` or `!` to exclude (e.g. `AI, Nintendo, -crypto`)
 * Exclude wins: if any exclude term hits, the item is dropped.
 */
export function matchesKeywords(haystack: string, keywordsCsv: string | null | undefined): boolean {
  if (!keywordsCsv || !keywordsCsv.trim()) return true;
  const text = haystack.toLowerCase();
  const raw = keywordsCsv
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (raw.length === 0) return true;

  const include: string[] = [];
  const exclude: string[] = [];
  for (const part of raw) {
    if (part.startsWith('-') || part.startsWith('!')) {
      const term = part.slice(1).trim().toLowerCase();
      if (term) exclude.push(term);
    } else {
      include.push(part.toLowerCase());
    }
  }

  if (exclude.some((k) => text.includes(k))) return false;
  if (include.length === 0) return true;
  return include.some((k) => text.includes(k));
}

/** Parse comma/space-separated Discord snowflake role IDs (max 25). */
export function parseRoleIds(csv: string | null | undefined): string[] {
  if (!csv?.trim()) return [];
  const ids = csv
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,30}$/.test(s));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 25) break;
  }
  return out;
}
