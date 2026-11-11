import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../index.ts";
import { codeInfo, type FundDetail } from "../_lib/funds.ts";
import { OG_FOOTER, handleOg, humanAmount, ogData, ogElement, tokenMeta, type OgData } from "../_lib/og.ts";
import { near } from "../_lib/near.ts";
import { fakeDeps, fakeRpc, fundState, get, type FakeChain } from "./helpers.ts";

const V02 = "82sC6iGvYGWL1kgSMDBb3rLhwRse9FtZa7ZcGEwG8RCA";
const GOOD = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const RELEASES = { [V02]: { version: "0.2", commit: "4cad1b0", known_issue: "counts bounced transfers as holdings" }, [GOOD]: { version: "0.3", commit: "abcdef0" } };
const FUND = "open2.plinthfund.testnet";

const detail = (o: { hash?: string; keys?: number; fund?: any; byAccount?: boolean } = {}): FundDetail => {
  const account = { amount: "1", storage_usage: 1, code_hash: o.hash ?? V02, global_contract_hash: null, global_contract_account_id: o.byAccount ? "publisher.near" : null };
  return { id: FUND, network: "testnet", legacy: true, known_issue: null, from_factory: false, account, access_keys: o.keys ?? 0, code: codeInfo(account, RELEASES), fund: o.fund === undefined ? fundState({ held: ["22500005", "1700000000000000000000000"], trades: 2, rejections: 5 }) : o.fund, trades: [], rejections: [], fetched_at: "" };
};
const METAS = { "pusd.plinthfund.testnet": { symbol: "pUSD", decimals: 6 }, "wrap.testnet": { symbol: "wNEAR", decimals: 24 } };

const chain = (): FakeChain => ({
  accounts: { [FUND]: { code_hash: V02 } },
  keys: { [FUND]: 0 },
  views: {
    [`${FUND}.get_fund`]: fundState({ held: ["22500005", "1700000000000000000000000"], trades: 2 }),
    "wrap.testnet.ft_metadata": { spec: "ft-1.0.0", name: "Wrapped NEAR", symbol: "wNEAR", decimals: 24 },
    // pusd.plinthfund.testnet has no ft_metadata, like the real test token.
  },
});

test("humanAmount: exact, grouped, cut (never rounded up) to four decimals", () => {
  assert.equal(humanAmount("22500005", 6), "22.5");
  assert.equal(humanAmount("1700000000000000000000000", 24), "1.7");
  assert.equal(humanAmount("171999999999999999999999", 24), "0.1719");
  assert.equal(humanAmount("1234567890123", 6), "1,234,567.8901");
  assert.equal(humanAmount("0", 24), "0");
  assert.equal(humanAmount("1", 24), "<0.0001");
  assert.equal(humanAmount("5", 0), "5");
  assert.equal(humanAmount("340282366920938463463374607431768211455", 18), "340,282,366,920,938,463,463.3746");
  assert.equal(humanAmount("abc", 6), "?");
});

test("ogData: a keyless fund on a release with a known issue", () => {
  const d = ogData(detail(), METAS);
  assert.equal(d.title, FUND);
  assert.deepEqual(d.keys, { text: "0 access keys", tone: "ok" });
  assert.deepEqual(d.release, { text: "release 0.2 · known issue", tone: "warn" });
  assert.deepEqual(d.holdings, [{ symbol: "pUSD", amount: "22.5" }, { symbol: "wNEAR", amount: "1.7" }]);
  assert.deepEqual([d.trades, d.refusals], ["2", "5"]);
  assert.equal(d.footer, OG_FOOTER);
  assert.equal(OG_FOOTER, "exit in kind, any time");
});

test("ogData: keys are shown as they are, in red when there are any", () => {
  assert.deepEqual(ogData(detail({ keys: 1 }), METAS).keys, { text: "1 access key", tone: "bad" });
  assert.deepEqual(ogData(detail({ keys: 3 }), METAS).keys, { text: "3 access keys", tone: "bad" });
});

