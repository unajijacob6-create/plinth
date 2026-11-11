import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../index.ts";
import { LEGACY_FUNDS, codeInfo, factoryFor, listFunds } from "../_lib/funds.ts";
import { near } from "../_lib/near.ts";
import { fakeDeps, fakeRpc, fundState, get, type FakeChain } from "./helpers.ts";

const V01 = "9P39GJXvgFpsiPpcDYUyzYikajydDUwfYuHr9b2V9dMj"; // release 0.1 in data/releases.json (known issue)
const V02 = "82sC6iGvYGWL1kgSMDBb3rLhwRse9FtZa7ZcGEwG8RCA"; // release 0.2 (known issue)
const V03 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // a stand-in hash for a release without a known issue
const RELEASES = { [V01]: { version: "0.1", commit: "0e12944", known_issue: "x" }, [V02]: { version: "0.2", commit: "4cad1b0", known_issue: "x" }, [V03]: { version: "0.3", commit: "abcdef0" } };
const FACTORY = "funds.plinthfund.testnet";
const [L1, L2, L3] = LEGACY_FUNDS.testnet;

const legacyChain = (): FakeChain => ({
  accounts: { [L1]: { code_hash: V02 }, [L2]: { code_hash: V01 }, [L3]: { code_hash: V02 } },
  views: { [`${L1}.get_fund`]: fundState(), [`${L2}.get_fund`]: fundState({ trades: 1, rejections: 2 }), [`${L3}.get_fund`]: fundState({ trades: 2 }) },
});

const withFactory = (): FakeChain => {
  const c = legacyChain();
  const created = [
    { account_id: `one.${FACTORY}`, creator: "alice.testnet", created_at: 1794000000 },
    { account_id: `two.${FACTORY}`, creator: "bob.testnet", created_at: 1794000100 },
  ];
  c.accounts[FACTORY] = { code_hash: "factorycode" };
  c.views[`${FACTORY}.fund_count`] = created.length;
  c.views[`${FACTORY}.get_code_hash`] = V03;
  c.views[`${FACTORY}.get_funds`] = ({ from, limit }: { from: number; limit: number }) => created.slice(from, from + limit);
  for (const e of created) {
    c.accounts[e.account_id] = { code_hash: "11111111111111111111111111111111", global_contract_hash: V03 };
    c.views[`${e.account_id}.get_fund`] = fundState({ version: "0.3.0", held: ["5000000", "0"] });
  }
  return c;
};

test("the three legacy funds are the ones on the site", () => {
  assert.deepEqual(LEGACY_FUNDS.testnet, ["open2.plinthfund.testnet", "fund-mwa9jwo8.plinthfund.testnet", "earn-mwad1ypv.plinthfund.testnet"]);
});

test("funds: no factory configured -> the legacy list only, flagged, and no failure", async () => {
  const deps = fakeDeps(fakeRpc(legacyChain()));
  const list = await listFunds(near(deps, "testnet"), { factory: null, now: deps.now() });
  assert.equal(list.factory, null);
  assert.equal(list.fund_count, 0);
  assert.equal(list.factory_error, undefined);
  assert.deepEqual(list.funds.map((f) => f.id), [L1, L2, L3]);
  for (const f of list.funds) assert.deepEqual([f.legacy, f.known_issue, f.ok], [true, true, true]);
  assert.deepEqual(list.funds.map((f) => f.release), ["0.2", "0.1", "0.2"]);
  assert.equal(list.funds[1].rejections, 2);
  assert.deepEqual(list.funds[0].held, [["pusd.plinthfund.testnet", "0"], ["wrap.testnet", "0"]]);
});

