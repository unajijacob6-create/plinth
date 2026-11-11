// Read-only NEAR RPC for the functions. No keys, no signing: only `query` calls.
import type { Deps } from "./http.ts";

export type Network = "testnet" | "mainnet";
export const RPC_URLS: Record<Network, string> = { testnet: "https://rpc.testnet.fastnear.com", mainnet: "https://rpc.mainnet.fastnear.com" };

/** NEAR account id: 2-64 characters, lowercase a-z 0-9, parts joined by single - _ or . (the same
 *  rule as tools/lib/config.ts `isAccountId`). Nothing else is ever put into a URL, a page or an RPC call. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s: unknown): s is string => typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);

export function parseNetwork(v: string | null | undefined): Network | null {
  if (v === null || v === undefined || v === "" || v === "testnet") return "testnet";
  return v === "mainnet" ? "mainnet" : null;
}

export class RpcError extends Error {
  /** The node's own error name (UNKNOWN_ACCOUNT, CONTRACT_EXECUTION_ERROR, ...) when it gave one. */
  rpcName?: string;
  constructor(message: string, rpcName?: string) {
    super(message);
    this.rpcName = rpcName;
  }
}

export interface AccountView {
  amount: string;
  code_hash: string;
  storage_usage: number;
  global_contract_hash?: string | null;
  global_contract_account_id?: string | null;
}

export interface Near {
  network: Network;
  rpc<T = any>(method: string, params: unknown): Promise<T>;
  view<T = any>(account: string, method: string, args?: Record<string, unknown>): Promise<T>;
  account(id: string): Promise<AccountView>;
  accessKeyCount(id: string): Promise<number>;
}

const RPC_TIMEOUT_MS = 8000;

export function near(deps: Deps, network: Network): Near {
  const url = RPC_URLS[network];
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    // One retry when the public RPC answers 429; after that the caller gets the error.
    for (let attempt = 0; ; attempt++) {
      const res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (res.status === 429 && attempt === 0) {
        await res.arrayBuffer().catch(() => {});
        await deps.sleep(500);
        continue;
      }
      if (res.status === 429) throw new RpcError("the NEAR RPC is rate limiting this server (HTTP 429)", "RATE_LIMITED");
      const j: any = await res.json().catch(() => null);
      if (!j) throw new RpcError(`the NEAR RPC answered HTTP ${res.status} without JSON`);
      if (j.error) throw new RpcError(String(j.error?.cause?.name ?? j.error?.name ?? "RPC error") + ": " + JSON.stringify(j.error.data ?? j.error.message ?? "").slice(0, 200), j.error?.cause?.name);
      // Older nodes report a failed view inside the result.
      if (j.result && typeof j.result.error === "string") throw new RpcError(j.result.error.slice(0, 200), "CONTRACT_EXECUTION_ERROR");
      return j.result as T;
    }
  }
  return {
    network,
    rpc,
    async view<T>(account: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = await rpc<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
    },
    account: (id) => rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: id }),
    accessKeyCount: async (id) => (await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id })).keys.length,
  };
}
