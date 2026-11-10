// npm run demo:testnet — the whole Plinth story on NEAR testnet, recorded to data/testnet-run.json.
//
// NEAR Intents 1Click has no testnet, so on testnet a stand-in signer key signs 1Click-format
// quotes (same JSON shape, same signed-message rule, verified on chain by the same code) and a
// "solver" account delivers the output, as 1Click would. `npm run verify` labels that key as a test
// signer. The mainnet fund uses the real 1Click key; nothing else differs.
//
// Accounts, all created here and funded only from the public testnet faucet: the parent
// (PLINTH_PARENT, default plinthfund.testnet), pusd.<parent> (a test dollar, 6 decimals, mintable by
// anyone: NOT money), depositors alice/bob.<parent>, operator.<parent>, solver.<parent>; plus
// wrap.testnet (real testnet wNEAR).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair, actions } from "near-api-js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
process.env.NEAR_NETWORK = "testnet";
const { signer, view, rpc, TGAS, NEAR, explorer, txHash, log } = await import("./lib/near.ts");
const { signedMessage } = await import("./lib/oneclick.ts");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const TOKEN = `pusd.${PARENT}`;
const WRAP = "wrap.testnet";
const ALICE = `alice.${PARENT}`, BOB = `bob.${PARENT}`, OPERATOR = `operator.${PARENT}`, SOLVER = `solver.${PARENT}`;
const STORAGE = 1_250_000_000_000_000_000_000n;
const credDir = path.join(os.homedir(), ".near-credentials", "testnet");

const run: any = { network: "testnet", started_at: new Date().toISOString(), accounts: { parent: PARENT, token: TOKEN, wrap: WRAP, alice: ALICE, bob: BOB, operator: OPERATOR, solver: SOLVER }, tx: {}, notes: [] };
const record = (key: string, r: any) => {
  const h = txHash(r);
  if (!h) throw new Error(`${key}: no tx hash`);
  run.tx[key] = h;
  log(key, explorer(h));
  return r;
};
const exists = async (id: string) => rpc("query", { request_type: "view_account", finality: "final", account_id: id }).then(() => true, () => false);
const send = async (key: string, from: string, receiverId: string, acts: any[]) =>
  record(key, await signer(from).signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL", throwOnFailure: true } as any));
const call = async (key: string, from: string, contractId: string, methodName: string, args: any, deposit = 0n, gas = 100) =>
  record(key, await signer(from).callFunctionRaw({ contractId, methodName, args, deposit, gas: TGAS(gas), waitUntil: "FINAL" } as any));
const returned = (r: any) => JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "null");
const ft = (who: string, token = TOKEN) => view<string>(token, "ft_balance_of", { account_id: who }).then(BigInt);

