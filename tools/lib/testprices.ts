// Testnet only: stated test prices for funds whose quotes are signed by the test signer (1Click
// has no testnet and prices none of these tokens). The table is a file the user can read and edit;
// nothing here is market data. Pure, tested in tools/test/release03.test.ts.

export interface TestPrices {
  /** USD per whole token and the token's decimals, by token account. */
  tokens: Record<string, { decimals: number; usd: string }>;
  /** What the stand-in "solver" keeps, in basis points of the input's value. */
  spread_bps: number;
}

/** "2.5" -> 2_500_000 micro-USD (extra decimals truncated, as the contract reads 1Click's marks). */
function usdMicros(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a USD amount: ${JSON.stringify(s)}`);
  return BigInt(m[1]) * 1_000_000n + BigInt(((m[2] ?? "") + "000000").slice(0, 6));
}

const fmtMicros = (v: bigint) => `${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, "0")}`;

function entry(p: TestPrices, token: string) {
  const e = p.tokens[token];
  if (!e) throw new Error(`the test price table has no entry for ${token}`);
  if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 36) throw new Error(`bad decimals for ${token}`);
  const usd = usdMicros(e.usd);
  if (usd === 0n) throw new Error(`the test price of ${token} must be more than 0`);
  return { scale: 10n ** BigInt(e.decimals), usd };
}

/** The fill a test quote states for selling `amount` (base units) of `sell` for `buy` at the table's
 *  prices: output after the spread, 0.5% slippage room, and the USD marks the contract's cost check
 *  reads. */
export function testFill(p: TestPrices, sell: string, buy: string, amount: bigint): { out: bigint; minOut: bigint; inUsd: string; outUsd: string } {
  if (!Number.isInteger(p.spread_bps) || p.spread_bps < 0 || p.spread_bps >= 10_000) throw new Error("spread_bps must be 0..9999");
  if (sell === buy) throw new Error("cannot quote a token against itself");
  const s = entry(p, sell), b = entry(p, buy);
  const keep = 10_000n - BigInt(p.spread_bps);
  const inMicros = (amount * s.usd) / s.scale;
  const out = (amount * s.usd * keep * b.scale) / (s.scale * b.usd * 10_000n);
  return { out, minOut: (out * 995n) / 1000n, inUsd: fmtMicros(inMicros), outUsd: fmtMicros((inMicros * keep) / 10_000n) };
}

/** The table as one line of text for the AI operator's prompt, for the fund's tokens. */
export function describeTestPrices(p: TestPrices, tokens: string[]): string {
  return `TEST PRICES (testnet, not market data): ${tokens.map((t) => `1 ${t} (${entry(p, t) && p.tokens[t].decimals} decimals) = $${p.tokens[t].usd}`).join("; ")}`;
}
