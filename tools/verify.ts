// npm run verify -- <fund-account> [--network mainnet|testnet] [--wasm <local build>] [--allow-known-issue]
//
// Read-only. Checks, from the chain alone, what a depositor needs to trust Plinth:
//   1. the account has ZERO access keys (nobody can sign for it: no redeploy, no withdrawal);
//   2. where its code comes from, and that it cannot change:
//        - release 0.3 funds run a global contract pinned BY HASH (`global_contract_hash`): the
//          chain stores those bytes under their sha256 and nobody can replace them. The bytes are
//          fetched (view_global_contract_code) and hashed here;
//        - an account that follows another account's global contract (`global_contract_account_id`)
//          is REJECTED: that account can publish different code at any time;
//        - releases 0.1 and 0.2 carry their own code (`code_hash`); it is fetched and hashed too;
//   3. the hash is a release listed in data/releases.json (and, with --wasm, equals a local build);
//   4. the code imports no host function that can deploy code, add/delete keys, stake or delete
//      the account (so even the contract itself can never do it);
//   5. the release has no known issue. Releases 0.1 and 0.2 have one (they count bounced transfers
//      as holdings): they fail unless --allow-known-issue is given, and the warning is printed
//      either way.
// Then prints the version, mandate, operator and quote signer the contract reports.
// Exit code 0 only if 1-5 hold.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import bs58 from "bs58";
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";
import { classifyFund, type ReleasesFile } from "./lib/classify.ts";
import { ONECLICK_KEY, sameEd25519Key, type FundState } from "./lib/oneclick.ts";

