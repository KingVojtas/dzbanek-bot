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

/** Case-insensitive: true if any keyword appears in the haystack. Empty keywords = match all. */
export function matchesKeywords(
  haystack: string,
  keywordsCsv: string | null | undefined,
): boolean {
  if (!keywordsCsv || !keywordsCsv.trim()) return true;
  const text = haystack.toLowerCase();
  const parts = keywordsCsv
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.some((k) => text.includes(k));
}
