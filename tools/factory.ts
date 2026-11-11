// npm run factory:deploy -- --parent <account> --name <sub> (--code-hash <hash> | --fund-wasm <file>)
//                           [--wasm <factory wasm>] [--near <NEAR>] [--network testnet|mainnet] [--send]
//
// Create the fund factory `<name>.<parent>` in ONE transaction with no AddKey action: CreateAccount,
// Transfer, DeployContract(factory wasm), FunctionCall new({code_hash}). The factory is born with
// zero access keys and the fund code hash it uses is fixed for good.
//
// The fund code must already be published (npm run publish:code). Without --send nothing is signed:
// the script prints the plan and exits. With --send it also records the factory in
// data/releases.json (`factories.<network>`), where deploy and the demos read it. Mainnet also needs
// PLINTH_MAINNET=yes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { actions } from "near-api-js";
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";
import { hashToBase58 } from "./lib/classify.ts";
import { isAccountId, parseNear } from "./lib/config.ts";

plainErrors();
const USAGE = "usage: npm run factory:deploy -- --parent <account> --name <sub> (--code-hash <base58 or hex sha256> | --fund-wasm <file>) [--wasm <factory wasm>] [--near <NEAR>] [--network testnet|mainnet] [--send]";
const a = withUsage(USAGE, () => {
  const p = parseArgs(process.argv.slice(2), { values: ["--parent", "--name", "--code-hash", "--fund-wasm", "--wasm", "--near", "--network"], switches: ["--send"] });
  for (const f of ["--parent", "--name"]) if (!p.values[f]) throw new UsageError(`${f} is required`);
  if (!!p.values["--code-hash"] === !!p.values["--fund-wasm"]) throw new UsageError("give exactly one of --code-hash and --fund-wasm");
  if (p.positionals.length) throw new UsageError(`unexpected argument ${p.positionals[0]}`);
  if (p.values["--network"] && !["testnet", "mainnet"].includes(p.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  if (!isAccountId(`${p.values["--name"]}.${p.values["--parent"]}`) || p.values["--name"].includes(".")) throw new UsageError(`${p.values["--name"]}.${p.values["--parent"]} is not a valid sub-account of ${p.values["--parent"]}`);
  return p;
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { NETWORK, rpc, view, accountView, accountExists, accessKeyCount, globalCode, send, TGAS, formatNear, explorer, txHash, log } = await import("./lib/near.ts");
const { ROOT, RELEASES_FILE, readReleases } = await import("./lib/fund.ts");

const parent = a.values["--parent"], factory = `${a.values["--name"]}.${parent}`;
const codeHash = a.values["--fund-wasm"] ? bs58.encode(createHash("sha256").update(fs.readFileSync(a.values["--fund-wasm"])).digest()) : hashToBase58(a.values["--code-hash"]);
if (!codeHash) throw new Error(`--code-hash ${a.values["--code-hash"]} is not a sha256 (base58 or 64 hex characters)`);
const wasmFile = a.values["--wasm"] ?? path.join(ROOT, "contracts/target/near/plinth_factory/plinth_factory.wasm");
const wasm = fs.readFileSync(wasmFile);
const storagePerByte = BigInt((await rpc<any>("EXPERIMENTAL_protocol_config", { finality: "final" })).runtime_config.storage_amount_per_byte);
const codeStorage = BigInt(wasm.length) * storagePerByte;
// Besides its code the factory stores one list entry per fund, paid from its own balance (the NEAR
// attached to create_fund all goes to the fund). Default: the code's storage plus 1 NEAR.
const near = a.values["--near"] ? parseNear(a.values["--near"]) : ((codeStorage + 10n ** 24n) / 10n ** 22n + 1n) * 10n ** 22n;
const releases = readReleases();
const release = releases.releases[codeHash];

console.log(`factory ${factory} on ${NETWORK}`);
console.log(`  factory code    ${wasmFile}: ${wasm.length} bytes, sha256 ${bs58.encode(createHash("sha256").update(wasm).digest())}`);
console.log(`  fund code hash  ${codeHash} (${release ? `release ${release.version}, commit ${release.commit}` : "not in data/releases.json: `npm run verify` will not pass funds from this factory until it is"})`);
console.log(`  starts with     ${formatNear(near)} NEAR (its code occupies ${formatNear(codeStorage)} NEAR of storage; the rest pays for the list of funds)`);
if (release?.known_issue) throw new Error(`refusing: release ${release.version} has a known issue: ${release.known_issue}`);
if (near < codeStorage + 10n ** 23n) throw new Error(`--near ${formatNear(near)} does not cover the factory's own storage (${formatNear(codeStorage)} NEAR) with 0.1 NEAR to spare`);
const published = await globalCode(codeHash);
if (!published) throw new Error(`fund code ${codeHash} is not published on ${NETWORK}; run \`npm run publish:code\` first (a factory for unpublished code can never create a fund)`);
if (bs58.encode(createHash("sha256").update(published).digest()) !== codeHash) throw new Error("the chain serves different bytes under this hash");
console.log(`  fund code       published on ${NETWORK} (${published.length} bytes)`);
if (await accountExists(factory)) throw new Error(`${factory} already exists`);
const recorded = releases.factories?.[NETWORK];
if (recorded) console.log(`  note            data/releases.json already names ${recorded} as the ${NETWORK} factory; --send replaces that entry`);

if (!a.switches.has("--send")) {
  console.log("\nnothing sent. Add --send to create the factory.");
  process.exit(0);
}
const have = BigInt((await accountView(parent)).amount);
if (have < near + 10n ** 23n) throw new Error(`${parent} holds ${formatNear(have)} NEAR; needs ${formatNear(near)} plus gas`);
const r = await send(parent, factory, [actions.createAccount(), actions.transfer(near), actions.deployContract(wasm), actions.functionCall("new", { code_hash: codeHash }, TGAS(30), 0n)]);
const tx = txHash(r);
log("created", explorer(tx));
const keys = await accessKeyCount(factory);
const stored = await view<string>(factory, "get_code_hash");
if (keys !== 0 || stored !== codeHash) throw new Error(`${factory} is not as intended: ${keys} access keys, code hash ${stored}`);
fs.writeFileSync(RELEASES_FILE, JSON.stringify({ ...releases, factories: { ...releases.factories, [NETWORK]: factory } }, null, 1) + "\n");
log("done", `${factory}: 0 access keys, creates funds running ${codeHash}; recorded in data/releases.json (factories.${NETWORK}), created in ${tx}`);
