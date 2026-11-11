// The fund config builder and its validation (tools/lib/config.ts), which mirrors `new()` in
// contracts/plinth/src/lib.rs and `create_fund` in contracts/factory/src/lib.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { parseArgs, UsageError } from "../lib/args.ts";
import { CONFIG_SWITCH_FLAGS, CONFIG_VALUE_FLAGS, MIN_FUND_NEAR, configFromFlags, creationDeposit, normaliseConfig, parseCloses, parseNear, validateConfig, validateFundName, type Config, type ConfigEnv } from "../lib/config.ts";
import { ONECLICK_KEY } from "../lib/oneclick.ts";

const NOW = 1_800_000_000;
const FUND = "alpha.funds.testnet";
const TEST_KEY = `ed25519:${bs58.encode(ed25519.getPublicKey(Buffer.from("09".repeat(32), "hex")))}`;
const env = (network: "testnet" | "mainnet" = "testnet", files: Record<string, string> = {}): ConfigEnv => ({
  network,
  nowS: NOW,
  readFile: (f) => {
    if (!(f in files)) throw new Error(`ENOENT: ${f}`);
    return files[f];
  },
  testSignerKey: () => TEST_KEY,
});
const flags = (argv: string[]) => parseArgs(argv, { values: CONFIG_VALUE_FLAGS, switches: CONFIG_SWITCH_FLAGS });
const BASE = ["--tokens", "usdc.t,wrap.testnet,lst.t", "--operator", "op.testnet", "--closes", "+3600", "--min-subscription", "1000000", "--max-subscriptions", "1000000000"];
const STRATEGY = { outlayer: "outlayer.testnet", wasm_url: "https://example.org/strategy.wasm", wasm_hash: "ab".repeat(32), max_instructions: 10_000_000_000, max_execution_seconds: 60, exclusive: true };
const good = (): Config => configFromFlags(flags(BASE), env());

test("flags build a complete config with the documented defaults", () => {
  const c = good();
  assert.deepEqual(c, {
    mandate: {
      tokens: ["usdc.t", "wrap.testnet", "lst.t"],
      max_trade_bps: 2500,
      max_cost_bps: 150,
      min_seconds_between_trades: 660,
      max_trades_per_day: 6,
      max_quote_age_seconds: 300,
      min_deadline_margin_seconds: 600,
      subscription_closes_at: NOW + 3600,
      min_subscription: "1000000",
      max_total_subscriptions: "1000000000",
      management_fee_bps: 0,
      staking: null,
      open_ended: false,
      strategy: null,
    },
    operator: "op.testnet",
    quote_signer: TEST_KEY,
    storage_deposit: "1250000000000000000000",
  });
  assert.deepEqual(validateConfig(c, FUND, NOW), []);
});

