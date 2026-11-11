// npm run demo:testnet — the whole Plinth story (release 0.3) on NEAR testnet, recorded to
// data/testnet-run.json.
//
// NEAR Intents 1Click has no testnet, so on testnet a stand-in signer key signs 1Click-format
// quotes (same JSON shape, same signed-message rule, verified on chain by the same code) and a
// "solver" account delivers the output the way 1Click does for a quote with customRecipientMsg:
// ft_transfer_call(msg = "trade:<id>"). `npm run verify` labels that key as a test signer. The
// mainnet fund uses the real 1Click key; nothing else differs.
//
// What the run records, each step with its transaction:
//   - a keyless fund created by the factory (data/releases.json `factories.testnet`);
//   - two subscriptions; three quotes the contract refuses (output to the operator, 30% of the fund
//     in one trade, no delivery message); one accepted trade;
//   - an attacker who bounces tokens off the fund (ft_transfer_call with msg "", which the fund hands
//     back) and calls `settle` / `absorb`, the entry points of releases 0.1 and 0.2 that counted a
//     bounced transfer as holdings: holdings do not change and the trade stays in flight;
//   - the delivery push, which settles the trade inside the transfer;
//   - an in-kind join by a new account after trading started, and that account's in-kind exit;
//   - Bob's in-kind exit.
//
// Accounts, all created here and funded only from the public testnet faucet: the parent
// (PLINTH_PARENT, default plinthfund.testnet), pusd.<parent> (a test dollar, 6 decimals, mintable by
// anyone: NOT money), depositors alice/bob/carol.<parent>, operator.<parent>, solver.<parent>,
// mallory.<parent> (the attacker); plus wrap.testnet (real testnet wNEAR).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair, actions } from "near-api-js";
process.env.NEAR_NETWORK = "testnet";
const { view, accountView, accountExists, accessKeyCount, chainSeconds, send, call, returned, failure, TGAS, NEAR, explorer, txHash, log } = await import("./lib/near.ts");
const { ROOT, factoryFor, createFund, fundState, waitForChainTime } = await import("./lib/fund.ts");
const { testQuote, testSigner } = await import("./lib/testsigner.ts");
const { deliver } = await import("./lib/solver.ts");
const { basketAmounts } = await import("./lib/basket.ts");
type Config = import("./lib/config.ts").Config;

const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const TOKEN = `pusd.${PARENT}`;
const WRAP = "wrap.testnet";
const ALICE = `alice.${PARENT}`, BOB = `bob.${PARENT}`, CAROL = `carol.${PARENT}`, OPERATOR = `operator.${PARENT}`, SOLVER = `solver.${PARENT}`, MALLORY = `mallory.${PARENT}`;
const STORAGE = 1_250_000_000_000_000_000_000n;
const credDir = path.join(os.homedir(), ".near-credentials", "testnet");
const FACTORY = factoryFor("testnet");

const run: any = { network: "testnet", started_at: new Date().toISOString(), accounts: { parent: PARENT, token: TOKEN, wrap: WRAP, alice: ALICE, bob: BOB, carol: CAROL, operator: OPERATOR, solver: SOLVER, attacker: MALLORY, factory: FACTORY }, tx: {}, notes: [] };
/** Record a transaction under `key` (its hash goes to run.tx) and return its outcome. */
const step = async (key: string, sent: Promise<any>) => {
  const r = await sent;
  const h = txHash(r);
  if (!h) throw new Error(`${key}: no tx hash`);
  run.tx[key] = h;
  log(key, explorer(h));
  return r;
};
const ft = (who: string, token = TOKEN) => view<string>(token, "ft_balance_of", { account_id: who }).then(BigInt);
const push = (from: string, token: string, to: string, amount: bigint | string, msg: string, allowFailure = false) =>
  call(from, token, "ft_transfer_call", { receiver_id: to, amount: String(amount), msg }, { deposit: 1n, gas: 150, allowFailure });
const saveKey = (id: string, kp: KeyPair) => {
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
};