// ---------------------------------------------------------------- parent, token, signer key
if (!(await exists(PARENT))) {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: PARENT, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`testnet helper refused ${PARENT}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, `${PARENT}.json`), JSON.stringify({ account_id: PARENT, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  for (let i = 0; i < 30 && !(await exists(PARENT)); i++) await new Promise((r) => setTimeout(r, 1000));
  log("created", PARENT);
}
log("parent balance (NEAR)", Number(BigInt((await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: PARENT })).amount) / 10n ** 21n) / 1000);
for (const [id, near] of [[ALICE, 0.5], [BOB, 0.5], [OPERATOR, 0.5], [SOLVER, 0.6]] as const) {
  if (await exists(id)) continue;
  const kp = KeyPair.fromRandom("ed25519");
  await send(`create_${id.split(".")[0]}`, PARENT, id, [actions.createAccount(), actions.transfer(NEAR(near)), actions.addFullAccessKey(kp.getPublicKey())]);
  fs.writeFileSync(path.join(credDir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
}

if (!(await exists(TOKEN))) {
  const kp = KeyPair.fromRandom("ed25519");
  await send("create_token", PARENT, TOKEN, [actions.createAccount(), actions.transfer(NEAR(1.6)), actions.addFullAccessKey(kp.getPublicKey()), actions.deployContract(fs.readFileSync(path.join(ROOT, "contracts/target/near/mock_ft/mock_ft.wasm"))), actions.functionCall("new", {}, TGAS(30), 0n)]);
  fs.writeFileSync(path.join(credDir, `${TOKEN}.json`), JSON.stringify({ account_id: TOKEN, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
}

const signerFile = path.join(credDir, "plinth-test-quote-signer.json");
if (!fs.existsSync(signerFile)) {
  const sk = randomBytes(32);
  fs.writeFileSync(signerFile, JSON.stringify({ secret_hex: sk.toString("hex"), public_key: `ed25519:${bs58.encode(ed25519.getPublicKey(sk))}` }), { mode: 0o600 });
}
const testSigner = JSON.parse(fs.readFileSync(signerFile, "utf8"));
run.quote_signer = testSigner.public_key;

// ---------------------------------------------------------------- registrations and test dollars
for (const who of [ALICE, BOB, SOLVER]) {
  if ((await view(TOKEN, "storage_balance_of", { account_id: who })) === null) await call(`register_${who.split(".")[0]}_pusd`, who, TOKEN, "storage_deposit", {}, STORAGE, 30);
}
for (const who of [ALICE, BOB, SOLVER]) {
  if ((await view(WRAP, "storage_balance_of", { account_id: who })) === null) await call(`register_${who.split(".")[0]}_wrap`, who, WRAP, "storage_deposit", { registration_only: true }, STORAGE, 30);
}
for (const [who, amt] of [[ALICE, 60_000_000n], [BOB, 40_000_000n]] as const) {
  const have = await ft(who);
  if (have < amt) await call(`mint_${who.split(".")[0]}`, PARENT, TOKEN, "mint", { account_id: who, amount: String(amt - have) }, 0n, 30);
}

// ---------------------------------------------------------------- keyless fund
const fund = `fund-${Date.now().toString(36)}.${PARENT}`;
run.fund = fund;
const head = await rpc<any>("block", { finality: "final" });
const close = Math.floor(Number(BigInt(head.header.timestamp) / 1_000_000_000n)) + 75;
const config = {
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
  },
  operator: OPERATOR,
  quote_signer: testSigner.public_key,
  storage_deposit: String(STORAGE),
};
run.config = config;
const wasm = fs.readFileSync(path.join(ROOT, "contracts/target/near/plinth/plinth.wasm"));
// One transaction, no AddKey: the account is born with zero keys.
await send("create_fund_keyless", PARENT, fund, [actions.createAccount(), actions.transfer(NEAR(3)), actions.deployContract(wasm), actions.functionCall("new", { config }, TGAS(100), NEAR(0.01))]);
const keys = await rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: fund });
run.access_keys_after_create = keys.keys.length;
log("access keys on the fund", keys.keys.length);

// ---------------------------------------------------------------- subscribe
await call("alice_subscribe", ALICE, TOKEN, "ft_transfer_call", { receiver_id: fund, amount: "60000000", msg: "" }, 1n, 150);
await call("bob_subscribe", BOB, TOKEN, "ft_transfer_call", { receiver_id: fund, amount: "40000000", msg: "" }, 1n, 150);
run.after_subscribe = await view(fund, "get_fund");

// ---------------------------------------------------------------- wait for the window to close
for (;;) {
  const b = await rpc<any>("block", { finality: "final" });
  if (Number(BigInt(b.header.timestamp) / 1_000_000_000n) >= close + 2) break;
  await new Promise((r) => setTimeout(r, 3000));
}

const iso = (s: number) => new Date(s * 1000).toISOString();
function quote(o: { amount: bigint; out: bigint; minOut: bigint; inUsd: string; outUsd: string; recipient?: string; deposit: string }) {
  const now = Math.floor(Date.now() / 1000) - 5;
  const req: any = {
    dry: false, depositMode: "SIMPLE", swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: `nep141:${TOKEN}`, depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${WRAP}`, amount: String(o.amount), refundTo: fund, refundType: "ORIGIN_CHAIN", recipient: o.recipient ?? fund,
    recipientType: "DESTINATION_CHAIN", deadline: iso(now + 600), quoteWaitingTimeMs: 0,
  };
  const q: any = {
    amountIn: String(o.amount), amountInFormatted: "", amountInUsd: o.inUsd, minAmountIn: String(o.amount), amountOut: String(o.out), amountOutFormatted: "",
    amountOutUsd: o.outUsd, minAmountOut: String(o.minOut), timeEstimate: 20, refundFee: "4500", deadline: iso(now + 3 * 86400), timeWhenInactive: iso(now + 3 * 86400), depositAddress: o.deposit,
  };
  const ts = iso(now);
  const sig = ed25519.sign(new TextEncoder().encode(signedMessage(req, q, ts)), Buffer.from(testSigner.secret_hex, "hex"));
  return JSON.stringify({ quote: q, quoteRequest: req, timestamp: ts, signature: `ed25519:${bs58.encode(sig)}` });
}
const dep = randomBytes(32).toString("hex"); // a fresh implicit account, unregistered on the token, like a 1Click deposit address
const OUT = 20_000_000_000_000_000_000_000n; // 0.02 wNEAR for 10 pUSD (test prices)
const MIN_OUT = 19_900_000_000_000_000_000_000n;

