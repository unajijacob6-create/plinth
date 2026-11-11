// What `npm run verify` concludes (tools/lib/classify.ts), for every kind of account it can meet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { NO_CODE_HASH, classifyFund, hashToBase58, type FundFacts, type RelayFacts, type Release, type ReleasesFile } from "../lib/classify.ts";

const b58 = (seed: string) => bs58.encode(createHash("sha256").update(seed).digest());
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const OLD = b58("release 0.2 wasm"), NEW = b58("release 0.3 wasm"), OTHER = b58("someone else's wasm");
const RELEASES: Record<string, Release> = {
  [OLD]: { version: "0.2", commit: "4cad1b0", known_issue: "counts bounced transfers as holdings; see README" },
  [NEW]: { version: "0.3", commit: "abcdef0", global: true, reproducible: { image: "sourcescan/cargo-near:0.23.0-rust-1.99.1", image_digest: "sha256:00", command: "cargo near build reproducible-wasm" } },
};
const FUND = "alpha.funds.near", RELAY = "alpha-r.funds.near";
/** A sound relay for a fund on release NEW: keyless, same pinned code, serving the fund. */
const relay = (o: Partial<RelayFacts> = {}): RelayFacts => ({ account_id: RELAY, account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, accessKeys: 0, servesFund: FUND, ...o });
const facts = (o: Partial<FundFacts>): FundFacts => ({ account: { code_hash: NO_CODE_HASH }, accessKeys: 0, fetchedCodeHash: null, forbiddenImports: [], releases: RELEASES, allowKnownIssue: false, fund: FUND, relay: relay(), ...o });
const sound = (o: Partial<FundFacts> = {}) => facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: NEW, ...o });
const failed = (f: FundFacts) => classifyFund(f).checks.filter((c) => !c.ok).map((c) => c.text).join("\n");

test("a legacy fund with its own code: hash verified, but it fails on the known issue unless allowed", () => {
  const f = facts({ account: { code_hash: OLD }, fetchedCodeHash: OLD });
  const v = classifyFund(f);
  assert.equal(v.kind, "local");
  assert.equal(v.release?.version, "0.2");
  assert.equal(v.knownIssue, "counts bounced transfers as holdings; see README");
  assert.equal(v.verified, false);
  assert.match(failed(f), /^KNOWN ISSUE in release 0\.2: counts bounced transfers as holdings; see README$/, "the known issue is the only failed check");
  const allowed = classifyFund({ ...f, allowKnownIssue: true });
  assert.equal(allowed.verified, true);
  assert.equal(allowed.knownIssue, "counts bounced transfers as holdings; see README", "still reported when allowed");
});

test("a fund running a known release as a global contract by hash verifies", () => {
  const v = classifyFund(facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: NEW }));
  assert.equal(v.kind, "global-by-hash");
  assert.equal(v.codeHash, NEW);
  assert.equal(v.release?.version, "0.3");
  assert.equal(v.knownIssue, null);
  assert.equal(v.verified, true);
  assert.equal(v.checks.every((c) => c.ok), true);
});

test("the global hash is accepted as base58 or as hex", () => {
  const v = classifyFund(facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: hex("release 0.3 wasm") }, fetchedCodeHash: NEW }));
  assert.equal(v.codeHash, NEW);
  assert.equal(v.verified, true);
  assert.equal(hashToBase58(hex("x").toUpperCase()), b58("x"));
  assert.equal(hashToBase58(b58("x")), b58("x"));
  for (const bad of ["", "abc", "0x" + hex("x"), hex("x").slice(2), 5, null, undefined]) assert.equal(hashToBase58(bad), null, String(bad));
  const garbled = classifyFund(facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: "not-a-hash" }, fetchedCodeHash: null }));
  assert.equal(garbled.verified, false);
});

test("a fund that follows another account's global contract is rejected, whatever that code is today", () => {
  const f = facts({ account: { code_hash: NO_CODE_HASH, global_contract_account_id: "publisher.near" }, fetchedCodeHash: NEW });
  const v = classifyFund(f);
  assert.equal(v.kind, "global-by-account");
  assert.equal(v.verified, false);
  assert.equal(v.release, null);
  assert.match(failed(f), /publisher\.near.*can change it at any time/);
  // Not rescued by --allow-known-issue, and not by also naming a hash.
  assert.equal(classifyFund({ ...f, allowKnownIssue: true }).verified, false);
  assert.equal(classifyFund(facts({ account: { code_hash: NO_CODE_HASH, global_contract_account_id: "publisher.near", global_contract_hash: NEW }, fetchedCodeHash: NEW })).verified, false);
});

test("an unknown hash is not verified, global or local", () => {
  for (const account of [{ code_hash: NO_CODE_HASH, global_contract_hash: OTHER }, { code_hash: OTHER }]) {
    const f = facts({ account, fetchedCodeHash: OTHER });
    assert.equal(classifyFund(f).verified, false);
    assert.match(failed(f), /is not a known Plinth release/);
  }
});

test("access keys fail a fund even when its code is a known release", () => {
  const f = facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: NEW, accessKeys: 1 });
  assert.equal(classifyFund(f).verified, false);
  assert.match(failed(f), /^access keys: 1/);
  const old = facts({ account: { code_hash: OLD }, fetchedCodeHash: OLD, accessKeys: 2, allowKnownIssue: true });
  assert.equal(classifyFund(old).verified, false);
});

test("the bytes the chain serves must hash to the pinned hash, and must be fetched", () => {
  const wrong = facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: OTHER });
  assert.equal(classifyFund(wrong).verified, false);
  assert.match(failed(wrong), /hash to .* not /);
  const none = facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: null });
  assert.equal(classifyFund(none).verified, false);
  assert.match(failed(none), /could not be fetched/);
});

