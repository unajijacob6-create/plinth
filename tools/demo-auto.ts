// npm run demo:auto -- [<strategy.json>] [--quote-signer <key>] [--near 0.01] [--as <account>] [--skip-wasm-check]
//
// A fund with no manager on NEAR testnet (release 0.3), recorded to data/auto-run.json.
//
// <strategy.json> (default data/strategy-testnet.json) is {quote_signer, strategy}, or just the
// mandate's `strategy` object: {outlayer, wasm_url, wasm_hash, max_instructions,
// max_execution_seconds, exclusive: true[, secrets_profile, secrets_owner]}. It pins one strategy
// program by its sha256 for the life of the fund. With `exclusive` the operator account cannot
// propose anything; it only receives the management fee (0 here).
//
//   1. the script downloads wasm_url and checks its sha256 against wasm_hash (a mismatch would pin
//      a program OutLayer can never run);
//   2. a keyless fund with that strategy is created by the factory; Alice subscribes;
//   3. after the window closes the operator tries to propose and is rejected (recorded);
//   4. anyone (--as, default bob.<parent>) calls `rebalance` with --near NEAR for the OutLayer run
//      (at least 0.005) and 300 TGas. OutLayer runs the program in a TEE; its answer goes through
//      exactly the checks an operator's proposal does. The decision events and the resulting trade
//      are printed;
//   5. if a swap was sent, the solver stand-in delivers its output (1Click has no testnet).
//
// The quote signer: 1Click has no testnet, so the strategy program signs its testnet quotes with a
// stand-in key, and the fund must be created with that key's public half (`quote_signer` in the
// file, or --quote-signer; without either, this machine's test key). On mainnet a strategy would
// return real 1Click quotes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";
import { parseNear, validateConfig, type Config, type Strategy } from "./lib/config.ts";
process.env.NEAR_NETWORK = "testnet";

plainErrors();
const USAGE = "usage: npm run demo:auto -- [<strategy.json>] [--quote-signer <ed25519 key>] [--near 0.01] [--as <account>] [--skip-wasm-check]";
const DEFAULT_STRATEGY_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data/strategy-testnet.json");
const { a, strategy, strategyFile, fileSigner, deposit } = withUsage(USAGE, () => {
  const a = parseArgs(process.argv.slice(2), { values: ["--near", "--as", "--quote-signer"], switches: ["--skip-wasm-check"] });
  if (a.positionals.length > 1) throw new UsageError("give at most one strategy JSON file");
  const strategyFile = a.positionals[0] ?? DEFAULT_STRATEGY_FILE;
  let strategy: Strategy, fileSigner: string | undefined;
  try {
    const j = JSON.parse(fs.readFileSync(strategyFile, "utf8"));
    // Either {quote_signer, strategy} or the bare strategy object.
    strategy = j?.strategy ?? j;
    fileSigner = j?.strategy ? j.quote_signer : undefined;
  } catch (e) {
    throw new UsageError(`${strategyFile}: ${(e as Error).message}`);
  }
  if (strategy?.exclusive !== true) throw new UsageError("this demo is for a fund with no manager: the strategy must have \"exclusive\": true");
  const deposit = parseNear(a.values["--near"] ?? "0.01");
  if (deposit < 5n * 10n ** 21n) throw new UsageError("--near must be at least 0.005: the contract refuses a strategy run with less attached");
  return { a, strategy, strategyFile, fileSigner, deposit };
});
const { view, accountExists, accessKeyCount, accountView, chainSeconds, call, callLong, returned, failure, logsOf, NEAR, formatNear, explorer, txHash, log } = await import("./lib/near.ts");
const { ROOT, factoryFor, createFund, fundState, tradeById, plinthEvents, waitForChainTime } = await import("./lib/fund.ts");
const { testSigner } = await import("./lib/testsigner.ts");
const { deliver } = await import("./lib/solver.ts");

const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const TOKEN = `pusd.${PARENT}`, WRAP = "wrap.testnet";
const ALICE = `alice.${PARENT}`, OPERATOR = `operator.${PARENT}`, SOLVER = `solver.${PARENT}`;
const CALLER = a.values["--as"] ?? `bob.${PARENT}`;
const STORAGE = 1_250_000_000_000_000_000_000n;
const FACTORY = factoryFor("testnet");
const QUOTE_SIGNER = a.values["--quote-signer"] ?? fileSigner ?? testSigner().public_key;
const run: any = { network: "testnet", started_at: new Date().toISOString(), strategy_file: path.relative(ROOT, strategyFile), quote_signer: QUOTE_SIGNER, accounts: { parent: PARENT, token: TOKEN, wrap: WRAP, alice: ALICE, operator: OPERATOR, solver: SOLVER, caller: CALLER, factory: FACTORY }, strategy, tx: {} };
const step = async (key: string, sent: Promise<any>) => {
  const r = await sent;
  run.tx[key] = txHash(r);
  log(key, explorer(run.tx[key]));
  return r;
};

// ---------------------------------------------------------------- the strategy program
for (const id of [PARENT, TOKEN, ALICE, OPERATOR, SOLVER, CALLER]) if (!(await accountExists(id))) throw new Error(`${id} does not exist on testnet; run \`npm run demo:testnet\` first (it creates the demo accounts)`);
if (!(await accountExists(strategy.outlayer))) throw new Error(`strategy.outlayer ${strategy.outlayer} does not exist on testnet`);
if (a.switches.has("--skip-wasm-check")) {
  run.strategy_wasm_check = "skipped (--skip-wasm-check)";
} else {
  const res = await fetch(strategy.wasm_url);
  if (!res.ok) throw new Error(`could not download ${strategy.wasm_url}: HTTP ${res.status} (use --skip-wasm-check to create the fund without this check)`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== strategy.wasm_hash) throw new Error(`${strategy.wasm_url} hashes to ${got}, not the wasm_hash ${strategy.wasm_hash}: OutLayer would never run it`);
  run.strategy_wasm_check = { bytes: bytes.length, sha256: got };
  log("strategy wasm", `${bytes.length} bytes, sha256 matches wasm_hash`);
}

