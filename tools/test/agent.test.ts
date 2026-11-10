import { test } from "node:test";
import assert from "node:assert/strict";
import { agree, parseDecision } from "../lib/agent.ts";

const F = "fund.testnet";
const T = (amount: string, recipient = F, sell = "pusd.t", buy = "wrap.testnet") => ({ action: "trade" as const, sell, buy, amount, recipient });
const v = (model: string, decision: any) => ({ model, decision });

test("two models agreeing on a trade: the smallest amount is proposed", () => {
  const r = agree([v("a", T("10000000")), v("b", T("8000000"))], F);
  assert.equal(r.agreed, true);
  assert.equal(r.decision.action, "trade");
  assert.equal(r.decision.amount, "8000000");
});

test("amounts given as JSON numbers (as Gemini does) are accepted", () => {
  const r = agree([v("a", T("8000000")), v("b", { ...T("x"), amount: 5000000 })], F);
  assert.equal(r.decision.amount, "5000000");
});

test("an empty recipient means the fund", () => {
  const r = agree([v("a", T("5", "")), v("b", T("5", F))], F);
  assert.equal(r.decision.action, "trade");
});

test("one model fooled into paying an attacker is not enough", () => {
  const r = agree([v("a", T("100", "attacker.testnet")), v("b", { action: "hold", reason: "suspicious" })], F);
  assert.equal(r.decision.action, "hold");
  assert.match(r.why, /b chose to hold/);
});

test("both trade but to different recipients: hold", () => {
  const r = agree([v("a", T("100", "attacker.testnet")), v("b", T("100"))], F);
  assert.equal(r.decision.action, "hold");
  assert.match(r.why, /recipient/);
});

test("different tokens: hold", () => {
  assert.equal(agree([v("a", T("1")), v("b", T("1", F, "wrap.testnet", "pusd.t"))], F).decision.action, "hold");
});

test("an unusable or zero answer: hold; one model alone is no quorum", () => {
  assert.equal(agree([v("a", T("1")), v("b", null)], F).decision.action, "hold");
  assert.equal(agree([v("a", T("1")), v("b", T("0"))], F).decision.action, "hold");
  assert.equal(agree([v("a", T("1"))], F).decision.action, "hold");
});

test("all holding is an agreed hold", () => {
  const r = agree([v("a", { action: "hold" }), v("b", { action: "hold" })], F);
  assert.equal(r.agreed, true);
  assert.equal(r.decision.action, "hold");
});

test("Gemini-style fenced JSON parses", () => {
  assert.deepEqual(parseDecision('```json\n{"action":"hold","reason":"x"}\n```'), { action: "hold", reason: "x" });
});

import fs from "node:fs";
import { verifyReceipt } from "../lib/nearai.ts";
const qrun = JSON.parse(fs.readFileSync(new URL("../../data/quorum-run.json", import.meta.url), "utf8"));

test("every recorded quorum receipt verifies offline, DeepSeek as enclave and Gemini as gateway", () => {
  for (const c of qrun.cases)
    for (const v of c.votes) {
      const r = verifyReceipt(v.receipt);
      assert.equal(r.ok, true, `${c.label}/${v.model}: ${r.checks.join("; ")}`);
      assert.equal(r.kind, v.model.startsWith("google/") ? "gateway" : "enclave");
    }
});

test("a tampered Gemini response no longer matches its receipt", () => {
  const v = qrun.cases[0].votes.find((x: any) => x.model.startsWith("google/"));
  assert.equal(verifyReceipt({ ...v.receipt, response: v.receipt.response.replace("attacker", "honest") }).ok, false);
});

test("the recorded injected case: Gemini was fooled, the quorum held", () => {
  const c = qrun.cases.find((x: any) => x.label === "injected");
  assert.equal(c.quorum.decision.action, "hold");
  assert.equal(c.accepted, null);
});
