// What `npm run verify` concludes about a fund account, as a pure function of what the chain
// reports (tested in tools/test/verify.test.ts). No network access here.
import bs58 from "bs58";

/** NEAR's code_hash of an account with no local contract (base58 of 32 zero bytes). */
export const NO_CODE_HASH = "11111111111111111111111111111111";

export interface Release {
  version: string;
  commit: string;
  note?: string;
  /** A defect of this release a depositor must know about. Verification fails unless allowed. */
  known_issue?: string;
  /** Published as a global contract by hash (funds reference the code instead of carrying it). */
  global?: boolean;
  /** How to rebuild the exact wasm from the commit. */
  reproducible?: { image: string; image_digest: string; command: string };
}

export interface ReleasesFile {
  note?: string;
  /** base58 sha256 of the wasm -> release. */
  releases: Record<string, Release>;
  /** The factory account that creates funds, per network. */
  factories?: { testnet?: string; mainnet?: string };
}

/** A sha256 written as base58 or as 64 hex characters, as base58. null if it is neither. */
export function hashToBase58(h: unknown): string | null {
  if (typeof h !== "string") return null;
  if (/^[0-9a-fA-F]{64}$/.test(h)) return bs58.encode(Buffer.from(h, "hex"));
  try {
    return bs58.decode(h).length === 32 ? h : null;
  } catch {
    return null;
  }
}

export interface FundFacts {
  /** `view_account`. */
  account: { code_hash: string; global_contract_hash?: string | null; global_contract_account_id?: string | null };
  /** Number of access keys on the account. */
  accessKeys: number;
  /** base58 sha256 of the code bytes fetched from the chain; null if they could not be fetched. */
  fetchedCodeHash: string | null;
  /** Host functions the code imports that could change code or keys (the import scan). */
  forbiddenImports: string[];
  releases: Record<string, Release>;
  allowKnownIssue: boolean;
}

export type CodeKind = "none" | "local" | "global-by-hash" | "global-by-account";

export interface Verdict {
  kind: CodeKind;
  /** The hash the account is pinned to (base58), if any. */
  codeHash: string | null;
  release: Release | null;
  checks: { ok: boolean; text: string }[];
  /** Set when the release has a known issue (whether or not it was allowed). */
  knownIssue: string | null;
  verified: boolean;
}

/** Decide whether a fund account can be trusted to run fixed, known Plinth code with no keys. */
export function classifyFund(f: FundFacts): Verdict {
  const checks: Verdict["checks"] = [];
  const check = (ok: boolean, text: string) => checks.push({ ok, text });
  const a = f.account;
  check(f.accessKeys === 0, f.accessKeys === 0 ? "access keys: 0 (nobody can sign for this account)" : `access keys: ${f.accessKeys} (whoever holds one can replace the code or move the funds)`);

  let kind: CodeKind;
  let codeHash: string | null = null;
  if (a.global_contract_account_id) {
    kind = "global-by-account";
    check(false, `code is whatever ${a.global_contract_account_id} publishes as its global contract: that account can change it at any time`);
  } else if (a.global_contract_hash) {
    kind = "global-by-hash";
    codeHash = hashToBase58(a.global_contract_hash);
    check(codeHash !== null, codeHash ? `runs the global contract with hash ${codeHash}: the chain stores those bytes under their hash and nobody can change them` : `global_contract_hash ${a.global_contract_hash} is not a sha256`);
  } else if (!a.code_hash || a.code_hash === NO_CODE_HASH) {
    kind = "none";
    check(false, "the account has no contract");
  } else {
    kind = "local";
    codeHash = hashToBase58(a.code_hash);
    check(codeHash !== null, codeHash ? `carries its own code, hash ${codeHash}` : `code_hash ${a.code_hash} is not a sha256`);
  }

  const release = codeHash ? f.releases[codeHash] ?? null : null;
  let knownIssue: string | null = null;
  if (codeHash) {
    check(f.fetchedCodeHash === codeHash, f.fetchedCodeHash === null ? "the code bytes could not be fetched from the chain" : f.fetchedCodeHash === codeHash ? "sha256 of the bytes the chain serves equals that hash" : `the bytes the chain serves hash to ${f.fetchedCodeHash}, not ${codeHash}`);
    check(!!release, release ? `code is Plinth release ${release.version} (commit ${release.commit})` : `code ${codeHash} is not a known Plinth release (data/releases.json)`);
    check(f.forbiddenImports.length === 0, f.forbiddenImports.length === 0 ? "imports no code- or key-changing host function" : `imports host functions that can change code or keys: ${f.forbiddenImports.join(" ")}`);
    if (release?.known_issue) {
      knownIssue = release.known_issue;
      check(f.allowKnownIssue, `KNOWN ISSUE in release ${release.version}: ${release.known_issue}${f.allowKnownIssue ? " (allowed by --allow-known-issue)" : ""}`);
    }
  }
  return { kind, codeHash, release, checks, knownIssue, verified: checks.every((c) => c.ok) };
}
