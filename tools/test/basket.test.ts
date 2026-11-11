// The in-kind basket calculator (tools/lib/basket.ts) against the contract's own arithmetic
// (`join_in_kind` in contracts/plinth/src/lib.rs, mirrored by joinOutcome).
import { test } from "node:test";
import assert from "node:assert/strict";
import { basketAmounts, joinOutcome } from "../lib/basket.ts";

test("round numbers: a tenth of the shares needs a tenth of every holding", () => {
  const held = [90_000_000n, 20_000_000_000_000_000_000_000n];
  assert.deepEqual(basketAmounts(held, 100_000_000n, 10_000_000n), [9_000_000n, 2_000_000_000_000_000_000_000n]);
  assert.deepEqual(joinOutcome([9_000_000n, 2_000_000_000_000_000_000_000n], held, 100_000_000n), { shares: 10_000_000n, taken: [9_000_000n, 2_000_000_000_000_000_000_000n] });
});

test("amounts round up, never down", () => {
  // 7 shares of 3: 10 * 7 / 3 = 23.33 -> 24; 1 * 7 / 3 = 2.33 -> 3; exact stays exact.
  assert.deepEqual(basketAmounts([10n, 1n, 3n], 3n, 7n), [24n, 3n, 7n]);
  assert.deepEqual(basketAmounts([1n], 1_000_000_007n, 1n), [1n]);
});

test("a token the fund does not hold needs nothing", () => {
  assert.deepEqual(basketAmounts([0n, 5n, 0n], 10n, 4n), [0n, 2n, 0n]);
  assert.equal(joinOutcome([0n, 2n, 0n], [0n, 5n, 0n], 10n).shares, 4n);
});

test("awkward numbers: the basket always mints at least the shares wanted, and one unit less of any token would not", () => {
  const cases: [bigint[], bigint, bigint][] = [
    [[89_999_999n, 19_960_000_000_000_000_000_001n], 100_000_012n, 10_000_000n], // after a trade and a fee accrual
    [[1n, 999_999_999_999_999_999_999_999n], 3n, 2n], // one base unit of a token
    [[7n, 11n, 13n, 17n], 1_000_003n, 999_999n], // four tokens, shares far above holdings
    [[340_282_366_920_938_463_463_374_607_431_768_211_455n, 3n], 170_141_183_460_469_231_731_687_303_715_884_105_727n, 99_999_999_999_999_999_999n], // u128::MAX of a token
    [[123_456_789n, 0n, 987_654_321_000n], 555_555_555n, 1n], // a single share
    [[61_000_000n, 4_500_000_000_000_000_000_000_000n, 1_060_123_456_789_012_345_678_901n], 60_000_190n, 7_777_777n], // pUSD, wNEAR, stNEAR
    [[5n, 5n], 2n, 3n], // more shares than exist
  ];
  for (const [held, total, want] of cases) {
    const basket = basketAmounts(held, total, want);
    const got = joinOutcome(basket, held, total);
    assert.equal(got.shares >= want, true, `${held} / ${total}: wanted ${want}, would mint ${got.shares}`);
    got.taken.forEach((t, i) => assert.equal(t <= basket[i], true, "the fund never takes more than the basket holds"));
    held.forEach((h, i) => {
      if (h === 0n) return assert.equal(basket[i], 0n);
      // ceil: exactly the smallest amount with basket * total >= want * held.
      assert.equal(basket[i] * total >= want * h, true);
      assert.equal((basket[i] - 1n) * total < want * h, true);
      const short = basket.map((b, j) => (j === i ? b - 1n : b));
      assert.equal(joinOutcome(short, held, total).shares < want, true, `one unit less of token ${i} must not reach ${want} shares`);
    });
  }
});

test("a randomised sweep agrees with the contract's arithmetic", () => {
  // A fixed linear congruential generator: the same numbers on every run.
  let x = 0x2545f4914f6cdd1dn;
  const next = (bits: bigint) => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return x >> (64n - bits);
  };
  for (let n = 0; n < 2000; n++) {
    const held = Array.from({ length: Number(next(2n)) + 1 }, () => (next(3n) === 0n ? 0n : next(next(6n) + 1n) + 1n));
    if (held.every((h) => h === 0n)) continue;
    const total = next(next(6n) + 1n) + 1n, want = next(next(5n) + 1n) + 1n;
    const basket = basketAmounts(held, total, want);
    assert.equal(joinOutcome(basket, held, total).shares >= want, true, `${held} total ${total} want ${want}`);
  }
});

test("impossible joins are refused with a reason", () => {
  assert.throws(() => basketAmounts([0n, 0n], 10n, 1n), /holds nothing/);
  assert.throws(() => basketAmounts([5n], 0n, 1n), /no shares/);
  assert.throws(() => basketAmounts([5n], 10n, 0n), /positive/);
  assert.throws(() => basketAmounts([-1n], 10n, 1n), /negative/);
});
