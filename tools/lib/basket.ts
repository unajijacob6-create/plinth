// In-kind join (release 0.3, `open_ended` funds): how much of each token a basket needs for a
// number of shares. Pure, mirrors `join_in_kind` in contracts/plinth/src/lib.rs.

/** ceil(a * b / d). */
const mulDivCeil = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

/** The amount of each token (same order as `held`) a basket must hold so that `join_in_kind` mints
 *  at least `shares`: ceil(shares * held[i] / total_shares), 0 for a token the fund does not hold.
 *  The fund takes the same fraction of every holding, so these are the fund's own proportions. */
export function basketAmounts(held: bigint[], totalShares: bigint, shares: bigint): bigint[] {
  if (shares <= 0n) throw new Error("shares must be positive");
  if (totalShares <= 0n) throw new Error("the fund has no shares to price a join against");
  if (held.some((h) => h < 0n)) throw new Error("holdings cannot be negative");
  if (held.every((h) => h === 0n)) throw new Error("the fund holds nothing to join");
  return held.map((h) => (h === 0n ? 0n : mulDivCeil(shares, h, totalShares)));
}

/** What `join_in_kind` would mint and take for a basket, by the contract's own arithmetic:
 *  shares = min over held tokens of floor(basket * total / held); taken = ceil(shares * held / total). */
export function joinOutcome(basket: bigint[], held: bigint[], totalShares: bigint): { shares: bigint; taken: bigint[] } {
  let s: bigint | null = null;
  held.forEach((h, i) => {
    if (h > 0n) {
      const x = (basket[i] * totalShares) / h;
      if (s === null || x < s) s = x;
    }
  });
  const shares = s ?? 0n;
  return { shares, taken: held.map((h, i) => (h === 0n ? 0n : ((a) => (a < basket[i] ? a : basket[i]))(mulDivCeil(shares, h, totalShares)))) };
}