test("funds: factory funds (newest first) are merged with the legacy funds", async () => {
  const deps = fakeDeps(fakeRpc(withFactory()));
  const list = await listFunds(near(deps, "testnet"), { factory: FACTORY, now: deps.now(), releases: RELEASES });
  assert.equal(list.factory, FACTORY);
  assert.equal(list.fund_count, 2);
  assert.equal(list.factory_release, "0.3");
  assert.deepEqual(list.funds.map((f) => f.id), [`two.${FACTORY}`, `one.${FACTORY}`, L1, L2, L3]);
  const [two, one, legacy] = list.funds;
  assert.deepEqual([two.legacy, two.known_issue, two.ok, two.release, two.version], [false, false, true, "0.3", "0.3.0"]);
  assert.deepEqual([one.creator, one.created_at], ["alice.testnet", 1794000000]);
  assert.deepEqual([legacy.legacy, legacy.known_issue], [true, true]);
  // The factory was asked with {from, limit}.
  const asked = deps.calls.map((c) => JSON.parse(c.body).params).find((p) => p.method_name === "get_funds");
  assert.deepEqual(JSON.parse(Buffer.from(asked.args_base64, "base64").toString()), { from: 0, limit: 20 });
});

test("funds: paging asks the factory for the page and caps the limit", async () => {
  const c = withFactory();
  const seen: unknown[] = [];
  const inner = c.views[`${FACTORY}.get_funds`] as (a: any) => unknown;
  c.views[`${FACTORY}.get_funds`] = (a: any) => (seen.push(a), inner(a));
  const deps = fakeDeps(fakeRpc(c));
  const page = await listFunds(near(deps, "testnet"), { factory: FACTORY, from: 1, limit: 1, now: deps.now(), releases: RELEASES });
  assert.deepEqual(seen, [{ from: 1, limit: 1 }]);
  assert.deepEqual(page.funds.filter((f) => !f.legacy).map((f) => f.id), [`two.${FACTORY}`]);
  const big = await listFunds(near(deps, "testnet"), { factory: FACTORY, limit: 100000, now: deps.now(), releases: RELEASES });
  assert.equal(big.limit, 50);
});

test("funds: a factory that is configured but missing or broken does not fail the list", async () => {
  const deps = fakeDeps(fakeRpc(legacyChain())); // FACTORY is not an account on this chain
  const list = await listFunds(near(deps, "testnet"), { factory: FACTORY, now: deps.now() });
  assert.match(list.factory_error ?? "", /UNKNOWN_ACCOUNT/);
  assert.deepEqual(list.funds.map((f) => f.id), [L1, L2, L3]);
});

test("funds: one fund that does not answer is reported, the rest still listed", async () => {
  const c = legacyChain();
  delete c.views[`${L2}.get_fund`];
  const deps = fakeDeps(fakeRpc(c));
  const list = await listFunds(near(deps, "testnet"), { factory: null, now: deps.now() });
  assert.deepEqual(list.funds.map((f) => f.ok), [true, false, true]);
  assert.ok(list.funds[1].error);
  assert.equal(list.funds[1].known_issue, true);
});

