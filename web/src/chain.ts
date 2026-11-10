import releases from "../../data/releases.json";
// Read-only NEAR RPC from the browser, and the same checks as tools/verify.ts.
import bs58 from "bs58";

export type Net = "testnet" | "mainnet";
const RPC: Record<Net, string> = { testnet: "https://rpc.testnet.fastnear.com", mainnet: "https://rpc.mainnet.fastnear.com" };
export const ONECLICK_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
export const explorer = (net: Net, tx: string) => `https://${net === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
export const accountLink = (net: Net, id: string) => `https://${net === "mainnet" ? "" : "testnet."}nearblocks.io/address/${id}`;

export async function rpc<T = any>(net: Net, method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC[net], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(j.error?.cause?.name ?? j.error?.data ?? JSON.stringify(j.error).slice(0, 160));
    return j.result as T;
  }
}

export async function view<T = any>(net: Net, account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(net, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
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
  label: string;
  detail: string;
}

export interface Verification {
  fund: string;
  net: Net;
  checks: Check[];
  state: any | null;
  codeHash: string;
  ok: boolean;
}

/** Everything a depositor needs, from the chain alone. */
export async function verifyFund(net: Net, fund: string): Promise<Verification> {
  const checks: Check[] = [];
  const acct = await rpc<any>(net, "query", { request_type: "view_account", finality: "final", account_id: fund });
  const keys = await rpc<any>(net, "query", { request_type: "view_access_key_list", finality: "final", account_id: fund });
  checks.push({ ok: keys.keys.length === 0, label: "No access keys", detail: keys.keys.length === 0 ? "Nobody can sign for this account: no redeploy, no withdrawal, no new key." : `${keys.keys.length} key(s): ${keys.keys.map((k: any) => (k.access_key.permission === "FullAccess" ? "full access" : "limited")).join(", ")}` });
  const code = await rpc<any>(net, "query", { request_type: "view_code", finality: "final", account_id: fund });
  const bytes = Uint8Array.from(atob(code.code_base64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = bs58.encode(digest);
  // The fingerprint must be one of Plinth's own releases: any other keyless contract could answer
  // like a fund and still have no exit.
  const rel = (releases.releases as Record<string, { version: string; commit: string }>)[acct.code_hash];
  checks.push({
    ok: hash === acct.code_hash && !!rel,
    label: rel ? `Code is Plinth release ${rel.version}` : "Code is not a known Plinth release",
    detail: rel ? `The ${Math.round(bytes.length / 1000).toLocaleString("en")} KB of code on chain has the fingerprint of the release built from commit ${rel.commit} of this repository.` : "Its fingerprint matches no release published in this repository, so nothing here can vouch for what it does.",
  });
  const bad = importNames(bytes).filter((n) => FORBIDDEN.test(n));
  checks.push({ ok: bad.length === 0, label: "Code cannot change itself", detail: bad.length === 0 ? "The code has no instruction that can deploy new code, add or remove keys, stake, or delete the account." : `It can call functions that change code or keys (${bad.length}).` });
  let state: any = null;
  try {
    state = await view(net, fund, "get_fund");
    const real = state.config.quote_signer === ONECLICK_KEY;
    const m = state?.config?.mandate;
    const sane = !!m && Array.isArray(m.tokens) && m.tokens.length >= 1 && m.tokens.length <= 4 && m.max_trade_bps > 0 && m.max_trade_bps <= 10_000;
    checks.push({ ok: sane, label: "Rules reported by the contract", detail: `Operator ${state.config.operator} can only propose trades. Quotes must be signed by ${real ? "NEAR Intents 1Click" : "a test signer, not 1Click"}.` });
  } catch {
    checks.push({ ok: false, label: "Not a Plinth fund", detail: "This account does not answer like a Plinth fund." });
  }
  return { fund, net, checks, state, codeHash: acct.code_hash, ok: checks.every((c) => c.ok) };
}
