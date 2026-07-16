/**
 * Fetches and evaluates Steam user review data via the appreviews API.
 *
 * Endpoint: https://store.steampowered.com/appreviews/<APP_ID>?json=1
 *
 * Steam review_score values:
 *   0 = No Reviews
 *   1 = Overwhelmingly Negative  2 = Very Negative  3 = Negative
 *   4 = Mostly Negative          5 = Mixed
 *   6 = Mostly Positive          7 = Positive
 *   8 = Very Positive            9 = Overwhelmingly Positive  ← we accept 8+
 */

const REVIEWS_BASE = 'https://store.steampowered.com/appreviews';

/** Minimum Steam review_score to accept (8 = Very Positive). */
const PASSING_SCORE = 8;

/** Fallback: also accept games with >= this % positive reviews (for edge cases). */
const MIN_POSITIVE_PCT = 80;

/** Require at least this many total reviews before trusting the score. */
const MIN_REVIEWS = 10;

// ─── Raw API types ─────────────────────────────────────────────────────────────

interface RawQuerySummary {
  num_reviews: number;
  review_score: number;
  review_score_desc: string;
  total_positive: number;
  total_negative: number;
  total_reviews: number;
}

interface RawReviewsResponse {
  success: 1 | 0;
  query_summary: RawQuerySummary;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface SteamReviewInfo {
  /** Steam review_score (0–9). */
  score: number;
  /** Human-readable label, e.g. "Very Positive". */
  scoreDesc: string;
  /** Total number of reviews on record. */
  totalReviews: number;
  /** Percentage of positive reviews, rounded to the nearest integer. */
  positivePct: number;
}

/**
 * Returns true when a game meets the quality threshold:
 *   – Steam review score ≥ minScore (default 8 = Very Positive), OR
 *   – ≥ 80 % positive with at least 10 reviews (only when using default score).
 *
 * When `minScore` is provided (admin override), require score ≥ minScore and enough reviews.
 */
export function isGoodReview(info: SteamReviewInfo, minScore?: number | null): boolean {
  if (info.totalReviews < MIN_REVIEWS) return false;
  if (minScore != null && Number.isFinite(minScore)) {
    return info.score >= minScore;
  }
  return info.score >= PASSING_SCORE || info.positivePct >= MIN_POSITIVE_PCT;
}

/**
 * Fetches the user review summary for a single Steam app.
 * Returns null when the app has no reviews, is region-locked, or the request fails.
 */
export async function fetchSteamReview(appId: string): Promise<SteamReviewInfo | null> {
  const url = `${REVIEWS_BASE}/${appId}?json=1&language=all&purchase_type=all`;
  console.log(`[Steam Reviews] Fetching reviews for app ${appId}…`);

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    console.error(`[Steam Reviews] Network error for app ${appId}:`, error);
    return null;
  }

  if (!response.ok) {
    console.warn(`[Steam Reviews] HTTP ${response.status} for app ${appId}.`);
    return null;
  }

  let json: RawReviewsResponse;
  try {
    json = (await response.json()) as RawReviewsResponse;
  } catch (error) {
    console.error(`[Steam Reviews] JSON parse error for app ${appId}:`, error);
    return null;
  }

  if (json.success !== 1) {
    console.warn(`[Steam Reviews] success=0 for app ${appId}.`);
    return null;
  }

  const s = json.query_summary;
  const positivePct =
    s.total_reviews > 0 ? Math.round((s.total_positive / s.total_reviews) * 100) : 0;

  console.log(
    `[Steam Reviews] App ${appId}: "${s.review_score_desc}" — ` +
      `${positivePct}% positive (${s.total_reviews} reviews)`,
  );

  return {
    score: s.review_score,
    scoreDesc: s.review_score_desc,
    totalReviews: s.total_reviews,
    positivePct,
  };
}

/** Formats a SteamReviewInfo into a Discord markdown string, e.g. `⭐ **Very Positive** (95%)`. */
export function formatReview(info: SteamReviewInfo): string {
  return `⭐ **${info.scoreDesc}** (${info.positivePct}%)`;
}
