// Release 0.3, tools side: the delivery message in quotes, the preflight for the new contract rule,
// the test-signer pricing and the command-line parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { ONECLICK_KEY, ed25519KeyBytes, preflight, preflightStake, requestQuote, sameEd25519Key, signedMessage, tradeMsg, verifySignature, type FundState, type QuoteResponse } from "../lib/oneclick.ts";
import { testQuote } from "../lib/testsigner.ts";
import { describeTestPrices, testFill, type TestPrices } from "../lib/testprices.ts";
import { parseArgs, UsageError } from "../lib/args.ts";

// A fixed test key, so the tests never touch ~/.near-credentials.
const SECRET = "09".repeat(32);
const PUBLIC = `ed25519:${bs58.encode(ed25519.getPublicKey(Buffer.from(SECRET, "hex")))}`;
const FUND = "fund-a.funds.testnet", RELAY = "fund-a-r.funds.testnet", PUSD = "pusd.t", WRAP = "wrap.testnet";
const NOW = 1_800_000_000;

const quote = (o: Partial<Parameters<typeof testQuote>[0]> = {}): QuoteResponse =>
  JSON.parse(testQuote({ fund: FUND, refundRelay: RELAY, tradeId: 3, sell: PUSD, buy: WRAP, amount: 10_000_000n, out: 20_000_000_000_000_000_000_000n, minOut: 19_900_000_000_000_000_000_000n, inUsd: "10.000000", outUsd: "9.980000", deposit: "d".repeat(64), secretHex: SECRET, issuedAt: NOW - 5, ...o }));

const state = (o: Partial<FundState> = {}): FundState => ({
  config: {
    operator: "op.testnet",
    quote_signer: PUBLIC,
    refund_relay: RELAY,
    mandate: { tokens: [PUSD, WRAP], max_trade_bps: 2500, max_cost_bps: 150, min_seconds_between_trades: 660, max_trades_per_day: 6, max_quote_age_seconds: 300, min_deadline_margin_seconds: 600, subscription_closes_at: NOW - 100 },
    storage_deposit: "1250000000000000000000",
  },
  held: [[PUSD, "100000000"], [WRAP, "0"]],
  pending: null,
  trades: 3,
  last_trade_at: 0,
  registered: [true, true],
  trades_today: 0,
  near_available_for_registrations: "400000000000000000000000",
  version: "0.3.0",
  ...o,
});

// ---------------------------------------------------------------- customRecipientMsg in the signed message

test("a quote with customRecipientMsg signed by the test signer verifies with the TS verifier", () => {
  const q = quote();
  assert.equal((q.quoteRequest as any).customRecipientMsg, "trade:3");
  assert.equal(verifySignature(q, PUBLIC), true);
  // The message is signed: changing the trade id, or dropping the field, breaks the signature.
  const other = structuredClone(q) as any;
  other.quoteRequest.customRecipientMsg = "trade:4";
  assert.equal(verifySignature(other, PUBLIC), false);
  const dropped = structuredClone(q) as any;
  delete dropped.quoteRequest.customRecipientMsg;
  assert.equal(verifySignature(dropped, PUBLIC), false);
});

test("the signed message equals what contracts/plinth/src/quote.rs builds for the same quote", () => {
  // Expected values printed by quote::signed_message (the contract's own function, built natively
  // against contracts/plinth) for exactly these inputs.
  const req = {
    dry: false, depositMode: "SIMPLE", swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: "nep141:pusd.t", depositType: "ORIGIN_CHAIN", destinationAsset: "nep141:wrap.testnet",
    amount: "10000000", refundTo: "fund.t", refundType: "ORIGIN_CHAIN", recipient: "fund.t", recipientType: "DESTINATION_CHAIN", deadline: "2026-11-10T00:10:00.000Z", quoteWaitingTimeMs: 0,
    customRecipientMsg: "trade:7",
  };
  const q = {
    amountIn: "10000000", amountInFormatted: "", amountInUsd: "10.000000", minAmountIn: "10000000", amountOut: "20000000000000000000000", amountOutFormatted: "", amountOutUsd: "9.980000",
    minAmountOut: "19900000000000000000000", timeEstimate: 20, refundFee: "4500", deadline: "2026-11-13T00:00:00.000Z", timeWhenInactive: "2026-11-13T00:00:00.000Z", depositAddress: "dddd",
  };
  const ts = "2026-11-10T00:00:00.000Z";
  assert.equal(signedMessage(req, q, ts), "5UtcnE9D7cAajxgoiPN6nQPBgbj2MVfVdX47Lf8GJWNU");
  // Same field rule as quote.rs: the field is in the message only when truthy.
  const { customRecipientMsg: _, ...without } = req;
  assert.equal(signedMessage(without, q, ts), "hg4DxL2TTrxKfMMPvTu74gJedrTTaSqWbt3YjESSorK");
  assert.equal(signedMessage({ ...req, customRecipientMsg: "" }, q, ts), "hg4DxL2TTrxKfMMPvTu74gJedrTTaSqWbt3YjESSorK");
});