test("ogData: release without an issue, unknown code, code another account can change, not a fund", () => {
  assert.deepEqual(ogData(detail({ hash: GOOD }), METAS).release, { text: "release 0.3", tone: "ok" });
  assert.deepEqual(ogData(detail({ hash: "DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa" }), METAS).release, { text: "unknown code", tone: "bad" });
  assert.deepEqual(ogData(detail({ byAccount: true }), METAS).release, { text: "unknown code", tone: "bad" });
  const notFund = ogData(detail({ fund: null }), METAS);
  assert.equal(notFund.isFund, false);
  assert.deepEqual(notFund.holdings, []);
  assert.notEqual(notFund.footer, OG_FOOTER); // no exit promise for something that is not a fund
});

test("ogElement: the drawing contains what the data says, as text", () => {
  const text = JSON.stringify(ogElement(ogData(detail({ keys: 2 }), METAS)));
  for (const s of [FUND, "2 access keys", "release 0.2 · known issue", "22.5", "pUSD", "wNEAR", "trades", "refused", "exit in kind, any time", "#f87171"]) assert.ok(text.includes(s), s);
});

test("tokenMeta: read from the token, cached; the test pUSD falls back to 6 decimals", async () => {
  const deps = fakeDeps(fakeRpc(chain()));
  const n = near(deps, "testnet");
  const cache = new Map();
  assert.deepEqual(await tokenMeta(n, "wrap.testnet", cache), { symbol: "wNEAR", decimals: 24 });
  assert.deepEqual(await tokenMeta(n, "wrap.testnet", cache), { symbol: "wNEAR", decimals: 24 });
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(await tokenMeta(n, "pusd.plinthfund.testnet", cache), { symbol: "pUSD", decimals: 6 });
  assert.deepEqual(await tokenMeta(n, "other.testnet", cache), { symbol: "other", decimals: 0 });
});

test("GET /api/og: shapes the picture from chain views (drawing stubbed)", async () => {
  let drawn: OgData | undefined;
  const res = await handleOg(get(`/api/og?fund=${FUND}&network=testnet`), fakeDeps(fakeRpc(chain())), async (d) => ((drawn = d), new Uint8Array([1, 2, 3])));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("cache-control") ?? "", /s-maxage=60/);
  assert.deepEqual(drawn?.keys, { text: "0 access keys", tone: "ok" });
  assert.deepEqual(drawn?.holdings, [{ symbol: "pUSD", amount: "22.5" }, { symbol: "wNEAR", amount: "1.7" }]);
  assert.equal(drawn?.trades, "2");
});

test("GET /api/og: bad id 400, unknown account a 404 picture, RPC trouble 503 (never a wrong picture)", async () => {
  const stub = async () => new Uint8Array([1]);
  assert.equal((await handleOg(get("/api/og?fund=<x>"), fakeDeps(fakeRpc(chain())), stub)).status, 400);
  assert.equal((await handleOg(get(`/api/og?fund=${FUND}&network=nope`), fakeDeps(fakeRpc(chain())), stub)).status, 400);
  const missing = await handleOg(get("/api/og?fund=nobody.testnet"), fakeDeps(fakeRpc(chain())), stub);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "image/png");
  const down = await handleOg(get(`/api/og?fund=${FUND}`), fakeDeps(() => new Response("x", { status: 500 })), stub);
  assert.equal(down.status, 503);
  const broken = await handleOg(get(`/api/og?fund=${FUND}`), fakeDeps(fakeRpc(chain())), async () => Promise.reject(new Error("boom")));
  assert.equal(broken.status, 500);
});

test("GET /api/og: a real 1200x630 PNG from @vercel/og for a mocked fund", async () => {
  const res = await handle(get(`/api/og?fund=${FUND}&network=testnet`), fakeDeps(fakeRpc(chain())));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: width and height, big endian, at bytes 16..24.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  assert.ok(png.length > 10_000 && png.length < 500_000, `png is ${png.length} bytes`);
});
