// npm run deploy:open -- [--name open3] [--closes 2026-11-21] [--send]
//
// Launch the public "open" fund on testnet with the current release, through the factory: anyone can
// join with test pUSD until the close date, join in kind afterwards (open_ended) and exit in kind at
// any time. It has the staking route (wNEAR -> Meta Pool stNEAR at par) and a 1%/yr management fee.
// Like every Plinth fund it is keyless and can never be changed: a new contract version means a new
// fund. The previous open fund keeps working; its depositors can still exit. Records
// data/open-fund.json. Without --send the config is checked and printed, and nothing is signed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, withUsage, UsageError } from "./lib/args.ts";
import { DEFAULT_STORAGE_DEPOSIT, parseCloses, parseNear, validateConfig, validateFundName, type Config } from "./lib/config.ts";
process.env.NEAR_NETWORK = "testnet";
const { chainSeconds, explorer, log } = await import("./lib/near.ts");
const { ROOT, factoryFor, createFund } = await import("./lib/fund.ts");
const { testSigner } = await import("./lib/testsigner.ts");

const USAGE = "usage: npm run deploy:open -- [--name open3] [--closes <ISO date | +seconds>] [--factory <account>] [--send]";
const now = await chainSeconds();
const { a, closes } = withUsage(USAGE, () => {
  const a = parseArgs(process.argv.slice(2), { values: ["--name", "--closes", "--factory"], switches: ["--send"] });
  if (a.positionals.length) throw new UsageError(`unexpected argument ${a.positionals[0]}`);
  return { a, closes: parseCloses(a.values["--closes"] ?? "2026-11-21", now) };
});
const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const factory = factoryFor("testnet", a.values["--factory"]);
const name = a.values["--name"] ?? "open3";
const fund = `${name}.${factory}`;
const openFile = path.join(ROOT, "data/open-fund.json");
const previous = JSON.parse(fs.readFileSync(openFile, "utf8"));

const config: Config = {
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
    open_ended: true,
    strategy: null,
  },
  operator: `operator.${PARENT}`,
  quote_signer: testSigner().public_key,
  storage_deposit: String(DEFAULT_STORAGE_DEPOSIT),
};
const problems = [...validateFundName(name, factory), ...validateConfig(config, fund, now)];
console.log(`open fund ${fund} (factory ${factory}, paid by ${PARENT}), window closes ${new Date(closes * 1000).toISOString()}`);
console.log(JSON.stringify(config, null, 1));
if (problems.length) throw new Error(`the contract would refuse this fund:\n  - ${problems.join("\n  - ")}`);
if (!a.switches.has("--send")) {
  console.log("\nnothing sent. Add --send to create the fund.");
  process.exit(0);
}
// The fund carries no code of its own (it references the published hash), so 1 NEAR covers its
// state, depositors' share entries, stakes and deposit-address registrations for a long time.
const c = await createFund({ from: PARENT, factory, name, config, near: parseNear("1") });
log("created", explorer(c.tx));
if (c.registered.some((x) => !x)) throw new Error("the fund is not registered on every token; retry with register({token_index}) before announcing it");
fs.writeFileSync(
  openFile,
  JSON.stringify(
    {
      network: "testnet",
      fund: c.fund,
      created_tx: c.tx,
      subscription_closes_at: new Date(closes * 1000).toISOString().replace(".000", ""),
      features: ["staking route: wNEAR -> meta-v2.pool.testnet stNEAR at par", "management fee 1%/yr in shares", "open-ended: in-kind joins after the window closes"],
      factory: c.factory,
      code_hash: c.code_hash,
      version: c.version,
      access_keys: c.access_keys,
      previous: { fund: previous.fund, created_tx: previous.created_tx, note: "earlier contract version; still live, depositors can exit" },
      note: `Open for anyone to join and exit with test pUSD. pusd.${PARENT} is a test token anyone can mint; it is not money.`,
    },
    null,
    1,
  ),
);
log("recorded", "data/open-fund.json");