test("a real 1Click dry quote carrying customRecipientMsg verifies against the production key", () => {
  // Fetched from 1click.chaindefuser.com on 2026-11-10 with customRecipientMsg "trade:0".
  const real = JSON.parse(fs.readFileSync(new URL("./fixtures/quote_dry_custom_msg.json", import.meta.url), "utf8")) as QuoteResponse;
  assert.equal((real.quoteRequest as any).customRecipientMsg, "trade:0");
  assert.equal(verifySignature(real, ONECLICK_KEY), true);
  const edited = structuredClone(real) as any;
  edited.quoteRequest.customRecipientMsg = "trade:1";
  assert.equal(verifySignature(edited, ONECLICK_KEY), false, "1Click signs the delivery message");
});

test("requestQuote sends customRecipientMsg for the trade id, the fund as recipient and its relay as refund address", async () => {
  const real = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ quote: {}, quoteRequest: body, signature: "", timestamp: "" }), { status: 201 });
  }) as typeof fetch;
  try {
    await requestQuote({ fund: FUND, refundRelay: RELAY, sellToken: PUSD, buyToken: WRAP, amount: "5", tradeId: 12, dry: true });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(body.customRecipientMsg, "trade:12");
  assert.equal(body.recipient, FUND);
  assert.equal(body.refundTo, RELAY, "1Click refunds to the relay, never to the fund itself");
  assert.equal(body.dry, true);
});

test("tradeMsg refuses anything that is not a trade id", () => {
  assert.equal(tradeMsg(0), "trade:0");
  assert.equal(tradeMsg("17"), "trade:17");
  for (const bad of [-1, 1.5, "x", "", NaN]) assert.throws(() => tradeMsg(bad as any), /trade id/);
});

// ---------------------------------------------------------------- preflight mirrors the contract's new check

test("preflight accepts a quote whose delivery message names the fund's next trade id", () => {
  assert.deepEqual(preflight(quote(), FUND, state(), NOW), []);
});

test("preflight refuses a missing, empty or wrong delivery message, as the contract does", () => {
  const want = /customRecipientMsg to "trade:3"/;
  assert.match(preflight(quote({ customRecipientMsg: null }), FUND, state(), NOW).join(), want);
  assert.match(preflight(quote({ customRecipientMsg: "" }), FUND, state(), NOW).join(), want);
  assert.match(preflight(quote({ customRecipientMsg: "trade:03" }), FUND, state(), NOW).join(), want);
  assert.match(preflight(quote({ customRecipientMsg: "donate" }), FUND, state(), NOW).join(), want);
  // A quote made for trade 3 is stale once another trade (or stake) has taken that id.
  assert.match(preflight(quote(), FUND, state({ trades: 4 }), NOW).join(), /customRecipientMsg to "trade:4"/);
  assert.match(preflight(quote({ tradeId: 2 }), FUND, state(), NOW).join(), want);
  // Each of those is the only reason given.
  assert.equal(preflight(quote({ customRecipientMsg: null }), FUND, state(), NOW).length, 1);
});