plainErrors();
const USAGE = "usage: npm run verify -- <fund-account> [--network mainnet|testnet] [--wasm <local build>] [--allow-known-issue]";
const a = withUsage(USAGE, () => {
  const p = parseArgs(process.argv.slice(2), { values: ["--network", "--wasm"], switches: ["--allow-known-issue"] });
  if (p.positionals.length !== 1) throw new UsageError("give exactly one fund account");
  if (p.values["--network"] && !["testnet", "mainnet"].includes(p.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  return p;
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { rpc, view, accountView, accessKeyCount, globalCode, NETWORK } = await import("./lib/near.ts");
const fund = a.positionals[0];
const require = createRequire(import.meta.url);
const { analyze } = require("../contracts/wasm-reach.cjs");
const FORBIDDEN = /deploy|use_global_contract|add_key|delete_key|delete_account|stake|state_init/;
const sha = (b: Uint8Array) => bs58.encode(createHash("sha256").update(b).digest());

console.log(`Plinth verify: ${fund} on ${NETWORK}`);
const acct = await accountView(fund);
const releases = (JSON.parse(fs.readFileSync(new URL("../data/releases.json", import.meta.url), "utf8")) as ReleasesFile).releases;

// The code bytes, from wherever the account's code lives. A fund that follows another account's
// global contract is rejected by classifyFund without looking at any bytes.
let bytes: Buffer | null = null;
if (acct.global_contract_account_id) {
  bytes = null;
} else if (acct.global_contract_hash) {
  const pre = classifyFund({ account: acct, accessKeys: 0, fetchedCodeHash: null, forbiddenImports: [], releases, allowKnownIssue: true });
  bytes = pre.codeHash ? await globalCode(pre.codeHash) : null;
} else if (acct.code_hash && !/^1+$/.test(acct.code_hash)) {
  bytes = Buffer.from((await rpc<{ code_base64: string }>("query", { request_type: "view_code", finality: "final", account_id: fund })).code_base64, "base64");
}
let forbiddenImports: string[] = [];
if (bytes) {
  try {
    forbiddenImports = analyze(bytes).importFuncNames.filter((n: string) => FORBIDDEN.test(n));
  } catch (e) {
    // Code the scanner cannot read is not vouched for.
    forbiddenImports = [`(import scan failed: ${(e as Error).message})`];
  }
}
const v = classifyFund({ account: acct, accessKeys: await accessKeyCount(fund), fetchedCodeHash: bytes ? sha(bytes) : null, forbiddenImports, releases, allowKnownIssue: a.switches.has("--allow-known-issue") });
let ok = v.verified;
for (const c of v.checks) console.log(`${c.ok ? "  ok " : "  XX "} ${c.text}`);
if (bytes) console.log(`       code: ${bytes.length} bytes, ${v.kind === "global-by-hash" ? "published once as a global contract; the fund stores only the hash" : "stored on the fund account"}`);
if (v.release?.reproducible) console.log(`       reproducible build: ${v.release.reproducible.command} in ${v.release.reproducible.image}@${v.release.reproducible.image_digest}`);
if (a.values["--wasm"] && v.codeHash) {
  const local = sha(fs.readFileSync(a.values["--wasm"]));
  const same = local === v.codeHash;
  console.log(`${same ? "  ok " : "  XX "} local build ${a.values["--wasm"]} hashes to ${local}`);
  if (!same) ok = false;
}

if (v.kind !== "none") {
  try {
    const meta = await view<any>(fund, "contract_source_metadata");
    console.log(`       source: ${meta.link ?? "?"} version ${meta.version ?? "?"}`);
  } catch {
    console.log("       source: (no contract_source_metadata)");
  }
  try {
    const f = await view<FundState>(fund, "get_fund");
    const m = f.config.mandate;
    // The contract accepts the key with or without the `ed25519:` prefix: compare the key bytes.
    const oneclick = sameEd25519Key(f.config.quote_signer, ONECLICK_KEY);
    console.log(`       version reported by get_fund: ${f.version ?? "(none: a release before 0.3)"}`);
    if (v.release && f.version && !f.version.startsWith(v.release.version)) {
      console.log(`  XX  get_fund reports version ${f.version}, but the code hash is release ${v.release.version}`);
      ok = false;
    }
    console.log(`       operator (${m.strategy?.exclusive ? "receives the fee only; cannot propose" : "can only propose trades"}): ${f.config.operator}`);
    console.log(`       quote signer: ${f.config.quote_signer}${oneclick ? " (NEAR Intents 1Click)" : " (NOT the 1Click key: a test signer)"}`);
    console.log(`       mandate: tokens ${m.tokens.join(", ")}; trade <= ${m.max_trade_bps} bps of holding; cost <= ${m.max_cost_bps} bps; >= ${m.min_seconds_between_trades}s between trades; <= ${m.max_trades_per_day} trades a day; quotes <= ${m.max_quote_age_seconds}s old${f.max_daily_cost_bps !== undefined ? `; trading can cost at most ${f.max_daily_cost_bps} bps of a holding a day` : ""}`);
    console.log(`       fee ${m.management_fee_bps ?? 0} bps/yr; staking ${m.staking ? `${m.tokens[m.staking.wrap_index]} -> ${m.tokens[m.staking.lst_index]}` : "none"}; in-kind joins ${m.open_ended ? "yes" : "no"}`);
    if (m.strategy) console.log(`       strategy${m.strategy.exclusive ? " (no manager: only it proposes)" : ""}: wasm sha256 ${m.strategy.wasm_hash} from ${m.strategy.wasm_url}, run by ${m.strategy.outlayer}; the fund cannot verify the TEE on chain, so the answer is bounded by the mandate like an operator's proposal`);
    console.log(`       holdings: ${f.held.map(([t, x]) => `${x} ${t}`).join(", ")}; shares ${f.total_shares}; trades ${f.trades}; refusals ${f.rejections}${f.pending ? `; trade ${f.pending.id} in flight` : ""}`);
  } catch (e) {
    console.log(`  XX  get_fund failed: ${(e as Error).message.slice(0, 200)}`);
    ok = false;
  }
}
if (v.knownIssue) console.log(`\nKNOWN ISSUE (release ${v.release!.version}): ${v.knownIssue}\nDepositors of this fund can still redeem; do not add money to it.`);
console.log(ok ? (v.knownIssue ? "code and keys verified, WITH THE KNOWN ISSUE ABOVE (--allow-known-issue)" : "verified: nobody can change this fund or block its exit") : "NOT verified");
process.exit(ok ? 0 : 1);
