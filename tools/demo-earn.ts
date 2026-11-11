// npm run demo:earn: earning on NEAR testnet (release 0.3) with the real Meta Pool and wrap
// contracts, recorded to data/earn-run.json.
//
//   1. a keyless fund, created by the factory, with a staking route (wNEAR -> Meta Pool stNEAR) and
//      a 1%/yr management fee;
//   2. Alice subscribes test dollars;
//   3. the operator buys wNEAR with a 1Click-format quote (test signer; 1Click has no testnet) and
//      the solver pushes the output (ft_transfer_call "trade:0"), which settles the trade;
//   4. after the cooldown the operator stakes wNEAR into meta-v2.pool.testnet AT PAR (stake_idle):
//      the contract unwraps it, reads the stNEAR price, calls deposit_and_stake itself and counts
//      the amount that call returns. The stake settles inside its own transaction;
//   5. Alice exits part in kind, stNEAR included; the operator's fee shares accrue.
// Funding: PLINTH_PARENT (default plinthfund.testnet) must hold about 1.5 NEAR for the fund; the
// solver needs about 5 NEAR to deliver the wNEAR (both topped up from the testnet faucet if needed).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair, actions } from "near-api-js";
process.env.NEAR_NETWORK = "testnet";
const { signer, view, rpc, call: sendCall, returned, NEAR, explorer, txHash, log } = await import("./lib/near.ts");
const { testQuote, testSigner } = await import("./lib/testsigner.ts");
const { ROOT, factoryFor, createFund, fundState, tradeById, waitForChainTime } = await import("./lib/fund.ts");
const { deliver } = await import("./lib/solver.ts");
type Config = import("./lib/config.ts").Config;

const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const TOKEN = `pusd.${PARENT}`, WRAP = "wrap.testnet", LST = "meta-v2.pool.testnet";
const ALICE = `alice.${PARENT}`, OPERATOR = `operator.${PARENT}`, SOLVER = `solver.${PARENT}`;
const STORAGE = 1_250_000_000_000_000_000_000n;
const FACTORY = factoryFor("testnet");
const run: any = { network: "testnet", started_at: new Date().toISOString(), tx: {}, accounts: { parent: PARENT, token: TOKEN, wrap: WRAP, lst: LST, alice: ALICE, operator: OPERATOR, solver: SOLVER, factory: FACTORY } };
const rec = (k: string, r: any) => {
  run.tx[k] = txHash(r);
  log(k, explorer(run.tx[k]));
  return r;
};
const call = async (k: string, who: string, contractId: string, methodName: string, args: any, deposit = 0n, gas = 100) => rec(k, await sendCall(who, contractId, methodName, args, { deposit, gas }));
const ret = returned;
const bal = async (t: string, who: string) => BigInt(await view<string>(t, "ft_balance_of", { account_id: who }));
const near = async (id: string) => BigInt((await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: id })).amount);
const nowS = async () => Number(BigInt((await rpc<any>("block", { finality: "final" })).header.timestamp) / 1_000_000_000n);

