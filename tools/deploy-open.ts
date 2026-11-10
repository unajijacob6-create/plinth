// npm run deploy:open -- [--name open2] [--closes 2026-11-21]
//
// Launch the public "open" fund on testnet with the current contract: anyone can join with test pUSD
// until the close date and exit in kind at any time. It has the staking route (wNEAR -> Meta Pool
// stNEAR at par) and a 1%/yr management fee. Like every Plinth fund it is created keyless in one
// transaction, so it can never be changed: a new contract version means a new fund. The previous
// open fund keeps working; its depositors can still exit. Records data/open-fund.json.
import fs from "node:fs";
import path from "node:path";
import { actions } from "near-api-js";
process.env.NEAR_NETWORK = "testnet";
const { signer, view, rpc, TGAS, NEAR, explorer, txHash, log } = await import("./lib/near.ts");
const { testSigner } = await import("./lib/testsigner.ts");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const opt = (f: string, d: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const fund = `${opt("--name", "open2")}.${PARENT}`;
const closes = Math.floor(Date.parse(`${opt("--closes", "2026-11-21")}T00:00:00Z`) / 1000);
const STORAGE = 1_250_000_000_000_000_000_000n;
const previous = JSON.parse(fs.readFileSync(path.join(ROOT, "data/open-fund.json"), "utf8"));

const exists = await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: fund }).then(() => true, () => false);
if (exists) throw new Error(`${fund} already exists; pick another --name`);

const config = {
  mandate: {
    tokens: [`pusd.${PARENT}`, "wrap.testnet", "meta-v2.pool.testnet"],
    max_trade_bps: 2500,
    max_cost_bps: 150,
    min_seconds_between_trades: 660,
    max_trades_per_day: 6,
    max_quote_age_seconds: 300,
    min_deadline_margin_seconds: 600,
    subscription_closes_at: closes,
    min_subscription: "1000000",
    max_total_subscriptions: "100000000000",
    management_fee_bps: 100,
    staking: { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price", min_stake: "1000000000000000000000000", max_price_slippage_bps: 50 },
  },
  operator: `operator.${PARENT}`,
  quote_signer: testSigner().public_key,
  storage_deposit: String(STORAGE),
};
const wasm = fs.readFileSync(path.join(ROOT, "contracts/target/near/plinth/plinth.wasm"));
// 274 kB of code is ~2.75 NEAR of storage; the rest pays for depositors' share entries and stakes.
const r = await signer(PARENT).signAndSendTransaction({
  receiverId: fund,
  actions: [actions.createAccount(), actions.transfer(NEAR(3.5)), actions.deployContract(wasm), actions.functionCall("new", { config }, TGAS(150), STORAGE * 3n)],
  waitUntil: "FINAL",
  throwOnFailure: true,
} as any);
const tx = txHash(r);
log("created", explorer(tx));
const keys = (await rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: fund })).keys.length;
const state = await view<any>(fund, "get_fund");
log("check", { keys, registered: state.registered, closes: new Date(closes * 1000).toISOString() });
if (keys !== 0 || state.registered.some((x: boolean) => !x)) throw new Error("fund is not keyless or not registered on every token");
fs.writeFileSync(
  path.join(ROOT, "data/open-fund.json"),
  JSON.stringify(
    {
      network: "testnet",
      fund,
      created_tx: tx,
      subscription_closes_at: new Date(closes * 1000).toISOString().replace(".000", ""),
      features: ["staking route: wNEAR -> meta-v2.pool.testnet stNEAR at par", "management fee 1%/yr in shares"],
      previous: { fund: previous.fund, created_tx: previous.created_tx, note: "earlier contract version; still live, depositors can exit" },
      note: "Open for anyone to join and exit with test pUSD. pusd.plinthfund.testnet is a test token anyone can mint; it is not money.",
    },
    null,
    1,
  ),
);
