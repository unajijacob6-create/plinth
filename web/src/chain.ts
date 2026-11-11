import releasesJson from "../../data/releases.json";
// Read-only NEAR RPC from the browser, and the same checks as tools/verify.ts.
import bs58 from "bs58";

export type Net = "testnet" | "mainnet";
const RPC: Record<Net, string> = { testnet: "https://rpc.testnet.fastnear.com", mainnet: "https://rpc.mainnet.fastnear.com" };
export const ONECLICK_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const keyBytes = (k: string): string | null => {
  try {
    const b = bs58.decode(String(k).replace(/^ed25519:/, ""));
    return b.length === 32 ? Array.from(b).join(",") : null;
  } catch {
    return null;
  }
};
/** True when this quote signer is NEAR Intents 1Click's key (compared as bytes, prefix or not). */
export const isOneClick = (key: unknown): boolean => typeof key === "string" && keyBytes(key) !== null && keyBytes(key) === keyBytes(ONECLICK_KEY);
/** True when the text is an ed25519 public key: base58 of 32 bytes, with or without the prefix. */
export const isEd25519Key = (key: string): boolean => keyBytes(key) !== null;
export const TEST_SIGNER_WORDS = "Test signer: quotes are signed by the fund's creator, not by NEAR Intents. Testnet stand-in only.";
export const explorer = (net: Net, tx: string) => `https://${net === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
export const accountLink = (net: Net, id: string) => `https://${net === "mainnet" ? "" : "testnet."}nearblocks.io/address/${id}`;
/** Long account names and fingerprints are never shown whole: "abcdef…wxyz". */
export const short = (s: string, head = 6, tail = 4) => (s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
/** A fund's own name without the parent it was created under, when that keeps it readable. */
export const shortAccount = (id: string) => (id.length > 28 ? short(id, 14, 10) : id);

export interface Release {
  version: string;
  commit: string;
  known_issue?: string;
  global?: boolean;
}
export const RELEASES = ((releasesJson as any).releases ?? {}) as Record<string, Release>;
const FACTORIES = ((releasesJson as any).factories ?? {}) as Partial<Record<Net, string>>;
/** The factory that creates release 0.3 funds, when one is recorded for this network. */
export const factoryOf = (net: Net): string | null => (typeof FACTORIES[net] === "string" && FACTORIES[net] ? FACTORIES[net]! : null);

/** What the RPC node calls a problem, in plain words. */
const RPC_WORDS: Record<string, string> = {
  UNKNOWN_ACCOUNT: "this account does not exist",
  INVALID_ACCOUNT: "this is not a valid account name",
  NO_CONTRACT_CODE: "this account has no contract",
  NO_GLOBAL_CONTRACT_CODE: "the published code was not found on chain",
  CONTRACT_EXECUTION_ERROR: "the contract could not answer",
  UNKNOWN_BLOCK: "the network node is behind; try again",
  TIMEOUT_ERROR: "the network node timed out; try again",
  PARSE_ERROR: "this is not a valid account name",
};
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function rpc<T = any>(net: Net, method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(RPC[net], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
        continue;
      }
      throw new RpcError("NETWORK", "the network could not be reached");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const j = await res.json().catch(() => ({ error: { cause: { name: "TIMEOUT_ERROR" } } }));
    if (j.error) {
      const code = String(j.error?.cause?.name ?? j.error?.name ?? "ERROR");
      throw new RpcError(code, RPC_WORDS[code] ?? "the network node refused the request");
    }
    // A view call that fails inside the contract comes back as a result with an error text.
    if (j.result && typeof j.result.error === "string") throw new RpcError("CONTRACT_EXECUTION_ERROR", /MethodNotFound/.test(j.result.error) ? "this account does not answer that question" : RPC_WORDS.CONTRACT_EXECUTION_ERROR);
    return j.result as T;
  }
}

