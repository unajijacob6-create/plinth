import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handle } from "../index.ts";
import { QUOTE_MAX_BYTES, QUOTE_OPTIONAL, QUOTE_REQUIRED, pickQuoteRequest } from "../_lib/quote.ts";
import { verifySignature } from "../../tools/lib/oneclick.ts";
import { fakeDeps, get, post } from "./helpers.ts";

// A real signed 1Click answer, as bytes. The proxy must hand back exactly these.
const LIVE = fs.readFileSync(new URL("../../contracts/plinth/tests/fixtures/quote_live.json", import.meta.url));

const request = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:usdt.tether-token.near",
  amount: "1000000000000000000000000",
  refundTo: "fund.plinth.near",
  refundType: "ORIGIN_CHAIN",
  recipient: "fund.plinth.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-11T00:10:00.000Z",
  quoteWaitingTimeMs: 0,
  customRecipientMsg: "trade:7",
};

const upstream = (bytes: Uint8Array = LIVE, status = 201) => () => new Response(bytes as any, { status, headers: { "content-type": "application/json; charset=utf-8" } });

test("quote: forwards only allow-listed fields, to 1Click's quote endpoint", async () => {
  const deps = fakeDeps(upstream());
  const res = await handle(post("/api/quote", { ...request, appFees: [{ recipient: "evil.near", fee: 500 }], rebates: [], insured: true, confidentiality: "x", __proto__x: 1, somethingElse: "x" }), deps);
  assert.equal(res.status, 201);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].url, "https://1click.chaindefuser.com/v0/quote");
  assert.equal(deps.calls[0].method, "POST");
  const sent = JSON.parse(deps.calls[0].body);
  assert.deepEqual(sent, request);
  for (const k of Object.keys(sent)) assert.ok(([...QUOTE_REQUIRED, ...QUOTE_OPTIONAL] as string[]).includes(k), k);
  assert.equal(sent.customRecipientMsg, "trade:7");
});

test("quote: returns the upstream body byte for byte, with the upstream status", async () => {
  for (const [bytes, status] of [[LIVE, 201], [Buffer.from('{"message":"amount  too low",\n "x": 1.0 }\n'), 400], [Buffer.from([0xff, 0x00, 0x7b, 0x0a]), 500]] as const) {
    const res = await handle(post("/api/quote", request), fakeDeps(upstream(bytes, status)));
    assert.equal(res.status, status);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), `status ${status}: bytes differ`);
    assert.equal(res.headers.get("x-plinth-source"), "1click");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
});

test("quote: the proxied bytes still carry 1Click's signature", async () => {
  const res = await handle(post("/api/quote", request), fakeDeps(upstream()));
  assert.equal(verifySignature(JSON.parse(await res.text())), true);
});

test("quote: adds the partner token only when configured, and says which", async () => {
  const without = fakeDeps(upstream());
  const a = await handle(post("/api/quote", request), without);
  assert.equal(a.headers.get("x-plinth-jwt"), "no");
  assert.equal(without.calls[0].headers.authorization, undefined);

  const withJwt = fakeDeps(upstream(), { ONE_CLICK_JWT: "test-token-not-a-secret" });
  const b = await handle(post("/api/quote", request), withJwt);
  assert.equal(b.headers.get("x-plinth-jwt"), "yes");
  assert.equal(withJwt.calls[0].headers.authorization, "Bearer test-token-not-a-secret");
  // The token never comes back to the caller.
  assert.ok(!(await b.text()).includes("test-token-not-a-secret"));
  assert.ok(![...b.headers.values()].some((v) => v.includes("test-token-not-a-secret")));
  assert.match(b.headers.get("access-control-expose-headers") ?? "", /x-plinth-jwt/);
});