async function faucetInto(target: string, need: bigint) {
  if ((await near(target)) >= need) return;
  const kp = KeyPair.fromRandom("ed25519");
  const id = `plinth-faucet-${Date.now().toString(36)}.testnet`;
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`testnet faucet refused: ${r.status}`);
  const credDir = path.join(process.env.HOME ?? "", ".near-credentials", "testnet");
  fs.writeFileSync(path.join(credDir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  for (let i = 0; i < 30 && !(await near(id).catch(() => 0n)); i++) await new Promise((res) => setTimeout(res, 1000));
  // Move all but a little of the faucet's 10 NEAR into the target, then the faucet account is spent.
  rec(`faucet_to_${target.split(".")[0]}`, await signer(id).signAndSendTransaction({ receiverId: target, actions: [actions.transfer(NEAR(9.9))], waitUntil: "FINAL", throwOnFailure: true } as any));
}

await faucetInto(PARENT, NEAR(2));
await faucetInto(SOLVER, NEAR(5.5));
for (const [t, who] of [[LST, ALICE], [WRAP, ALICE], [TOKEN, ALICE], [WRAP, SOLVER]] as const) {
  if ((await view(t, "storage_balance_of", { account_id: who })) === null) await call(`register_${who.split(".")[0]}_${t.split(".")[0]}`, who, t, "storage_deposit", { registration_only: true }, STORAGE, 30);
}
if ((await bal(TOKEN, ALICE)) < 60_000_000n) await call("mint_alice", PARENT, TOKEN, "mint", { account_id: ALICE, amount: "100000000" }, 0n, 30);

// ---------------------------------------------------------------- the earning fund
const close = (await nowS()) + 90;
const config: Config = {
  mandate: {
    tokens: [TOKEN, WRAP, LST],
    max_trade_bps: 2500,
    max_cost_bps: 150,
    min_seconds_between_trades: 660,
    max_trades_per_day: 6,
    max_quote_age_seconds: 300,
    min_deadline_margin_seconds: 600,
    subscription_closes_at: close,
    min_subscription: "1000000",
    max_total_subscriptions: "1000000000",
    management_fee_bps: 100,
    staking: { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price", min_stake: "1000000000000000000000000", max_price_slippage_bps: 50 },
    open_ended: false,
    strategy: null,
  },
  operator: OPERATOR,
  quote_signer: testSigner().public_key,
  storage_deposit: String(STORAGE),
};
run.config = config;
// factory.create_fund: CreateAccount, Transfer, UseGlobalContract(hash), new(config) in one receipt, no AddKey.
const created = await createFund({ from: PARENT, factory: FACTORY, name: `earn-${Date.now().toString(36)}`, config, near: NEAR(1) });
const fund = created.fund;
run.fund = fund;
run.tx.create_fund_keyless = created.tx;
run.created = created;
run.access_keys = created.access_keys;
log("create_fund_keyless", `${fund} ${explorer(created.tx)}`);
await call("alice_subscribe", ALICE, TOKEN, "ft_transfer_call", { receiver_id: fund, amount: "60000000", msg: "" }, 1n, 150);
await waitForChainTime(close + 2);

// ---------------------------------------------------------------- buy wNEAR (test price 1 pUSD = 0.3 wNEAR)
const amountIn = 15_000_000n; // 15 pUSD = 25% of the holding
const out = 4_500_000_000_000_000_000_000_000n; // 4.5 wNEAR
const quote = testQuote({ fund, refundRelay: created.relay, tradeId: 0, sell: TOKEN, buy: WRAP, amount: amountIn, out, minOut: (out * 995n) / 1000n, inUsd: "15.000000", outUsd: "14.970000", deposit: randomBytes(32).toString("hex") });
run.buy_accepted = ret(await call("propose_buy_wnear", OPERATOR, fund, "propose_trade", { quote }, 0n, 200));
if (run.buy_accepted !== true) throw new Error(`the contract refused the quote: ${JSON.stringify(await view(fund, "get_rejections", { from: 0, limit: 1 }))}`);
// The solver pushes the output with msg "trade:0"; the trade settles inside that transfer.
const d = await deliver({ solver: SOLVER, fund, token: WRAP, amount: out, tradeId: 0 });
run.tx.solver_delivers = d.tx;
run.buy_trade = d.trade;
run.buy_settle = d.trade.status;

// ---------------------------------------------------------------- stake at par after the cooldown
const lastTrade = (await fundState(fund)).last_trade_at;
log("waiting for the cooldown", `${660 - ((await nowS()) - lastTrade)} s`);
await waitForChainTime(lastTrade + 662, 10_000);
const price = BigInt(await view<string>(LST, "get_st_near_price"));
run.st_near_price = String(price);
const stakeAmt = 1_100_000_000_000_000_000_000_000n; // 1.1 wNEAR (< 25% of 4.5)
const stNearBefore = await bal(LST, fund);
run.stake_accepted = ret(await call("stake_idle", OPERATOR, fund, "stake_idle", { amount: String(stakeAmt) }, 0n, 300));
// The stake closed inside that transaction: the fund counts what deposit_and_stake returned.
run.stake_trade = await tradeById(fund, 1);
run.stake_settle = run.stake_trade?.status;
run.stnear_minted = String((await bal(LST, fund)) - stNearBefore);
run.after_stake = await fundState(fund);
if (run.stake_settle !== "Settled" || run.after_stake.pending !== null) throw new Error(`the stake did not settle: ${JSON.stringify(run.stake_trade)}`);

// ---------------------------------------------------------------- partial exit in kind + fee
await call("accrue_fee", ALICE, fund, "accrue", {}, 0n, 30);
const before = { pusd: await bal(TOKEN, ALICE), wnear: await bal(WRAP, ALICE), stnear: await bal(LST, ALICE) };
await call("alice_redeem_half", ALICE, fund, "redeem", { shares: "30000000" }, 0n, 250);
run.alice_received = { pusd: String((await bal(TOKEN, ALICE)) - before.pusd), wnear: String((await bal(WRAP, ALICE)) - before.wnear), stnear: String((await bal(LST, ALICE)) - before.stnear) };
run.after = await view(fund, "get_fund");
run.finished_at = new Date().toISOString();
fs.writeFileSync(path.join(ROOT, "data/earn-run.json"), JSON.stringify(run, null, 1));
log("done", { fund, keys: run.access_keys, buy: run.buy_settle, stake: run.stake_settle, minted: run.stnear_minted, counted: run.stake_trade.received_out, alice: run.alice_received, operator_shares: run.after.operator_shares });
