import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifySignature, signedMessage, costBps, type QuoteResponse } from "../lib/oneclick.ts";

const live = JSON.parse(fs.readFileSync(new URL("../../contracts/plinth/tests/fixtures/quote_live.json", import.meta.url), "utf8")) as QuoteResponse;
const dry = JSON.parse(fs.readFileSync(new URL("../../contracts/plinth/tests/fixtures/quote_dry.json", import.meta.url), "utf8")) as QuoteResponse;

test("a real live 1Click quote verifies against the production key", () => {
  assert.equal(verifySignature(live), true);
});

test("a real dry quote verifies too (deposit fields excluded)", () => {
  assert.equal(verifySignature(dry), true);
});

test("editing the deposit address, amount or refund target breaks the signature", () => {
  for (const edit of [
    (r: any) => (r.quote.depositAddress = "attacker.near"),
    (r: any) => (r.quoteRequest.amount = "30000000"),
    (r: any) => (r.quoteRequest.refundTo = "evil.near"),
    (r: any) => (r.quote.minAmountOut = "1"),
  ]) {
    const r = structuredClone(live);
    edit(r);
    assert.equal(verifySignature(r), false);
  }
});

test("the request deadline is overridden by quote.deadline in live quotes (JS spread), like the SDK", () => {
  const r = structuredClone(live) as any;
  const a = signedMessage(r.quoteRequest, r.quote, r.timestamp);
  r.quoteRequest.deadline = "2030-01-01T00:00:00.000Z";
  assert.equal(signedMessage(r.quoteRequest, r.quote, r.timestamp), a);
});

test("cost formula matches the contract on the fixture", () => {
  // in 2.998482, out 2.995731 * 2967275/2997248 = 2.965773 -> 109 bps (floor)
  assert.equal(costBps(live.quote as any), 109n);
});
