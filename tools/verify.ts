// npm run verify -- <fund-account> [--network mainnet|testnet] [--wasm contracts/target/near/plinth/plinth.wasm]
//
// Read-only. Checks, from the chain alone, what a depositor needs to trust Plinth:
//   1. the account has ZERO access keys (nobody can sign for it: no redeploy, no withdrawal);
//   2. the deployed code's sha256 equals its code_hash, and (with --wasm) equals a local build;
//   3. the deployed wasm imports no host function that can deploy code, add/delete keys, stake or
//      delete the account (so even the contract itself can never do it);
//   4. the mandate, operator and quote signer the contract will enforce, as it reports them.
// Exit code 0 only if 1-3 hold.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import bs58 from "bs58";

const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (opt("--network")) process.env.NEAR_NETWORK = opt("--network");
const { rpc, view, NETWORK } = await import("./lib/near.ts");
const fund = argv.find((a) => !a.startsWith("--") && a !== opt("--network") && a !== opt("--wasm"));
if (!fund) {
  console.error("usage: npm run verify -- <fund-account> [--network mainnet|testnet] [--wasm path]");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { analyze } = require("../contracts/wasm-reach.cjs");
const FORBIDDEN = /deploy|use_global_contract|add_key|delete_key|delete_account|stake|state_init/;

let ok = true;
const check = (pass: boolean, line: string) => {
  console.log(`${pass ? "  ok " : "  XX "} ${line}`);
  if (!pass) ok = false;
};

console.log(`Plinth verify: ${fund} on ${NETWORK}`);
const acct = await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: fund });
const keys = await rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: fund });
check(keys.keys.length === 0, `access keys: ${keys.keys.length} (${keys.keys.length ? keys.keys.map((k: any) => k.public_key).join(", ") : "nobody can sign for this account"})`);

const code = await rpc<any>("query", { request_type: "view_code", finality: "final", account_id: fund });
const bytes = Buffer.from(code.code_base64, "base64");
const hash = bs58.encode(createHash("sha256").update(bytes).digest());
check(hash === acct.code_hash, `code_hash ${acct.code_hash} = sha256 of the deployed bytes (${bytes.length} bytes)`);
const wasm = opt("--wasm");
if (wasm) {
  const local = bs58.encode(createHash("sha256").update(fs.readFileSync(wasm)).digest());
  check(local === hash, `local build ${wasm} hashes to ${local}`);
}
const a = analyze(bytes);
const bad = a.importFuncNames.filter((n: string) => FORBIDDEN.test(n));
check(bad.length === 0, `imports no code/key-changing host function${bad.length ? `: ${bad.join(" ")}` : ""}`);

try {
  const meta = await view<any>(fund, "contract_source_metadata");
  console.log(`       source: ${meta.link ?? "?"} version ${meta.version ?? "?"}`);
} catch {
  console.log("       source: (no contract_source_metadata)");
}
const f = await view<any>(fund, "get_fund");
const m = f.config.mandate;
console.log(`       operator (can only propose trades): ${f.config.operator}`);
console.log(`       quote signer: ${f.config.quote_signer}${f.config.quote_signer === "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc" ? " (NEAR Intents 1Click)" : " (NOT the 1Click key: a test signer)"}`);
console.log(`       mandate: tokens ${m.tokens.join(", ")}; trade <= ${m.max_trade_bps} bps of holding; cost <= ${m.max_cost_bps} bps; >= ${m.min_seconds_between_trades}s between trades; quotes <= ${m.max_quote_age_seconds}s old`);
console.log(`       holdings: ${f.held.map(([t, v]: [string, string]) => `${v} ${t}`).join(", ")}; shares ${f.total_shares}; trades ${f.trades}; refusals ${f.rejections}${f.pending ? `; trade ${f.pending.id} in flight` : ""}`);
console.log(ok ? "verified: nobody can change this fund or block its exit" : "NOT verified");
process.exit(ok ? 0 : 1);