test("code that imports a code- or key-changing host function is not verified", () => {
  const f = facts({ account: { code_hash: NO_CODE_HASH, global_contract_hash: NEW }, fetchedCodeHash: NEW, forbiddenImports: ["promise_batch_action_deploy_contract"] });
  assert.equal(classifyFund(f).verified, false);
  assert.match(failed(f), /promise_batch_action_deploy_contract/);
});

// ---------------------------------------------------------------- the refund relay

test("a sound fund with a sound relay verifies, and each relay check is printed", () => {
  const v = classifyFund(sound());
  assert.equal(v.verified, true);
  const text = v.checks.map((c) => c.text).join("\n");
  assert.match(text, /refund relay alpha-r\.funds\.near: 0 access keys/);
  assert.match(text, /refund relay runs the same pinned code as the fund/);
  assert.match(text, /refund relay hands refunds to this fund only/);
  // The relay's hash may be reported in hex.
  assert.equal(classifyFund(sound({ relay: relay({ account: { code_hash: NO_CODE_HASH, global_contract_hash: hex("release 0.3 wasm") } }) })).verified, true);
});

test("a relay with an access key fails the fund", () => {
  const f = sound({ relay: relay({ accessKeys: 1 }) });
  assert.equal(classifyFund(f).verified, false);
  assert.match(failed(f), /^refund relay alpha-r\.funds\.near has 1 access key\(s\)/);
});

test("a relay running different code fails the fund", () => {
  for (const account of [
    { code_hash: NO_CODE_HASH, global_contract_hash: OTHER }, // another global contract
    { code_hash: NO_CODE_HASH, global_contract_hash: OLD }, // another Plinth release
    { code_hash: OTHER }, // its own copy of some code
    { code_hash: NO_CODE_HASH }, // no code at all
  ]) {
    const f = sound({ relay: relay({ account }) });
    assert.equal(classifyFund(f).verified, false, JSON.stringify(account));
    assert.match(failed(f), /^refund relay code is .*, not the fund's /);
  }
  const follows = sound({ relay: relay({ account: { code_hash: NO_CODE_HASH, global_contract_account_id: "publisher.near", global_contract_hash: NEW } }) });
  assert.equal(classifyFund(follows).verified, false);
  assert.match(failed(follows), /refund relay runs whatever publisher\.near publishes/);
});

test("a relay that serves another fund, or is not a relay, fails the fund", () => {
  const other = sound({ relay: relay({ servesFund: "beta.funds.near" }) });
  assert.equal(classifyFund(other).verified, false);
  assert.match(failed(other), /^refund relay serves beta\.funds\.near, not this fund$/);
  const mute = sound({ relay: relay({ servesFund: null }) });
  assert.equal(classifyFund(mute).verified, false);
  assert.match(failed(mute), /does not answer relay_fund/);
});

test("a missing relay fails the fund: none named, account gone, or no facts given", () => {
  const unnamed = sound({ relay: relay({ account_id: null }) });
  assert.match(failed(unnamed), /reports no refund relay/);
  const gone = sound({ relay: relay({ account: null }) });
  assert.match(failed(gone), /^refund relay alpha-r\.funds\.near does not exist$/);
  const nofacts = sound({ relay: undefined });
  assert.match(failed(nofacts), /reports no refund relay/);
  for (const f of [unnamed, gone, nofacts]) assert.equal(classifyFund(f).verified, false);
});

test("releases 0.1 and 0.2 had no relay: none is asked of a fund that carries its own code", () => {
  const v = classifyFund(facts({ account: { code_hash: OLD }, fetchedCodeHash: OLD, allowKnownIssue: true, relay: undefined }));
  assert.equal(v.verified, true);
  assert.doesNotMatch(v.checks.map((c) => c.text).join(), /relay/);
});

test("an account with no contract is not a fund", () => {
  const v = classifyFund(facts({}));
  assert.equal(v.kind, "none");
  assert.equal(v.verified, false);
});

test("data/releases.json: 0.1 and 0.2 carry the known issue, the old shape still reads, and no entry is malformed", () => {
  const file = JSON.parse(fs.readFileSync(new URL("../../data/releases.json", import.meta.url), "utf8")) as ReleasesFile;
  const byVersion = Object.fromEntries(Object.entries(file.releases).map(([h, r]) => [r.version, { h, ...r }]));
  for (const v of ["0.1", "0.2"]) assert.equal(byVersion[v].known_issue, "counts bounced transfers as holdings; see README", v);
  for (const [h, r] of Object.entries(file.releases)) {
    assert.equal(hashToBase58(h), h, `${h} is a base58 sha256`);
    // The website reads releases.releases[<code hash>] = {version, commit}.
    assert.equal(typeof r.version, "string");
    assert.equal(typeof r.commit, "string");
    if (r.global !== undefined) assert.equal(typeof r.global, "boolean");
    if (r.reproducible) for (const k of ["image", "image_digest", "command"] as const) assert.equal(typeof r.reproducible[k], "string", `${r.version}.reproducible.${k}`);
    // A release that fixes the accounting bug is one published as a global contract.
    if (!r.known_issue) assert.equal(r.global, true, `release ${r.version} has no known issue, so it must be a global (0.3+) release`);
  }
  assert.equal(typeof file.factories, "object");
  for (const [net, id] of Object.entries(file.factories ?? {})) {
    assert.match(net, /^(testnet|mainnet)$/);
    assert.match(String(id), net === "mainnet" ? /\.near$/ : /\.testnet$/);
  }
});
