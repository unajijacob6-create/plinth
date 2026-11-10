// Regression tests for the 2026-11-10 bug hunt (tools side).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { agree, baseUnits, canonicalToken, cleanDecision, parseDecision } from "../lib/agent.ts";
import { verifyReceipt } from "../lib/nearai.ts";
import { costBps, preflightStake } from "../lib/oneclick.ts";

const F = "fund.testnet";
const TOKENS = ["pusd.t", "wrap.testnet"];

test("amounts must be plain base units: decimals, exponents, signs and units are refused, not rewritten", () => {
  assert.equal(baseUnits("10000000"), "10000000");
  assert.equal(baseUnits(5000000), "5000000");
  for (const bad of ["10.5", "1e21", "-5", "10 pUSD", "", 1e21, 10.5, -1, null]) assert.equal(baseUnits(bad), null, String(bad));
  const v = (model: string, amount: unknown) => ({ model, decision: { action: "trade" as const, sell: "pusd.t", buy: "wrap.testnet", amount: amount as string, recipient: F } });
  assert.equal(agree([v("a", "10.5"), v("b", "10")], F, TOKENS).decision.action, "hold");
  assert.equal(cleanDecision({ action: "trade", sell: "pusd.t", buy: "wrap.testnet", amount: "0.75" }, F, TOKENS).action, "hold");
});

test("token names are mapped to the fund's exact list; unknown tokens hold", () => {
  assert.equal(canonicalToken(" Wrap.Testnet ", TOKENS), "wrap.testnet");
  assert.equal(canonicalToken("evil.testnet", TOKENS), null);
  const v = (m: string, buy: string) => ({ model: m, decision: { action: "trade" as const, sell: "PUSD.T", buy, amount: "5", recipient: "" } });
  const r = agree([v("a", "Wrap.Testnet "), v("b", "wrap.testnet")], F, TOKENS);
  assert.equal(r.decision.sell, "pusd.t");
  assert.equal(r.decision.buy, "wrap.testnet");
  assert.equal(r.decision.recipient, F);
  assert.equal(agree([v("a", "evil.testnet"), v("b", "evil.testnet")], F, TOKENS).decision.action, "hold");
});

test("parseDecision takes the last valid object, even with prose or several objects", () => {
  const t = 'Schema: {"action":"trade"|"hold"} ... thinking {not json}. Final: {"action":"hold","reason":"flat {market}"}';
  assert.deepEqual(parseDecision(t), { action: "hold", reason: "flat {market}" });
  assert.equal(parseDecision('{"a":1} {"action":"stake","amount":"5"}')?.action, "stake");
  assert.equal(parseDecision("no json here"), null);
});

test("a receipt signed by a stranger's key verifies only as self-consistent, never when pinned", () => {
  const sk = secp256k1.utils.randomSecretKey();
  const addr = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).subarray(12)).toString("hex");
  const run = JSON.parse(fs.readFileSync(new URL("../../data/quorum-run.json", import.meta.url), "utf8"));
  const real = run.cases[0].votes[0].receipt;
  const text = real.signed_text;
  const msg = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${new TextEncoder().encode(text).length}${text}`);
  const sig = secp256k1.sign(keccak_256(msg), sk, { prehash: false, format: "recovered" });
  // noble returns [recovery, r, s]; receipts are r || s || v.
  const rsv = new Uint8Array(65);
  rsv.set(sig.subarray(1), 0);
  rsv[64] = sig[0] + 27;
  const forged = { ...real, signature: "0x" + Buffer.from(rsv).toString("hex"), signing_address: addr };
  assert.equal(verifyReceipt(forged).ok, true, "self-consistent");
  assert.equal(verifyReceipt(forged, run.attested).ok, false, "but not signed by an attested key");
  assert.equal(verifyReceipt(real, run.attested).ok, true);
});

test("a receipt with no signature does not crash", () => {
  const r = verifyReceipt({ model: "m", chat_id: "x", request: "{}", response: "{}", signed_text: "", signature: "", signing_address: "" });
  assert.equal(r.ok, false);
});

test("the receipt kind comes from the model, not from what the receipt claims", () => {
  const run = JSON.parse(fs.readFileSync(new URL("../../data/quorum-run.json", import.meta.url), "utf8"));
  const ds = run.cases[0].votes[0].receipt;
  // An enclave model's answer dressed up as a gateway receipt (no model prefix) does not verify.
  const hashes = ds.signed_text.split(":").slice(1).join(":");
  assert.equal(verifyReceipt({ ...ds, signed_text: hashes }).kind, "enclave");
  assert.equal(verifyReceipt({ ...ds, signed_text: hashes }).ok, false);
});

test("costBps does not divide by zero", () => {
  assert.equal(costBps({ amountInUsd: "1", amountOutUsd: "1", minAmountOut: "0", amountOut: "0" }), 10_000n);
});

test("stake preflight mirrors stake_idle", () => {
  const s: any = {
    config: { mandate: { tokens: ["pusd.t", "wrap.testnet", "lst.t"], max_trade_bps: 2500, min_seconds_between_trades: 660, max_trades_per_day: 6, subscription_closes_at: 0, staking: { wrap_index: 1, lst_index: 2, min_stake: "1000" } } },
    held: [["pusd.t", "0"], ["wrap.testnet", "10000"], ["lst.t", "0"]],
    pending: null,
    last_trade_at: 0,
    registered: [true, true, true],
    trades_today: 0,
    near_available_for_registrations: "10000000000000000000000",
  };
  assert.deepEqual(preflightStake("2500", s), []);
  assert.match(preflightStake("2600", s).join(), /bps/);
  assert.match(preflightStake("999", s).join(), /minimum/);
  assert.match(preflightStake("1.5", s).join(), /base units/);
  assert.match(preflightStake("2000", { ...s, near_available_for_registrations: "0" }).join(), /NEAR/);
  assert.match(preflightStake("2000", { ...s, config: { mandate: { ...s.config.mandate, staking: null } } }).join(), /no staking route/);
});
