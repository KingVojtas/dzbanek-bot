const XP_MIN = 15;
const XP_MAX = 25;
const CHAR_BONUS_CAP = 5;
const MIN_MESSAGE_LEN = 2;

/** True when a message is long enough to earn XP. */
export function isMessageEligible(content: string): boolean {
  return content.replace(/\s+/g, ' ').trim().length >= MIN_MESSAGE_LEN;
}

/** XP awarded for one eligible message (random base + small length bonus). */
export function xpForMessage(content: string): number {
  const base = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const len = content.replace(/\s+/g, ' ').trim().length;
  const bonus = Math.min(CHAR_BONUS_CAP, Math.floor(len / 50));
  return base + bonus;
}

/**
 * XP needed while at `level` to reach level+1.
 * Curve: 50·n² + 100·n where n = level + 1 (so 0→1 costs 150).
 */
export function xpRequiredForNext(level: number): number {
  const L = Math.max(0, Math.floor(level)) + 1;
  return 50 * L * L + 100 * L;
}

/** Cumulative XP required to *reach* `level` (level 0 = 0). */
export function totalXpToReach(level: number): number {
  const target = Math.max(0, Math.floor(level));
  let total = 0;
  for (let l = 0; l < target; l++) {
    total += xpRequiredForNext(l);
  }
  return total;
}

/** Derive level from total lifetime XP. */
export function levelFromTotalXp(xp: number): number {
  let level = 0;
  let remaining = Math.max(0, Math.floor(xp));
  while (remaining >= xpRequiredForNext(level)) {
    remaining -= xpRequiredForNext(level);
    level += 1;
    if (level > 10_000) break;
  }
  return level;
}

export function progressInLevel(xp: number): {
  level: number;
  intoLevel: number;
  need: number;
} {
  const level = levelFromTotalXp(xp);
  const floor = totalXpToReach(level);
  const need = xpRequiredForNext(level);
  return { level, intoLevel: Math.max(0, Math.floor(xp) - floor), need };
}

/** Emoji progress bar, e.g. ███████░░░ */
export function progressBar(into: number, need: number, width = 10): string {
  if (need <= 0) return '█'.repeat(width);
  const ratio = Math.max(0, Math.min(1, into / need));
  const filled = Math.min(width, Math.round(ratio * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