test("--open-ended, --fee-bps, --staking and --strategy-json reach the mandate", () => {
  const c = configFromFlags(flags([...BASE, "--open-ended", "--fee-bps", "100", "--staking", "1:2", "--strategy-json", "s.json"]), env("testnet", { "s.json": JSON.stringify(STRATEGY) }));
  assert.equal(c.mandate.open_ended, true);
  assert.equal(c.mandate.management_fee_bps, 100);
  assert.deepEqual(c.mandate.staking, { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price", min_stake: "1000000000000000000000000", max_price_slippage_bps: 50 });
  assert.deepEqual(c.mandate.strategy, STRATEGY);
  assert.deepEqual(validateConfig(c, FUND, NOW), []);
  // The full staking route as JSON text or as a file.
  const route = { wrap_index: 1, lst_index: 2, price_method: "price", min_stake: "5", max_price_slippage_bps: 10 };
  assert.deepEqual(configFromFlags(flags([...BASE, "--staking", JSON.stringify(route)]), env()).mandate.staking, route);
  assert.deepEqual(configFromFlags(flags([...BASE, "--staking", "route.json"]), env("testnet", { "route.json": JSON.stringify(route) })).mandate.staking, route);
});

test("the quote signer defaults to 1Click on mainnet and the test key on testnet; a test key is refused on mainnet", () => {
  assert.equal(configFromFlags(flags(BASE), env("mainnet")).quote_signer, ONECLICK_KEY);
  assert.equal(configFromFlags(flags(BASE), env("testnet")).quote_signer, TEST_KEY);
  assert.equal(configFromFlags(flags([...BASE, "--quote-signer", "oneclick"]), env("testnet")).quote_signer, ONECLICK_KEY);
  assert.throws(() => configFromFlags(flags([...BASE, "--quote-signer", "test"]), env("mainnet")), UsageError);
});

test("missing and malformed flags are usage errors that name the flag", () => {
  for (const drop of ["--tokens", "--operator", "--closes", "--min-subscription", "--max-subscriptions"]) {
    const i = BASE.indexOf(drop);
    assert.throws(() => configFromFlags(flags([...BASE.slice(0, i), ...BASE.slice(i + 2)]), env()), new RegExp(`${drop} is required`));
  }
  assert.throws(() => configFromFlags(flags([...BASE, "--fee-bps", "1.5"]), env()), /--fee-bps 1.5/);
  assert.throws(() => configFromFlags(flags([...BASE, "--strategy-json", "missing.json"]), env()), /--strategy-json missing.json: ENOENT/);
  assert.throws(() => configFromFlags(flags([...BASE, "--strategy-json", "bad.json"]), env("testnet", { "bad.json": "{nope" })), /--strategy-json bad.json/);
  assert.throws(() => configFromFlags(flags([...BASE, "--staking", "{bad"]), env()), /--staking/);
  assert.throws(() => configFromFlags(flags(BASE.map((x) => (x === "1000000" ? "1e6" : x))), env()), /--min-subscription 1e6/);
});

test("--closes takes an ISO date, a date-time or +seconds", () => {
  assert.equal(parseCloses("+90", NOW), NOW + 90);
  assert.equal(parseCloses("2027-01-15", NOW), Date.UTC(2027, 0, 15) / 1000);
  assert.equal(parseCloses("2027-01-15T12:30:00Z", NOW), Date.UTC(2027, 0, 15, 12, 30) / 1000);
  assert.equal(parseCloses("2027-01-15T12:30:00", NOW), Date.UTC(2027, 0, 15, 12, 30) / 1000, "no zone means UTC");
  assert.equal(parseCloses("2027-01-15T12:30:00+02:00", NOW), Date.UTC(2027, 0, 15, 10, 30) / 1000);
  for (const bad of ["tomorrow", "15/01/2027", "+1h", "2027-13-45", ""]) assert.throws(() => parseCloses(bad, NOW), UsageError, bad);
});

test("validation repeats every rule of the contract's new()", () => {
  const bad = (edit: (c: any) => void, why: RegExp) => {
    const c: any = structuredClone(good());
    edit(c);
    const got = validateConfig(c, FUND, NOW);
    assert.equal(got.length > 0 && why.test(got.join("\n")), true, `${why}: got ${JSON.stringify(got)}`);
  };
  bad((c) => (c.mandate.tokens = []), /1 to 4/);
  bad((c) => (c.mandate.tokens = ["a.t", "b.t", "c.t", "d.t", "e.t"]), /1 to 4/);
  bad((c) => (c.mandate.tokens = ["usdc.t", "usdc.t"]), /duplicate/);
  bad((c) => (c.mandate.tokens = ["usdc.t", FUND]), /cannot list itself/);
  bad((c) => (c.mandate.tokens = ["USDC.t"]), /not a NEAR account id/);
  bad((c) => (c.mandate.max_trade_bps = 0), /max_trade_bps/);
  bad((c) => (c.mandate.max_trade_bps = 10_001), /max_trade_bps/);
  bad((c) => (c.mandate.max_cost_bps = 10_001), /max_cost_bps/);
  bad((c) => (c.mandate.max_quote_age_seconds = 0), /max_quote_age_seconds/);
  bad((c) => (c.mandate.min_seconds_between_trades = 659), /at least 660/);
  bad((c) => (c.mandate.max_trades_per_day = 0), /max_trades_per_day/);
  bad((c) => (c.mandate.subscription_closes_at = NOW), /in the future/);
  bad((c) => (c.mandate.min_subscription = "0"), /subscription limits/);
  bad((c) => (c.mandate.min_subscription = "2000000000"), /subscription limits/);
  bad((c) => (c.mandate.min_subscription = 1000000), /digit strings/);
  bad((c) => (c.mandate.management_fee_bps = 201), /management_fee_bps/);
  bad((c) => (c.operator = FUND), /own operator/);
  bad((c) => (c.operator = "Bad Account"), /operator/);
  bad((c) => (c.quote_signer = "ed25519:abc"), /quote_signer/);
  bad((c) => (c.storage_deposit = 1250), /storage_deposit/);
  // Staking route.
  const route = { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price", min_stake: "1", max_price_slippage_bps: 50 };
  bad((c) => (c.mandate.staking = { ...route, lst_index: 1 }), /staking token indices/);
  bad((c) => (c.mandate.staking = { ...route, lst_index: 3 }), /staking token indices/);
  bad((c) => (c.mandate.staking = { ...route, price_method: "" }), /price_method/);
  bad((c) => (c.mandate.staking = { ...route, max_price_slippage_bps: 0 }), /1\.\.=500/);
  bad((c) => (c.mandate.staking = { ...route, max_price_slippage_bps: 501 }), /1\.\.=500/);
  // Strategy.
  bad((c) => (c.mandate.strategy = { ...STRATEGY, wasm_url: "http://example.org/s.wasm" }), /https/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, wasm_hash: "AB".repeat(32) }), /lowercase hex/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, wasm_hash: "ab".repeat(31) }), /lowercase hex/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, max_instructions: 0 }), /max_instructions/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, max_execution_seconds: 121 }), /1\.\.=120/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, secrets_profile: "default" }), /both a profile and an owner/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, outlayer: FUND }), /cannot be the fund/);
  bad((c) => (c.mandate.strategy = { ...STRATEGY, exclusive: "yes" }), /exclusive must be true or false/);
});