// ---------------------------------------------------------------- the fund
const close = (await chainSeconds()) + 90;
const config: Config = {
  mandate: {
    tokens: [TOKEN, WRAP],
    max_trade_bps: 2500,
    max_cost_bps: 150,
    min_seconds_between_trades: 660,
    max_trades_per_day: 6,
    max_quote_age_seconds: 300,
    min_deadline_margin_seconds: 600,
    subscription_closes_at: close,
    min_subscription: "1000000",
    max_total_subscriptions: "1000000000",
    management_fee_bps: 0,
    staking: null,
    open_ended: false,
    strategy,
  },
  operator: OPERATOR,
  quote_signer: QUOTE_SIGNER,
  storage_deposit: String(STORAGE),
};
const name = `auto-${Date.now().toString(36)}`;
const problems = validateConfig(config, `${name}.${FACTORY}`, await chainSeconds());
if (problems.length) throw new Error(`the contract would refuse this fund:\n  - ${problems.join("\n  - ")}`);
run.config = config;
const created = await createFund({ from: PARENT, factory: FACTORY, name, config, near: NEAR(1) });
const fund = created.fund;
run.fund = fund;
run.tx.create_fund_keyless = created.tx;
run.created = created;
log("create_fund_keyless", `${fund} ${explorer(created.tx)}; access keys ${created.access_keys}`);

if ((await view(TOKEN, "storage_balance_of", { account_id: ALICE })) === null) await step("register_alice_pusd", call(ALICE, TOKEN, "storage_deposit", { registration_only: true }, { deposit: STORAGE, gas: 30 }));
const have = BigInt(await view<string>(TOKEN, "ft_balance_of", { account_id: ALICE }));
if (have < 60_000_000n) await step("mint_alice", call(PARENT, TOKEN, "mint", { account_id: ALICE, amount: String(60_000_000n - have) }, { gas: 30 }));
await step("alice_subscribe", call(ALICE, TOKEN, "ft_transfer_call", { receiver_id: fund, amount: "60000000", msg: "" }, { deposit: 1n, gas: 150 }));
run.after_subscribe = await fundState(fund);
await waitForChainTime(close + 2);

// ---------------------------------------------------------------- the operator cannot propose
{
  const r = await step("operator_propose_rejected", call(OPERATOR, fund, "propose_trade", { quote: "{}" }, { gas: 100, allowFailure: true }));
  run.operator_propose_failed = failure(r);
  if (!run.operator_propose_failed) throw new Error("the operator's propose_trade was not rejected on a strategy-only fund");
  log("operator cannot propose", run.operator_propose_failed.slice(0, 160));
}

// ---------------------------------------------------------------- anyone calls rebalance
const callerBefore = BigInt((await accountView(CALLER)).amount);
// The transaction finishes when OutLayer has run the program and the fund has acted on its answer.
const r = await step("rebalance", callLong(CALLER, fund, "rebalance", {}, { deposit, gas: 300, allowFailure: true }));
run.rebalance = {
  by: CALLER,
  attached_near: formatNear(deposit),
  failed: failure(r),
  /** on_strategy's return value: "trade", "stake", "refused" or "hold". */
  result: returned<string>(r),
  events: plinthEvents(r),
  logs: logsOf(r),
  caller_paid_near: formatNear(callerBefore - BigInt((await accountView(CALLER)).amount)),
};
for (const e of run.rebalance.events) console.log(`event ${e.event}: ${JSON.stringify(e.data)}`);
log("rebalance", `${run.rebalance.failed ? `FAILED ${run.rebalance.failed}` : `-> ${run.rebalance.result}`}; ${CALLER} paid ${run.rebalance.caller_paid_near} NEAR in total`);

// ---------------------------------------------------------------- what the fund did with the answer
let state = await fundState(fund);
run.after_rebalance = state;
if (state.rejections) run.rejections = await view(fund, "get_rejections", { from: 0, limit: 10 });
if (state.trades > 0) {
  const t = (await tradeById(fund, state.trades - 1))!;
  run.trade = t;
  console.log(`trade ${t.id}: ${t.stake ? "stake" : "swap"} ${t.amount_in} of ${config.mandate.tokens[t.sell]} -> ${config.mandate.tokens[t.buy]}, status ${t.status}`);
  if (!t.stake && t.status === "Sent") {
    // The solver pushes the quoted output with msg "trade:<id>"; the trade settles in that transfer.
    const d = await deliver({ solver: SOLVER, fund, token: config.mandate.tokens[t.buy], amount: BigInt(t.quoted_out), tradeId: t.id });
    run.tx.solver_delivers = d.tx;
    run.trade = d.trade;
    run.settle_status = d.trade.status;
    state = await fundState(fund);
  }
}
run.after = state;
run.access_keys_at_end = await accessKeyCount(fund);
run.global_contract_hash = (await accountView(fund)).global_contract_hash ?? null;
run.finished_at = new Date().toISOString();
fs.writeFileSync(path.join(ROOT, "data/auto-run.json"), JSON.stringify(run, null, 1));
log("done", { fund, rebalance: run.rebalance.failed ? "failed" : run.rebalance.result, trade: run.trade ? `${run.trade.id} ${run.trade.status}` : "none", keys: run.access_keys_at_end });