// ---------------------------------------------------------------- parent, accounts, token
if (!(await accountExists(PARENT))) {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: PARENT, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`testnet helper refused ${PARENT}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  saveKey(PARENT, kp);
  for (let i = 0; i < 30 && !(await accountExists(PARENT)); i++) await new Promise((res) => setTimeout(res, 1000));
  log("created", PARENT);
}
log("parent balance (NEAR)", Number(BigInt((await accountView(PARENT)).amount) / 10n ** 21n) / 1000);
for (const [id, near] of [[ALICE, 0.5], [BOB, 0.5], [CAROL, 0.5], [OPERATOR, 0.5], [SOLVER, 0.6], [MALLORY, 0.5]] as const) {
  if (await accountExists(id)) continue;
  const kp = KeyPair.fromRandom("ed25519");
  await step(`create_${id.split(".")[0]}`, send(PARENT, id, [actions.createAccount(), actions.transfer(NEAR(near)), actions.addFullAccessKey(kp.getPublicKey())]));
  saveKey(id, kp);
}
if (!(await accountExists(TOKEN))) {
  const kp = KeyPair.fromRandom("ed25519");
  await step("create_token", send(PARENT, TOKEN, [actions.createAccount(), actions.transfer(NEAR(1.6)), actions.addFullAccessKey(kp.getPublicKey()), actions.deployContract(fs.readFileSync(path.join(ROOT, "contracts/target/near/mock_ft/mock_ft.wasm"))), actions.functionCall("new", {}, TGAS(30), 0n)]));
  saveKey(TOKEN, kp);
}
run.quote_signer = testSigner().public_key;

// ---------------------------------------------------------------- registrations and test dollars
for (const token of [TOKEN, WRAP]) {
  for (const who of [ALICE, BOB, CAROL, SOLVER, MALLORY]) {
    if ((await view(token, "storage_balance_of", { account_id: who })) === null) await step(`register_${who.split(".")[0]}_${token === TOKEN ? "pusd" : "wrap"}`, call(who, token, "storage_deposit", { registration_only: true }, { deposit: STORAGE, gas: 30 }));
  }
}
const mintTo = async (who: string, amount: bigint) => {
  const have = await ft(who);
  if (have < amount) await step(`mint_${who.split(".")[0]}`, call(PARENT, TOKEN, "mint", { account_id: who, amount: String(amount - have) }, { gas: 30 }));
};
const wrapTo = async (who: string, amount: bigint) => {
  const have = await ft(who, WRAP);
  if (have < amount) await step(`${who.split(".")[0]}_wrap`, call(who, WRAP, "near_deposit", {}, { deposit: amount - have, gas: 30 }));
};
await mintTo(ALICE, 60_000_000n);
await mintTo(BOB, 40_000_000n);

// ---------------------------------------------------------------- keyless fund, through the factory
const close = (await chainSeconds()) + 120; // room for the creation and two subscriptions
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
    open_ended: true,
    strategy: null,
  },
  operator: OPERATOR,
  quote_signer: run.quote_signer,
  storage_deposit: String(STORAGE),
};
run.config = config;
// factory.create_fund: CreateAccount, Transfer, UseGlobalContract(hash), new(config) in one receipt, no AddKey.
const created = await createFund({ from: PARENT, factory: FACTORY, name: `fund-${Date.now().toString(36)}`, config, near: NEAR(1) });
const fund = created.fund;
run.fund = fund;
run.tx.create_fund_keyless = created.tx;
run.created = created;
run.access_keys_after_create = created.access_keys;
log("create_fund_keyless", `${fund} ${explorer(created.tx)}; access keys ${created.access_keys}`);

// ---------------------------------------------------------------- subscribe
await step("alice_subscribe", push(ALICE, TOKEN, fund, 60_000_000n, ""));
await step("bob_subscribe", push(BOB, TOKEN, fund, 40_000_000n, ""));
run.after_subscribe = await fundState(fund);
await waitForChainTime(close + 2);

const OUT = 20_000_000_000_000_000_000_000n; // 0.02 wNEAR for 10 pUSD (test prices)
const MIN_OUT = 19_900_000_000_000_000_000_000n;
const dep = randomBytes(32).toString("hex"); // a fresh implicit account, unregistered on the token, like a 1Click deposit address
const quote = (o: { amount: bigint; out: bigint; minOut: bigint; inUsd: string; outUsd: string; recipient?: string; customRecipientMsg?: string | null }) =>
  testQuote({ fund, tradeId: 0, sell: TOKEN, buy: WRAP, deposit: dep, ...o });
const propose = (key: string, q: string) => step(key, call(OPERATOR, fund, "propose_trade", { quote: q }, { gas: 200 }));

// ---------------------------------------------------------------- refused: output to the operator
run.refused_wrong_recipient = returned(await propose("refused_wrong_recipient", quote({ amount: 10_000_000n, out: OUT, minOut: MIN_OUT, inUsd: "10.000000", outUsd: "9.980000", recipient: OPERATOR })));
// ---------------------------------------------------------------- refused: 30% of the fund in one trade
run.refused_too_large = returned(await propose("refused_too_large", quote({ amount: 30_000_000n, out: OUT * 3n, minOut: MIN_OUT * 3n, inUsd: "30.000000", outUsd: "29.940000" })));
run.rejections = await view(fund, "get_rejections", { from: 0, limit: 10 });
// ---------------------------------------------------------------- refused: a quote 1Click would deliver with a plain transfer
run.refused_no_delivery_msg = returned(await propose("refused_no_delivery_msg", quote({ amount: 10_000_000n, out: OUT, minOut: MIN_OUT, inUsd: "10.000000", outUsd: "9.980000", customRecipientMsg: null })));
run.rejection_no_delivery_msg = (await view<any[]>(fund, "get_rejections", { from: 2, limit: 1 }))[0];

// ---------------------------------------------------------------- the attacker bounces a non-base token (no trade in flight)
await wrapTo(MALLORY, OUT);
await mintTo(MALLORY, 5_000_000n);
const snapshot = async () => {
  const s = await fundState(fund);
  return { held: s.held, pending_status: s.pending?.status ?? null, trades: s.trades, balances: [String(await ft(fund)), String(await ft(fund, WRAP))] };
};
const attack: any = { attacker: MALLORY, note: "ft_transfer_call with msg \"\" is handed back by the fund (not a subscription, donation, basket or trade output). Releases 0.1 and 0.2 could be made to count such a transfer while it sat in the fund's balance; `settle` and `absorb` were the entry points. Release 0.3 has neither and never reads a balance for trade output." };
attack.before_trade = { before: await snapshot() };
{
  const mine = await ft(MALLORY, WRAP);
  const r = await step("attack_bounce_wnear_before_trade", push(MALLORY, WRAP, fund, OUT, ""));
  attack.before_trade.fund_kept = returned(r);
  attack.before_trade.attacker_got_back = (await ft(MALLORY, WRAP)) === mine;
  attack.before_trade.after = await snapshot();
}

// ---------------------------------------------------------------- accepted trade
run.accepted = returned(await propose("propose_trade", quote({ amount: 10_000_000n, out: OUT, minOut: MIN_OUT, inUsd: "10.000000", outUsd: "9.980000" })));
if (run.accepted !== true) throw new Error(`the contract refused the good quote: ${JSON.stringify(await view(fund, "get_rejections", { from: 3, limit: 1 }))}`);
run.deposit_address = dep;
run.deposit_address_pusd = String(await ft(dep));
run.after_send = await fundState(fund);

// ---------------------------------------------------------------- the attacker tries to settle the trade with a bounce
// In the same blocks: the output token bounced off the fund, and the calls that read the balance in
// releases 0.1/0.2. Three different signers, so the transactions run concurrently.
attack.in_flight = { before: await snapshot() };
{
  const [bounce, settle, absorb, refund] = await Promise.all([
    push(MALLORY, WRAP, fund, OUT, ""),
    call(BOB, fund, "settle", {}, { allowFailure: true }),
    call(ALICE, fund, "absorb", { token_index: 1 }, { gas: 50, allowFailure: true }),
    call(CAROL, fund, "settle_refund", { trade_id: 0 }, { allowFailure: true }),
  ]);
  await step("attack_bounce_wnear_in_flight", Promise.resolve(bounce));
  await step("attack_call_settle", Promise.resolve(settle));
  await step("attack_call_absorb", Promise.resolve(absorb));
  await step("attack_call_settle_refund_early", Promise.resolve(refund));
  attack.in_flight.bounce_fund_kept = returned(bounce);
  attack.in_flight.settle_failed = failure(settle);
  attack.in_flight.absorb_failed = failure(absorb);
  attack.in_flight.settle_refund_failed = failure(refund);
  // The base token too: the window is closed, so it is handed back as well.
  attack.in_flight.bounce_pusd_fund_kept = returned(await step("attack_bounce_pusd_in_flight", push(MALLORY, TOKEN, fund, 5_000_000n, "")));
  attack.in_flight.after = await snapshot();
}
attack.holdings_unchanged = JSON.stringify(attack.before_trade.before.held) === JSON.stringify(attack.before_trade.after.held) && JSON.stringify(attack.in_flight.before.held) === JSON.stringify(attack.in_flight.after.held);
attack.trade_still_in_flight = attack.in_flight.after.pending_status === "Sent";
run.attack = attack;
if (!attack.holdings_unchanged || !attack.trade_still_in_flight || !attack.in_flight.settle_failed || !attack.in_flight.absorb_failed || !attack.in_flight.settle_refund_failed) throw new Error(`the attack changed the fund: ${JSON.stringify(attack)}`);
log("attack", "holdings unchanged, trade 0 still in flight; settle and absorb do not exist");

// ---------------------------------------------------------------- the solver delivers: the push settles the trade
const d = await deliver({ solver: SOLVER, fund, token: WRAP, amount: OUT, tradeId: 0 });
run.tx.solver_delivers = d.tx;
run.solver_prepared_tx = d.prepared; // the solver wrapping NEAR for the delivery, if it had to
// Release 0.3 has no settle step: the delivery transaction is the settlement. The key is kept
// because the website links it.
run.tx.settle = d.tx;
run.settle_status = d.trade.status;
run.settled_trade = d.trade;
run.after_settle = await fundState(fund);

// ---------------------------------------------------------------- carol joins in kind after trading started, then exits in kind
{
  const s = await fundState(fund);
  const wanted = 10_000_000n; // shares: a tenth of the 100,000,000 outstanding
  const amounts = basketAmounts(s.held.map(([, v]) => BigInt(v)), BigInt(s.total_shares!), wanted);
  const join: any = { account: CAROL, shares_wanted: String(wanted), fund_before: { held: s.held, total_shares: s.total_shares }, basket: amounts.map(String) };
  await mintTo(CAROL, amounts[0]);
  await wrapTo(CAROL, amounts[1]);
  await step("carol_open_basket", call(CAROL, fund, "open_basket", {}, { deposit: 5_000_000_000_000_000_000_000n, gas: 30 }));
  for (const [i, token] of [TOKEN, WRAP].entries()) {
    if (amounts[i] > 0n) await step(`carol_basket_${i === 0 ? "pusd" : "wnear"}`, push(CAROL, token, fund, amounts[i], "basket"));
  }
  join.basket_on_chain = await view(fund, "get_basket", { account_id: CAROL });
  join.shares_minted = returned(await step("carol_join_in_kind", call(CAROL, fund, "join_in_kind", { min_shares: String(wanted) })));
  join.basket_left = await view(fund, "get_basket", { account_id: CAROL });
  await step("carol_withdraw_basket", call(CAROL, fund, "withdraw_basket", {}, { gas: 150 }));
  join.fund_after = await fundState(fund).then((f) => ({ held: f.held, total_shares: f.total_shares, basket_total: f.basket_total }));
  run.join_in_kind = join;
  const before = { pusd: await ft(CAROL), wnear: await ft(CAROL, WRAP) };
  const shares = await view<string>(fund, "get_shares", { account_id: CAROL });
  await step("carol_redeem", call(CAROL, fund, "redeem", { shares }, { gas: 200 }));
  run.carol_received = { shares_redeemed: shares, pusd: String((await ft(CAROL)) - before.pusd), wnear: String((await ft(CAROL, WRAP)) - before.wnear) };
  run.after_join_exit = await fundState(fund);
}

// ---------------------------------------------------------------- bob exits in kind
const bobPusd = await ft(BOB), bobWrap = await ft(BOB, WRAP);
await step("bob_redeem", call(BOB, fund, "redeem", { shares: "40000000" }, { gas: 200 }));
run.bob_received = { pusd: String((await ft(BOB)) - bobPusd), wnear: String((await ft(BOB, WRAP)) - bobWrap) };
run.after_redeem = await fundState(fund);
run.trades = await view(fund, "get_trades", { from: 0, limit: 10 });
run.access_keys_at_end = await accessKeyCount(fund);
const acct = await accountView(fund);
run.code_hash = acct.code_hash;
run.global_contract_hash = acct.global_contract_hash ?? null;
run.version = run.after_redeem.version;
run.finished_at = new Date().toISOString();
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data/testnet-run.json"), JSON.stringify(run, null, 1));
log("done", { fund, settle: run.settle_status, attack_held_unchanged: attack.holdings_unchanged, carol_shares: run.join_in_kind.shares_minted, bob_received: run.bob_received, keys: run.access_keys_at_end });