test("a missing optional field is fine once normalised; a misspelt field is reported", () => {
  const c: any = structuredClone(good());
  delete c.mandate.strategy;
  delete c.mandate.staking;
  delete c.mandate.open_ended;
  delete c.mandate.management_fee_bps;
  assert.deepEqual(validateConfig(normaliseConfig(c), FUND, NOW), []);
  // The contract would ignore these silently and launch a fund without the option.
  const typo: any = structuredClone(good());
  typo.mandate.open_endded = true;
  typo.mandate.strategy = { ...STRATEGY, exclusiv: true };
  typo.quote_signr = "x";
  const got = validateConfig(typo, FUND, NOW).join("\n");
  assert.match(got, /mandate\.open_endded is not a field/);
  assert.match(got, /strategy\.exclusiv is not a field/);
  assert.match(got, /config\.quote_signr is not a field/);
  assert.deepEqual(validateConfig(null, FUND, NOW).length, 1);
});

test("a strategy with both secrets fields is valid", () => {
  const c: any = structuredClone(good());
  c.mandate.strategy = { ...STRATEGY, secrets_profile: "default", secrets_owner: "owner.testnet" };
  assert.deepEqual(validateConfig(c, FUND, NOW), []);
});

test("fund names follow the factory's rule", () => {
  for (const ok of ["ab", "open-3", "a1", "x".repeat(32)]) assert.deepEqual(validateFundName(ok, "funds.testnet"), [], ok);
  for (const bad of ["a", "-ab", "ab-", "Ab", "a.b", "a_b", "x".repeat(33), ""]) assert.equal(validateFundName(bad, "funds.testnet").length, 1, bad);
  // Within the factory's rule but not a NEAR account id.
  assert.match(validateFundName("a--b", "funds.testnet").join(), /valid account id/);
  assert.match(validateFundName("x".repeat(32), "a-very-long-factory-account-name.testnet").join(), /valid account id/);
});

test("the creation deposit is the fund's NEAR, one registration per token and the list fee; at least 0.5 NEAR for the fund", () => {
  const c = good();
  assert.deepEqual(creationDeposit(c, parseNear("1")), { registrations: 3_750_000_000_000_000_000_000n, listFee: 3_000_000_000_000_000_000_000n, total: 1_006_750_000_000_000_000_000_000n });
  // The factory's minimum: 0.503 NEAR plus storage_deposit per token.
  assert.deepEqual(creationDeposit(c, MIN_FUND_NEAR).total, parseNear("0.503") + 3_750_000_000_000_000_000_000n);
  assert.throws(() => creationDeposit(c, MIN_FUND_NEAR - 1n), /at least 0\.5 NEAR/);
  assert.equal(parseNear("0.75"), 750_000_000_000_000_000_000_000n);
  assert.equal(parseNear("0.000000000000000000000001"), 1n);
  for (const bad of ["1,5", "-1", "1e3", "", "0.0000000000000000000000001"]) assert.throws(() => parseNear(bad), UsageError, bad);
});