// ---------------------------------------------------------------- refused: output to the operator
let r = await call("refused_wrong_recipient", OPERATOR, fund, "propose_trade", { quote: quote({ amount: 10_000_000n, out: OUT, minOut: MIN_OUT, inUsd: "10.000000", outUsd: "9.980000", recipient: OPERATOR, deposit: dep }) }, 0n, 150);
run.refused_wrong_recipient = returned(r);
// ---------------------------------------------------------------- refused: 30% of the fund in one trade
r = await call("refused_too_large", OPERATOR, fund, "propose_trade", { quote: quote({ amount: 30_000_000n, out: OUT * 3n, minOut: MIN_OUT * 3n, inUsd: "30.000000", outUsd: "29.940000", deposit: dep }) }, 0n, 150);
run.refused_too_large = returned(r);
run.rejections = await view(fund, "get_rejections", { from: 0, limit: 10 });

// ---------------------------------------------------------------- accepted trade
r = await call("propose_trade", OPERATOR, fund, "propose_trade", { quote: quote({ amount: 10_000_000n, out: OUT, minOut: MIN_OUT, inUsd: "10.000000", outUsd: "9.980000", deposit: dep }) }, 0n, 200);
run.accepted = returned(r);
run.deposit_address = dep;
run.deposit_address_pusd = String(await ft(dep));
run.after_send = await view(fund, "get_fund");

// ---------------------------------------------------------------- the solver delivers, anyone settles
const solverWrap = await ft(SOLVER, WRAP);
if (solverWrap < OUT) await call("solver_wrap", SOLVER, WRAP, "near_deposit", {}, OUT - solverWrap, 30);
await call("solver_delivers", SOLVER, WRAP, "ft_transfer", { receiver_id: fund, amount: String(OUT), memo: "fill" }, 1n, 30);
r = await call("settle", BOB, fund, "settle", {}, 0n, 100);
run.settle_status = returned(r);
run.after_settle = await view(fund, "get_fund");

// ---------------------------------------------------------------- bob exits in kind
const bobPusd = await ft(BOB), bobWrap = await ft(BOB, WRAP);
await call("bob_redeem", BOB, fund, "redeem", { shares: "40000000" }, 0n, 200);
run.bob_received = { pusd: String((await ft(BOB)) - bobPusd), wnear: String((await ft(BOB, WRAP)) - bobWrap) };
run.after_redeem = await view(fund, "get_fund");
run.access_keys_at_end = (await rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: fund })).keys.length;
run.code_hash = (await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: fund })).code_hash;
run.finished_at = new Date().toISOString();
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data/testnet-run.json"), JSON.stringify(run, null, 1));
log("done", { fund, settle: run.settle_status, bob_received: run.bob_received, keys: run.access_keys_at_end });
