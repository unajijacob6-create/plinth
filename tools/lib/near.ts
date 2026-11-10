// NEAR helpers (near-api-js v7). Keys are read from ~/.near-credentials/<network>/<account>.json and
// never enter the repository. Mainnet signing needs PLINTH_MAINNET=yes in the environment as well,
// so a mainnet transaction never happens by accident.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

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
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
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
export const explorer = (tx: string) => `https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
export const txHash = (r: any): string => r?.transaction_outcome?.id ?? r?.transaction?.hash ?? "";

export function log(step: string, detail?: unknown) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail === undefined ? "" : " " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}
