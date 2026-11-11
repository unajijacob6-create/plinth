// npm run deploy -- --from <account> --name <name> (<mandate flags> | --config <config.json>)
//                   [--near 1] [--factory <account>] [--network testnet|mainnet] [--send]
//
// Create the keyless fund `<name>.<factory>` and its refund relay `<name>-r.<factory>` through the
// factory contract (`create_fund`): each account in one receipt with CreateAccount, Transfer,
// UseGlobalContract(hash) and its init call, and no AddKey. The factory is read from
// data/releases.json (`factories.<network>`) unless --factory is given.
// --from pays: --near NEAR for the fund (default 1, at least 0.5), 0.03 NEAR for the relay, the
// factory's 0.003 NEAR list fee and storage_deposit per token for each of the two accounts.
//
// Without --send nothing is signed: the config is built, checked against the contract's own rules
// and printed. Mainnet also needs PLINTH_MAINNET=yes. Afterwards: `npm run verify -- <fund>`.
import fs from "node:fs";
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";
import { CONFIG_FLAGS_HELP, CONFIG_SWITCH_FLAGS, CONFIG_VALUE_FLAGS, configFromFlags, creationDeposit, normaliseConfig, parseNear, validateConfig, validateFundName, type Config } from "./lib/config.ts";

plainErrors();
const USAGE = `usage: npm run deploy -- --from <account> --name <name> (<mandate flags> | --config <config.json>) [--near 1] [--factory <account>] [--network testnet|mainnet] [--send]

  --from <account>           pays for the fund and signs (credentials in ~/.near-credentials)
  --name <name>              the fund becomes <name>.<factory> (relay <name>-r.<factory>): 2 to 30 of a-z, 0-9 and -
  --near <NEAR>              NEAR the fund starts with, besides its token registrations (default 1)
  --config <file>            a complete config as JSON, instead of the mandate flags below
${CONFIG_FLAGS_HELP}`;
const a = withUsage(USAGE, () => {
  const p = parseArgs(process.argv.slice(2), { values: ["--from", "--name", "--near", "--config", "--factory", "--network", ...CONFIG_VALUE_FLAGS], switches: ["--send", ...CONFIG_SWITCH_FLAGS] });
  for (const f of ["--from", "--name"]) if (!p.values[f]) throw new UsageError(`${f} is required`);
  if (p.positionals.length) throw new UsageError(`unexpected argument ${p.positionals[0]}`);
  if (p.values["--network"] && !["testnet", "mainnet"].includes(p.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  const mixed = [...CONFIG_VALUE_FLAGS, ...CONFIG_SWITCH_FLAGS].filter((f) => f in p.values || p.switches.has(f));
  if (p.values["--config"] && mixed.length) throw new UsageError(`--config already holds the whole config; drop ${mixed.join(" ")}`);
  return p;
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { NETWORK, chainSeconds, formatNear, explorer } = await import("./lib/near.ts");
const { factoryFor, createFund } = await import("./lib/fund.ts");
const { testSigner } = await import("./lib/testsigner.ts");
const { sameEd25519Key, ONECLICK_KEY } = await import("./lib/oneclick.ts");

const now = await chainSeconds();
const { config, near, deposit } = withUsage(USAGE, () => {
  const config: Config = normaliseConfig(
    a.values["--config"]
      ? (JSON.parse(fs.readFileSync(a.values["--config"], "utf8")) as Config)
      : configFromFlags(a, { network: NETWORK, nowS: now, readFile: (f) => fs.readFileSync(f, "utf8"), testSignerKey: () => testSigner().public_key }),
  );
  const near = parseNear(a.values["--near"] ?? "1");
  return { config, near, deposit: creationDeposit(config, near) };
});
const factory = factoryFor(NETWORK, a.values["--factory"]);
const name = a.values["--name"], fund = `${name}.${factory}`;
const problems = [...validateFundName(name, factory), ...validateConfig(config, fund, now)];
const oneclick = sameEd25519Key(config.quote_signer, ONECLICK_KEY);

console.log(`fund ${fund} on ${NETWORK}, created by factory ${factory}, paid by ${a.values["--from"]}`);
console.log(JSON.stringify(config, null, 1));
console.log(`subscription window closes ${new Date(config.mandate.subscription_closes_at * 1000).toISOString()} (in ${config.mandate.subscription_closes_at - now} s)`);
console.log(`quote signer: ${oneclick ? "NEAR Intents 1Click" : "NOT the 1Click key (a test signer)"}`);
console.log(`attached: ${formatNear(deposit.total)} NEAR = ${formatNear(near)} for the fund + ${formatNear(deposit.relay)} for its refund relay + ${formatNear(deposit.registrations)} for ${config.mandate.tokens.length} token registration(s) of each + ${formatNear(deposit.listFee)} the factory keeps for its list`);
if (problems.length) {
  console.error(`\nthe contract would refuse this fund:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
if (NETWORK === "mainnet" && !oneclick) {
  console.error("\nrefusing: a mainnet fund must use the 1Click quote signer");
  process.exit(1);
}
if (!a.switches.has("--send")) {
  console.log("\nthe config passes the contract's checks. Nothing sent; add --send to create the fund.");
  process.exit(0);
}
const c = await createFund({ from: a.values["--from"], factory, name, config, near });
console.log(`created ${c.fund}: ${explorer(c.tx)}`);
console.log(`refund relay ${c.relay} (0 access keys, same code, serves only this fund)`);
console.log(`access keys ${c.access_keys}; code ${c.code_hash} (global, by hash); version ${c.version}; registered on tokens: ${c.registered.join(", ")}`);
console.log(`next: npm run verify -- ${c.fund} --network ${NETWORK}`);