test("GET /api/funds: JSON, CDN cache header, network checked", async () => {
  const deps = fakeDeps(fakeRpc(legacyChain()));
  const res = await handle(get("/api/funds?network=testnet"), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, s-maxage=20, stale-while-revalidate=60");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const j = await res.json();
  assert.equal(j.network, "testnet");
  assert.equal(j.funds.filter((f: any) => f.legacy && f.known_issue).length, 3);
  for (const c of deps.calls) assert.equal(c.url, "https://rpc.testnet.fastnear.com");
  assert.equal((await handle(get("/api/funds?network=devnet"), deps)).status, 400);
  // Mainnet has no legacy funds and (here) no factory: an empty list from the mainnet RPC, not an error.
  const main = fakeDeps(fakeRpc({ accounts: {}, views: {} }));
  const m = await (await handle(get("/api/funds?network=mainnet"), main)).json();
  assert.deepEqual(m.funds.filter((f: any) => f.legacy), []);
  for (const c of main.calls) assert.equal(c.url, "https://rpc.mainnet.fastnear.com");
});

test("factoryFor: environment override, then data/releases.json, and only a valid account id", () => {
  const rel = { releases: {}, factories: { testnet: "f.plinthfund.testnet" } };
  assert.equal(factoryFor("testnet", {}, rel), "f.plinthfund.testnet");
  assert.equal(factoryFor("mainnet", {}, rel), null);
  assert.equal(factoryFor("testnet", { PLINTH_FACTORY_TESTNET: "g.testnet" }, rel), "g.testnet");
  assert.equal(factoryFor("testnet", { PLINTH_FACTORY_TESTNET: "Not An Account" }, { releases: {} }), null);
  assert.equal(factoryFor("testnet", {}, { releases: {} }), null);
});

test("GET /api/fund: account, keys, code and release, state, last trades and refusals", async () => {
  const c = legacyChain();
  c.keys = { [L2]: 0 };
  c.views[`${L2}.get_fund`] = fundState({ trades: 14, rejections: 3 });
  const asked: Record<string, unknown> = {};
  c.views[`${L2}.get_trades`] = (a: any) => ((asked.trades = a), [{ id: 13, status: "Settled" }]);
  c.views[`${L2}.get_rejections`] = (a: any) => ((asked.rejections = a), [{ at: 1, reason: "over 2500 bps of holding", deposit_address: null }]);
  const res = await handle(get(`/api/fund?id=${L2}&network=testnet`), fakeDeps(fakeRpc(c)));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /s-maxage=20, stale-while-revalidate=60/);
  const j = await res.json();
  assert.equal(j.id, L2);
  assert.equal(j.access_keys, 0);
  assert.equal(j.legacy, true);
  assert.equal(j.account.code_hash, V01);
  assert.deepEqual([j.code.kind, j.code.hash, j.code.release.version], ["local", V01, "0.1"]);
  assert.match(j.known_issue, /bounced transfers/);
  assert.equal(j.fund.trades, 14);
  // Only the newest ten are read: the contract pages from the start.
  assert.deepEqual(asked, { trades: { from: 4, limit: 10 }, rejections: { from: 0, limit: 10 } });
  assert.equal(j.trades[0].id, 13);
  assert.equal(j.rejections[0].reason, "over 2500 bps of holding");
});

test("GET /api/fund: bad id 400, unknown account 404, not a fund 200 with fund null, keys counted", async () => {
  const c = legacyChain();
  c.accounts["someone.testnet"] = { code_hash: "11111111111111111111111111111111" };
  c.keys = { "someone.testnet": 2 };
  const deps = fakeDeps(fakeRpc(c));
  for (const bad of ["", "A.near", "a..b", "<x>"]) assert.equal((await handle(get(`/api/fund?id=${encodeURIComponent(bad)}`), deps)).status, 400);
  const missing = await handle(get("/api/fund?id=nobody.testnet"), deps);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "unknown_account");
  assert.equal(missing.headers.get("cache-control"), "no-store");
  const plain = await (await handle(get("/api/fund?id=someone.testnet"), deps)).json();
  assert.deepEqual([plain.fund, plain.access_keys, plain.code.kind, plain.code.release, plain.legacy], [null, 2, "none", null, false]);
});

test("codeInfo: local code, global by hash, global by account, unknown hash", () => {
  assert.deepEqual(codeInfo({ code_hash: V02 }, RELEASES), { kind: "local", hash: V02, release: { version: "0.2", commit: "4cad1b0", known_issue: "x" } });
  assert.deepEqual(codeInfo({ code_hash: "11111111111111111111111111111111", global_contract_hash: V03 }, RELEASES), { kind: "global-by-hash", hash: V03, release: { version: "0.3", commit: "abcdef0" } });
  assert.equal(codeInfo({ code_hash: "11111111111111111111111111111111", global_contract_account_id: "x.near" }, RELEASES).kind, "global-by-account");
  assert.equal(codeInfo({ code_hash: "DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa" }, RELEASES).release, null);
});

test("RPC: one retry on 429, then a clear 503", async () => {
  const chain = fakeRpc(legacyChain());
  let n = 0;
  const once = fakeDeps((call) => (n++ === 0 ? new Response("slow down", { status: 429 }) : chain(call)));
  assert.equal(await near(once, "testnet").accessKeyCount(L1), 0);
  assert.equal(once.calls.length, 2);

  const always = fakeDeps(() => new Response("slow down", { status: 429 }));
  const res = await handle(get(`/api/fund?id=${L1}`), always);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "rpc_unavailable");
  // view_account, view_access_key_list and get_fund: two attempts each, no more.
  assert.equal(always.calls.length, 6);
});