test("quote: refuses what is not a small JSON object, without calling 1Click", async () => {
  const deps = fakeDeps(() => assert.fail("must not reach 1Click"));
  const cases: [Request, number, string][] = [
    [post("/api/quote", JSON.stringify(request), { "content-type": "text/plain" }), 415, "not_json"],
    [post("/api/quote", "{not json"), 400, "bad_json"],
    [post("/api/quote", "[1,2]"), 400, "bad_json"],
    [post("/api/quote", '"text"'), 400, "bad_json"],
    [post("/api/quote", { ...request, pad: "x".repeat(QUOTE_MAX_BYTES) }), 413, "body_too_large"],
    [post("/api/quote", { ...request, recipient: undefined }), 400, "bad_quote_request"],
    [post("/api/quote", { ...request, amount: "1.5" }), 400, "bad_quote_request"],
    [post("/api/quote", { ...request, dry: "false" }), 400, "bad_quote_request"],
    [post("/api/quote", { ...request, recipient: { $ne: 1 } }), 400, "bad_quote_request"],
    [get("/api/quote"), 405, "method_not_allowed"],
  ];
  for (const [req, status, code] of cases) {
    const res = await handle(req, deps);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, code);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
  assert.equal(deps.calls.length, 0);
});

test("quote: an upstream timeout or network failure is a clear JSON error from the proxy", async () => {
  const timeout = await handle(post("/api/quote", request), fakeDeps(() => Promise.reject(new DOMException("timed out", "TimeoutError"))));
  assert.equal(timeout.status, 504);
  assert.equal(timeout.headers.get("x-plinth-source"), "proxy");
  assert.equal((await timeout.json()).error, "upstream_timeout");
  const down = await handle(post("/api/quote", request), fakeDeps(() => Promise.reject(new TypeError("fetch failed"))));
  assert.equal(down.status, 502);
  assert.equal((await down.json()).error, "upstream_unreachable");
});

test("quote: passes a 10 s timeout signal to the upstream call", async () => {
  let signal: unknown;
  const deps = fakeDeps(upstream());
  const inner = deps.fetch;
  deps.fetch = ((u: any, i: any) => ((signal = i.signal), inner(u, i))) as typeof fetch;
  await handle(post("/api/quote", request), deps);
  assert.ok(signal instanceof AbortSignal);
});

test("quote: CORS preflight is answered for any origin", async () => {
  const res = await handle(new Request("https://plinth.example/api/quote", { method: "OPTIONS", headers: { origin: "https://someone.github.io", "access-control-request-method": "POST" } }), fakeDeps(() => assert.fail("no upstream call")));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/);
});

test("quote: too many requests from one address are slowed down", async () => {
  const deps = fakeDeps(upstream());
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push((await handle(post("/api/quote", request, { "x-real-ip": "203.0.113.77" }), deps)).status);
  assert.equal(statuses.filter((s) => s === 201).length, 20);
  assert.equal(statuses.filter((s) => s === 429).length, 5);
  // Another address is not affected.
  assert.equal((await handle(post("/api/quote", request, { "x-real-ip": "203.0.113.78" }), deps)).status, 201);
});

test("pickQuoteRequest keeps optional fields 1Click signs and drops the rest", () => {
  const p = pickQuoteRequest({ ...request, referral: "plinth", virtualChainRecipient: "0xabc", appFees: [] });
  assert.ok(p.ok);
  assert.equal(p.request.referral, "plinth");
  assert.equal(p.request.virtualChainRecipient, "0xabc");
  assert.equal("appFees" in p.request, false);
});

test("tokens: cached proxy of /v0/tokens, bytes unchanged", async () => {
  const bytes = Buffer.from('[{"assetId":"nep141:wrap.near","decimals":24}]');
  const deps = fakeDeps(upstream(bytes, 200), { ONE_CLICK_JWT: "t" });
  const res = await handle(get("/api/tokens"), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.calls[0].url, "https://1click.chaindefuser.com/v0/tokens");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));
  assert.match(res.headers.get("cache-control") ?? "", /s-maxage=60/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  // An upstream error is passed on but not cached.
  const bad = await handle(get("/api/tokens"), fakeDeps(upstream(Buffer.from("oops"), 503)));
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  assert.equal((await handle(post("/api/tokens", {}), deps)).status, 405);
});