export async function view<T = any>(net: Net, account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(net, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

/** The account record, or null when the account does not exist. */
export async function account(net: Net, id: string): Promise<any | null> {
  try {
    return await rpc<any>(net, "query", { request_type: "view_account", finality: "final", account_id: id });
  } catch (e) {
    if (e instanceof RpcError && e.code === "UNKNOWN_ACCOUNT") return null;
    throw e;
  }
}
export const isAccountId = (s: string) => s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);

export interface FactoryEntry {
  account_id: string;
  creator: string;
  created_at: number;
}
/** Funds a factory created, newest first: `skip` newest are passed over, then up to `limit`. */
export async function factoryFunds(net: Net, factory: string, skip: number, limit: number): Promise<{ count: number; funds: FactoryEntry[] }> {
  const count = Number(await view<number>(net, factory, "fund_count"));
  const end = Math.max(0, count - skip);
  const from = Math.max(0, end - limit);
  const funds = end > from ? await view<FactoryEntry[]>(net, factory, "get_funds", { from, limit: end - from }) : [];
  return { count, funds: funds.reverse() };
}

const NO_LOCAL_CODE = "11111111111111111111111111111111";
export interface CodeInfo {
  /** Fingerprint the chain reports for the code this account runs. */
  hash: string;
  /** How the code is attached: its own copy, a published copy fixed by fingerprint, or one another account can replace. */
  how: "own" | "published" | "replaceable";
  /** For "replaceable": the account that can change the code. */
  owner?: string;
  release: Release | null;
}
export function codeInfo(acct: any): CodeInfo {
  if (acct.global_contract_account_id) return { hash: "", how: "replaceable", owner: String(acct.global_contract_account_id), release: null };
  if (acct.global_contract_hash) return { hash: acct.global_contract_hash, how: "published", release: RELEASES[acct.global_contract_hash] ?? null };
  return { hash: acct.code_hash === NO_LOCAL_CODE ? "" : acct.code_hash, how: "own", release: RELEASES[acct.code_hash] ?? null };
}
const codeCache = new Map<string, Promise<CodeInfo | null>>();
/** Which release an account runs (cached: the code of a keyless account cannot change). */
export function releaseOf(net: Net, id: string): Promise<CodeInfo | null> {
  const key = `${net}:${id}`;
  if (!codeCache.has(key)) {
    const p = account(net, id).then((a) => (a ? codeInfo(a) : null));
    p.catch(() => codeCache.delete(key));
    codeCache.set(key, p);
  }
  return codeCache.get(key)!;
}

/** Names of the functions a wasm module imports (import section only; enough for this check). */
export function importNames(bytes: Uint8Array): string[] {
  let p = 8;
  const u32 = () => {
    let r = 0, s = 0, b = 0;
    do {
      b = bytes[p++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  const str = () => {
    const n = u32();
    const s = new TextDecoder().decode(bytes.subarray(p, p + n));
    p += n;
    return s;
  };
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not a wasm module");
  const out: string[] = [];
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = u32();
    const end = p + size;
    if (id === 2) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        str(); // module
        const name = str();
        const kind = bytes[p++];
        if (kind === 0) {
          u32();
          out.push(name);
        } else if (kind === 1) {
          p++;
          const f = bytes[p++];
          u32();
          if (f & 1) u32();
        } else if (kind === 2) {
          const f = bytes[p++];
          u32();
          if (f & 1) u32();
        } else if (kind === 3) p += 2;
        else if (kind === 4) {
          p++; // tag attribute
          u32(); // type index
        } else throw new Error(`unknown wasm import kind ${kind}: cannot vouch for this code`);
      }
    }
    p = end;
  }
  return out;
}

export const FORBIDDEN = /deploy|use_global_contract|add_key|delete_key|delete_account|stake|state_init/;

export interface Check {
  ok: boolean;
  /** A check that passes but carries a warning the reader must see. */
  warn?: boolean;
  /** A neutral fact the reader must see (not a failure, not a clean pass). */
  note?: boolean;
  label: string;
  detail: string;
}

export interface Verification {
  fund: string;
  net: Net;
  checks: Check[];
  state: any | null;
  codeHash: string;
  release: Release | null;
  /** Quotes come from a stand-in signer instead of NEAR Intents 1Click (testnet). */
  standIn: boolean;
  /** clean: everything holds. test-signer: everything holds, but quotes come from a stand-in signer (testnet). known-issue: keys and code check out, on a release with a known bug. failed: a check failed. */
  status: "clean" | "test-signer" | "known-issue" | "failed";
  ok: boolean;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Everything a depositor needs, from the chain alone. */
export async function verifyFund(net: Net, fund: string): Promise<Verification> {
  const checks: Check[] = [];
  const acct = await rpc<any>(net, "query", { request_type: "view_account", finality: "final", account_id: fund });
  const keys = await rpc<any>(net, "query", { request_type: "view_access_key_list", finality: "final", account_id: fund });
  const n = keys.keys.length;
  checks.push({ ok: n === 0, label: "No access keys", detail: n === 0 ? "Nobody can sign for this account: no redeploy, no withdrawal, no new key." : `${n} ${n === 1 ? "key" : "keys"}: ${keys.keys.map((k: any) => (k.access_key.permission === "FullAccess" ? "full access" : "limited")).join(", ")}. Whoever holds one can act for this account.` });
  const info = codeInfo(acct);
  let rel: Release | null = info.release;
  if (info.how === "replaceable") {
    // Published under an account, not under a fingerprint: that account can swap the code.
    checks.push({ ok: false, label: "Code can be replaced", detail: `This account runs code published by ${shortAccount(info.owner!)}, and that account can change it at any time. Nothing here can vouch for what it will do.` });
  } else {
    let bytes: Uint8Array | null = null;
    try {
      const code = info.how === "published" ? await rpc<any>(net, "query", { request_type: "view_global_contract_code", finality: "final", code_hash: info.hash }) : await rpc<any>(net, "query", { request_type: "view_code", finality: "final", account_id: fund });
      bytes = b64(code.code_base64);
    } catch (e) {
      checks.push({ ok: false, label: "Code could not be read", detail: `The chain did not return this account's code: ${(e as Error).message}.` });
    }
    if (bytes) {
      const hash = bs58.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
      const same = hash === info.hash;
      // The fingerprint must be one of Plinth's own releases: any other keyless contract could answer
      // like a fund and still have no exit.
      const kb = Math.round(bytes.length / 1000).toLocaleString("en");
      // A release that is published once for every fund must be used that way, fixed by fingerprint.
      const attached = !rel?.global || info.how === "published";
      checks.push({
        ok: same && !!rel && attached,
        label: rel ? `Code is Plinth release ${rel.version}` : "Code is not a known Plinth release",
        detail: !same
          ? "The code the chain returned does not match the fingerprint the account reports."
          : !rel
            ? "Its fingerprint matches no release published in this repository, so nothing here can vouch for what it does."
            : !attached
              ? `The code matches release ${rel.version}, but this account carries its own copy instead of the published one.`
              : info.how === "published"
                ? `The fund runs the one published copy of the code (${kb} KB), fixed by its fingerprint: no account can change what it runs. It matches the release built from commit ${rel.commit} of this repository.`
                : `The ${kb} KB of code on chain has the fingerprint of the release built from commit ${rel.commit} of this repository.`,
      });
      let bad: string[] | null = null;
      try {
        bad = importNames(bytes).filter((x) => FORBIDDEN.test(x));
      } catch {
        bad = null;
      }
      checks.push({
        ok: !!bad && bad.length === 0,
        label: "Code cannot change itself",
        detail: !bad ? "The code could not be read as a program, so this cannot be checked." : bad.length === 0 ? "The code has no instruction that can deploy new code, add or remove keys, stake, or delete the account." : `It can call ${bad.length} ${bad.length === 1 ? "function" : "functions"} that change code or keys.`,
      });
    }
  }
  let state: any = null;
  let standIn = false;
  try {
    state = await view(net, fund, "get_fund");
    const m = state?.config?.mandate;
    const sane = !!m && Array.isArray(m.tokens) && m.tokens.length >= 1 && m.tokens.length <= 4 && m.max_trade_bps > 0 && m.max_trade_bps <= 10_000 && m.max_cost_bps <= 10_000 && m.max_trades_per_day > 0;
    const noManager = !!m?.strategy?.exclusive;
    checks.push({
      ok: sane,
      label: "Rules reported by the contract",
      detail: noManager ? "No manager: only the fund's fixed program can propose trades, and each proposal is checked against the rules." : `The manager, ${shortAccount(String(state.config.operator))}, can only propose trades, and each one is checked against the rules.`,
    });
    if (isOneClick(state.config.quote_signer)) checks.push({ ok: true, label: "Quotes signed by NEAR Intents 1Click", detail: "A trade needs a quote signed by 1Click's own key." });
    else if (net === "mainnet") checks.push({ ok: false, label: "Quotes are not signed by NEAR Intents", detail: "This fund accepts quotes signed by a key its creator chose, not by NEAR Intents 1Click. Whoever holds that key can make up prices." });
    else {
      standIn = true;
      checks.push({ ok: true, note: true, label: "Test signer", detail: TEST_SIGNER_WORDS });
    }
  } catch {
    checks.push({ ok: false, label: "Not a Plinth fund", detail: "This account does not answer like a Plinth fund." });
  }
  const allOk = checks.every((c) => c.ok);
  if (rel?.known_issue) checks.push({ ok: true, warn: true, label: `Known issue in release ${rel.version}`, detail: "This release can count tokens that are about to bounce back as if the fund owned them. A keyless fund cannot be fixed, so treat it as history, not as safe." });
  const status = !allOk ? "failed" : rel?.known_issue ? "known-issue" : standIn ? "test-signer" : "clean";
  return { fund, net, checks, state, codeHash: info.hash, release: rel, status, standIn, ok: status === "clean" };
}
