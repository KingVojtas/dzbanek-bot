/**
 * Discord Components V2: max **40** nested components per message.
 * Used to shrink Steam/Epic digests before send so posts don't fail with 50035.
 */
export const DISCORD_V2_COMPONENT_MAX = 40;

/**
 * Rough count for a Steam-style digest:
 * container + intro text + per row (separator + section + text + optional thumb) + wishlist row.
 */
export function estimateSteamDigestComponents(dealRows: number, hasWishlist: boolean): number {
  const intro = 2; // container + text
  const perDeal = 4; // separator + section + text + thumbnail
  const wishlist = hasWishlist ? 2 : 0; // action row + select
  return intro + dealRows * perDeal + wishlist;
}

/** Epic free-games digest: container + intro + optional labels + per-game rows. */
export function estimateEpicDigestComponents(
  freeRows: number,
  upcomingRows: number,
  hasEmptyFreeLabel: boolean,
): number {
  const intro = 2;
  const emptyLabel = hasEmptyFreeLabel ? 2 : 0; // sep + text
  const upcomingHeader = upcomingRows > 0 ? 2 : 0;
  const perGame = 4;
  return intro + emptyLabel + upcomingHeader + (freeRows + upcomingRows) * perGame;
}

/** Largest N that keeps estimate ≤ max (min 1 if n >= 1). */
export function fitRowsToBudget(
  desired: number,
  estimate: (n: number) => number,
  max = DISCORD_V2_COMPONENT_MAX,
): number {
  if (desired <= 0) return 0;
  let n = desired;
  while (n > 1 && estimate(n) > max) n -= 1;
  return n;
}
