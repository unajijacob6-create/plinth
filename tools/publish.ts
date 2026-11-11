// npm run publish:code -- --wasm <file> [--network testnet|mainnet] [--from <account> --send]
//
// Publish the fund code ONCE as a NEP-591 global contract by hash. The chain stores the bytes under
// their sha256; nobody, the publisher included, can change what that hash runs. Every fund the
// factory creates references the hash instead of carrying its own copy of the code.
//
// Without --send nothing is signed: the script prints the hash, whether the chain already has that
// code, and what publishing burns. With --send it sends one DeployGlobalContract (by hash) action
// from --from to itself. Mainnet also needs PLINTH_MAINNET=yes.
import fs from "node:fs";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { actions } from "near-api-js";
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";

plainErrors();
const USAGE = "usage: npm run publish:code -- --wasm <file> [--network testnet|mainnet] [--from <account> --send]";
const a = withUsage(USAGE, () => {
  const p = parseArgs(process.argv.slice(2), { values: ["--wasm", "--network", "--from"], switches: ["--send"] });
  if (!p.values["--wasm"]) throw new UsageError("--wasm is required");
  if (p.positionals.length) throw new UsageError(`unexpected argument ${p.positionals[0]}`);
  if (p.values["--network"] && !["testnet", "mainnet"].includes(p.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  if (p.switches.has("--send") && !p.values["--from"]) throw new UsageError("--send needs --from <account> (it pays the burn and signs)");
  return p;
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { NETWORK, rpc, accountView, globalCode, send, formatNear, explorer, txHash, log } = await import("./lib/near.ts");
const { readReleases } = await import("./lib/fund.ts");

/** nearcore parameter `global_contract_storage_amount_per_byte` (0.0001 NEAR): publishing burns this
 *  for every byte of code. It is 10x the storage staking price and, unlike staking, never returned.
 *  The RPC's protocol config does not report it, so it is a constant here. */
const GLOBAL_BURN_PER_BYTE = 100_000_000_000_000_000_000n;

const wasm = fs.readFileSync(a.values["--wasm"]);
if (wasm.subarray(0, 4).toString("hex") !== "0061736d") throw new Error(`${a.values["--wasm"]} is not a wasm file`);
const digest = createHash("sha256").update(wasm).digest();
const hash = bs58.encode(digest);
const burn = BigInt(wasm.length) * GLOBAL_BURN_PER_BYTE;
const storagePerByte = BigInt((await rpc<any>("EXPERIMENTAL_protocol_config", { finality: "final" })).runtime_config.storage_amount_per_byte);
const release = readReleases().releases[hash];

console.log(`fund code ${a.values["--wasm"]}: ${wasm.length} bytes`);
console.log(`  sha256 (hex)    ${digest.toString("hex")}`);
console.log(`  sha256 (base58) ${hash}   <- the global contract hash, and the factory's code_hash`);
console.log(`  release         ${release ? `${release.version} (commit ${release.commit})${release.known_issue ? ` KNOWN ISSUE: ${release.known_issue}` : ""}` : "not in data/releases.json yet"}`);
console.log(`  burn to publish ${formatNear(burn)} NEAR = ${wasm.length} bytes x ${formatNear(GLOBAL_BURN_PER_BYTE)} NEAR (10x the ${formatNear(storagePerByte)} NEAR/byte storage price on ${NETWORK}; burnt once, not returned), plus gas`);

const onChain = await globalCode(hash);
if (onChain) {
  const same = createHash("sha256").update(onChain).digest().equals(digest);
  console.log(`  on ${NETWORK}        already published (${onChain.length} bytes${same ? ", identical" : ", BUT THE BYTES DIFFER"})`);
  if (!same) process.exit(1);
  if (a.switches.has("--send")) console.log("nothing to send: publishing the same bytes again would only burn NEAR");
  process.exit(0);
}
console.log(`  on ${NETWORK}        not published`);
if (release?.known_issue) throw new Error(`refusing to publish release ${release.version}: ${release.known_issue}`);

if (!a.switches.has("--send")) {
  console.log(`\nnothing sent. To publish: npm run publish:code -- --wasm ${a.values["--wasm"]} --network ${NETWORK} --from <account> --send`);
  process.exit(0);
}

const from = a.values["--from"]!;
const acct = await accountView(from);
// After the burn the account must still cover its own storage; keep 0.1 NEAR on top for gas.
const needed = burn + BigInt(acct.storage_usage) * storagePerByte + 10n ** 23n;
if (BigInt(acct.amount) < needed) throw new Error(`${from} holds ${formatNear(BigInt(acct.amount))} NEAR; publishing needs about ${formatNear(needed)} NEAR (burn + its own storage + gas)`);
log("publishing", `${wasm.length} bytes as global contract ${hash} from ${from} on ${NETWORK}`);
const r = await send(from, from, [actions.deployGlobalContract(wasm, "codeHash")]);
log("sent", explorer(txHash(r)));
// The code is distributed shard by shard after the transaction; wait until the RPC serves it.
let served: Buffer | null = null;
for (let i = 0; i < 40 && !served; i++) {
  served = await globalCode(hash);
  if (!served) await new Promise((res) => setTimeout(res, 3000));
}
if (!served) throw new Error(`the transaction is final but ${NETWORK} does not serve global code ${hash} yet; run this command again without --send to check`);
if (!createHash("sha256").update(served).digest().equals(digest)) throw new Error("the chain serves different bytes under this hash");
const burnt = BigInt(acct.amount) - BigInt((await accountView(from)).amount);
log("published", `${hash}: ${served.length} bytes on ${NETWORK}; ${from} paid ${formatNear(burnt)} NEAR in total`);
console.log(`\nnext: npm run factory:deploy -- --parent <account> --name <sub> --code-hash ${hash} --network ${NETWORK} --send`);
