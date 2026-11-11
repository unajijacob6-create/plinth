// NEAR helpers (near-api-js v7). Keys are read from ~/.near-credentials/<network>/<account>.json and
// never enter the repository. Mainnet signing needs PLINTH_MAINNET=yes in the environment as well,
// so a mainnet transaction never happens by accident.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, actions, type KeyPairString } from "near-api-js";

export type Network = "testnet" | "mainnet";
export const NETWORK = (process.env.NEAR_NETWORK ?? "testnet") as Network;
export const RPC_URL = process.env.NEAR_RPC_URL ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");
export const provider = new JsonRpcProvider({ url: RPC_URL });

// A custom RPC URL could point at a different chain than NEAR_NETWORK says; the mainnet guard below
// would then be bypassed. Check the chain the RPC actually serves before anything can sign.
if (process.env.NEAR_RPC_URL) {
  const st: any = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) }).then((r) => r.json());
  const chain = st?.result?.chain_id;
  if (chain !== NETWORK) throw new Error(`NEAR_RPC_URL serves chain ${chain}, but NEAR_NETWORK is ${NETWORK}`);
}

export function loadKey(accountId: string): KeyPairString {
  const file = path.join(os.homedir(), ".near-credentials", NETWORK, `${accountId}.json`);
  if (!fs.existsSync(file)) throw new Error(`No ${NETWORK} credentials for ${accountId} at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")).private_key as KeyPairString;
}

export function signer(accountId: string): Account {
  if (NETWORK === "mainnet" && process.env.PLINTH_MAINNET !== "yes") throw new Error("refusing to sign on mainnet without PLINTH_MAINNET=yes");
  return new Account(accountId, provider, loadKey(accountId));
}

export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const j: any = await res.json();
    // `rpcName` is the node's own error name (UNKNOWN_ACCOUNT, NO_GLOBAL_CONTRACT_CODE, ...).
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error?.cause?.name ?? ""} ${JSON.stringify(j.error.data ?? j.error).slice(0, 300)}`), { rpcName: j.error?.cause?.name as string | undefined });
    return j.result as T;
  }
}

export async function view<T = any>(contract: string, method: string, args: Record<string, unknown> = {}, blockId?: number): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...(blockId ? { block_id: blockId } : { finality: "final" }),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

export const TGAS = (n: number) => BigInt(n) * 10n ** 12n;
export const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
/** yoctoNEAR as a decimal NEAR string, exact. */
export function formatNear(yocto: bigint): string {
  const s = yocto.toString().padStart(25, "0");
  const frac = s.slice(-24).replace(/0+$/, "");
  return `${s.slice(0, -24)}${frac ? "." + frac : ""}`;
}
export const explorer = (tx: string) => `https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
export const txHash = (r: any): string => r?.transaction_outcome?.id ?? r?.transaction?.hash ?? "";

/** The JSON a transaction's final receipt returned (null if it returned nothing or failed). */
export function returned<T = any>(r: any): T | null {
  const v = r?.status?.SuccessValue;
  if (typeof v !== "string" || v === "") return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString()) as T;
  } catch {
    return null;
  }
}

/** Why a transaction failed, as text; null if it succeeded. */
export function failure(r: any): string | null {
  const f = r?.status?.Failure;
  return f ? JSON.stringify(f).slice(0, 400) : null;
}

/** Every log line of every receipt of a transaction, in execution order. */
export const logsOf = (r: any): string[] => (r?.receipts_outcome ?? []).flatMap((o: any) => o?.outcome?.logs ?? []);

/** The `EVENT_JSON:` logs of a transaction, parsed: [{standard, event, data}]. */
export function eventsOf(r: any): { standard: string; event: string; data: any }[] {
  const out = [];
  for (const l of logsOf(r)) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(l.slice("EVENT_JSON:".length));
      out.push({ standard: e.standard, event: e.event, data: e.data?.[0] });
    } catch {
      // not JSON: skip
    }
  }
  return out;
}

export interface CallOptions {
  deposit?: bigint;
  /** TGas attached (default 100). */
  gas?: number;
  /** Return the outcome of a failed transaction instead of throwing. */
  allowFailure?: boolean;
}

/** Sign and send a batch of actions, waiting until every receipt has run and is final. */
export async function send(from: string, receiverId: string, acts: unknown[], o: { allowFailure?: boolean } = {}): Promise<any> {
  return signer(from).signAndSendTransaction({ receiverId, actions: acts as any, waitUntil: "FINAL", throwOnFailure: !o.allowFailure });
}

/** One function call, waiting until every receipt has run and is final. */
export async function call(from: string, contractId: string, methodName: string, args: Record<string, unknown>, o: CallOptions = {}): Promise<any> {
  return send(from, contractId, [actions.functionCall(methodName, args, TGAS(o.gas ?? 100), o.deposit ?? 0n)], o);
}

export interface AccountView {
  amount: string;
  code_hash: string;
  storage_usage: number;
  /** Set when the account runs a global contract pinned by its code hash. */
  global_contract_hash?: string | null;
  /** Set when the account runs whatever global contract this account last published. */
  global_contract_account_id?: string | null;
}

export const accountView = (id: string) => rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: id });
export const accountExists = (id: string) => accountView(id).then(() => true, (e) => (e?.rpcName === "UNKNOWN_ACCOUNT" ? false : Promise.reject(e)));
export const accessKeyCount = async (id: string) => (await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id })).keys.length;
/** Chain time in Unix seconds, from the last final block. */
export const chainSeconds = async () => Number(BigInt((await rpc<any>("block", { finality: "final" })).header.timestamp) / 1_000_000_000n);

/** The bytes of a global contract published by hash (base58), or null if the chain has no such code. */
export async function globalCode(codeHashBase58: string): Promise<Buffer | null> {
  try {
    const r = await rpc<{ code_base64: string }>("query", { request_type: "view_global_contract_code", finality: "final", code_hash: codeHashBase58 });
    return Buffer.from(r.code_base64, "base64");
  } catch (e) {
    if ((e as any)?.rpcName === "NO_GLOBAL_CONTRACT_CODE") return null;
    throw e;
  }
}

export function log(step: string, detail?: unknown) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail === undefined ? "" : " " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}