test("preflight says nothing about settle and still makes the other checks", () => {
  assert.match(preflight(quote({ recipient: "op.testnet" }), FUND, state(), NOW).join(), /deliver to the fund and refund to its relay/);
  assert.match(preflight(quote({ amount: 30_000_000n }), FUND, state(), NOW).join(), /2500 bps/);
  assert.match(preflight(quote(), FUND, state({ pending: { id: 2 } as any }), NOW).join(), /in flight/);
  assert.match(preflight(quote({ secretHex: "07".repeat(32) }), FUND, state(), NOW).join(), /signature/);
  assert.match(preflight(quote(), FUND, state({ trades: undefined as any }), NOW).join(), /trade count/);
  // The contract refuses a deposit deadline more than 14 days ahead; test quotes use 3 days.
  const far = quote() as any;
  far.quote.deadline = new Date((NOW + 14 * 86_400 + 1) * 1000).toISOString();
  assert.match(preflight(far, FUND, state(), NOW).filter((r) => !/signature/.test(r)).join(), /^the quote's deadline is more than 14 days away$/);
  for (const s of [state(), state({ trades: 9 })]) assert.doesNotMatch(preflight(quote(), FUND, s, NOW).join(), /settle/);
});

test("a fund with an exclusive strategy takes no operator proposal or stake", () => {
  const s = state();
  s.config.mandate.strategy = { outlayer: "outlayer.testnet", wasm_url: "https://x/y.wasm", wasm_hash: "a".repeat(64), max_instructions: 1, max_execution_seconds: 1, exclusive: true };
  assert.match(preflight(quote(), FUND, s, NOW).join(), /no manager/);
  assert.match(preflightStake("1", s as any, NOW).join(), /no manager/);
  s.config.mandate.strategy.exclusive = false;
  assert.deepEqual(preflight(quote(), FUND, s, NOW), []);
});

test("preflight requires the refund address to be the fund's relay", () => {
  const want = /refund to its relay fund-a-r\.funds\.testnet/;
  // Release 0.2 quotes refunded to the fund itself: now refused (a plain refund there is never counted).
  assert.match(preflight(quote({ refundTo: FUND }), FUND, state(), NOW).join(), want);
  assert.match(preflight(quote({ refundTo: "op.testnet" }), FUND, state(), NOW).join(), want);
  assert.equal(preflight(quote({ refundTo: FUND }), FUND, state(), NOW).length, 1);
  // The relay is read from the fund's own config, not assumed from its name.
  const other = state();
  other.config.refund_relay = "elsewhere.testnet";
  assert.match(preflight(quote(), FUND, other, NOW).join(), /refund to its relay elsewhere\.testnet/);
  assert.deepEqual(preflight(quote({ refundRelay: "elsewhere.testnet" }), FUND, other, NOW), []);
  const none = state();
  delete none.config.refund_relay;
  assert.match(preflight(quote(), FUND, none, NOW).join(), /no refund relay/);
});

// ---------------------------------------------------------------- quote signer comparison (keys with and without the prefix)

test("ed25519 keys compare by their bytes, with or without the ed25519: prefix", () => {
  const bare = ONECLICK_KEY.replace("ed25519:", "");
  assert.equal(sameEd25519Key(bare, ONECLICK_KEY), true);
  assert.equal(sameEd25519Key(ONECLICK_KEY, ONECLICK_KEY), true);
  assert.equal(sameEd25519Key(PUBLIC, ONECLICK_KEY), false);
  assert.equal(sameEd25519Key("not a key", "not a key"), false, "two unreadable keys are not the same key");
  assert.equal(sameEd25519Key(undefined, ONECLICK_KEY), false);
  assert.equal(ed25519KeyBytes("ed25519:abc"), null);
  assert.equal(ed25519KeyBytes(bare)?.length, 32);
});

// ---------------------------------------------------------------- test prices for --test-signer

const PRICES: TestPrices = { spread_bps: 20, tokens: { [PUSD]: { decimals: 6, usd: "1" }, [WRAP]: { decimals: 24, usd: "500" } } };

test("test fills follow the stated prices and stay inside a 150 bps cost cap", () => {
  const f = testFill(PRICES, PUSD, WRAP, 10_000_000n); // 10 pUSD at $500 per wNEAR, 20 bps spread
  assert.equal(f.out, 19_960_000_000_000_000_000_000n);
  assert.equal(f.minOut, (f.out * 995n) / 1000n);
  assert.equal(f.inUsd, "10.000000");
  assert.equal(f.outUsd, "9.980000");
  const back = testFill(PRICES, WRAP, PUSD, 10n ** 24n); // 1 wNEAR
  assert.equal(back.out, 499_000_000n);
  assert.equal(back.inUsd, "500.000000");
  // The quote built from a fill passes the preflight, cost check included.
  const q = quote({ ...f });
  assert.deepEqual(preflight(q, FUND, state(), NOW), []);
  assert.match(describeTestPrices(PRICES, [PUSD, WRAP]), /TEST PRICES/);
});

test("test fills refuse tokens without a stated price", () => {
  assert.throws(() => testFill(PRICES, PUSD, "lst.t", 1n), /no entry for lst.t/);
  assert.throws(() => testFill(PRICES, PUSD, PUSD, 1n), /itself/);
  assert.throws(() => testFill({ ...PRICES, tokens: { ...PRICES.tokens, [WRAP]: { decimals: 24, usd: "0" } } }, PUSD, WRAP, 1n), /more than 0/);
  assert.throws(() => describeTestPrices(PRICES, ["lst.t"]), /no entry/);
});

// ---------------------------------------------------------------- command-line flags

test("unknown flags, repeated flags and missing values are errors, not ignored", () => {
  const spec = { values: ["--fund", "--amount"], switches: ["--send"] };
  const a = parseArgs(["status", "--fund", "f.testnet", "--send"], spec);
  assert.deepEqual([a.positionals, a.values, [...a.switches]], [["status"], { "--fund": "f.testnet" }, ["--send"]]);
  assert.throws(() => parseArgs(["--sned"], spec), UsageError);
  assert.throws(() => parseArgs(["--fund"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--fund", "--send"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--fund", "a", "--fund", "b"], spec), /twice/);
});
