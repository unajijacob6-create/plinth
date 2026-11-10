// npm run deploy -- --parent <account> --name <sub> --config <config.json> [--balance 3] [--network mainnet]
//
// Creates <name>.<parent> in ONE transaction with no AddKey action: CreateAccount, Transfer,
// DeployContract, FunctionCall new(config). The fund is born with zero access keys. Mainnet needs
// PLINTH_MAINNET=yes. Then run `npm run verify -- <fund>`.
import fs from "node:fs";
import path from "node:path";
import { actions } from "near-api-js";

const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (opt("--network")) process.env.NEAR_NETWORK = opt("--network");
const { signer, rpc, NEAR, TGAS, explorer, txHash, NETWORK } = await import("./lib/near.ts");

const parent = opt("--parent"), name = opt("--name"), cfgFile = opt("--config");
if (!parent || !name || !cfgFile) {
  console.error("usage: npm run deploy -- --parent <account> --name <sub> --config <config.json> [--balance 3] [--network mainnet]");
  process.exit(2);
}
const fund = `${name}.${parent}`;
const config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
const wasm = fs.readFileSync(path.resolve(opt("--wasm", "contracts/target/near/plinth/plinth.wasm")!));
const balance = Number(opt("--balance", "3"));
const initDeposit = BigInt(config.storage_deposit) * BigInt(config.mandate.tokens.length);
console.log(`creating keyless fund ${fund} on ${NETWORK}: ${wasm.length}-byte wasm, ${balance} NEAR, operator ${config.operator}, signer ${config.quote_signer}`);
const r = await signer(parent).signAndSendTransaction({
  receiverId: fund,
  actions: [actions.createAccount(), actions.transfer(NEAR(balance)), actions.deployContract(wasm), actions.functionCall("new", { config }, TGAS(100), initDeposit)],
  waitUntil: "FINAL",
  throwOnFailure: true,
} as any);
console.log(`tx ${explorer(txHash(r))}`);
const keys = await rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: fund });
console.log(`access keys on ${fund}: ${keys.keys.length}`);
if (keys.keys.length !== 0) process.exit(1);
