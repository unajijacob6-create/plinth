// Test doubles: a fetch that never touches the network, and a tiny fake NEAR RPC.
import type { Deps } from "../_lib/http.ts";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Responder = (call: Call) => Response | Promise<Response>;

/** Deps whose fetch records every call and answers from `responder`. Any real network use is a test failure. */
export function fakeDeps(responder: Responder, env: Record<string, string | undefined> = {}, nowMs = Date.parse("2026-11-11T00:00:00Z")): Deps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    env,
    now: () => nowMs,
    sleep: async () => {},
    fetch: (async (input: any, init: any = {}) => {
      const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: typeof init.body === "string" ? init.body : "" };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  };
}

const rpcResult = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
const rpcError = (name: string) => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data: name } });

export interface FakeChain {
  /** account id -> view_account result */
  accounts: Record<string, { code_hash: string; global_contract_hash?: string; amount?: string }>;
  /** account id -> number of access keys */
  keys?: Record<string, number>;
  /** "account.method" -> value, or a function of the args */
  views: Record<string, unknown | ((args: any) => unknown)>;
}

/** Answers `query` calls the way a NEAR RPC node does, from a table. */
export function fakeRpc(chain: FakeChain): Responder {
  return (call) => {
    const { params } = JSON.parse(call.body);
    const id: string = params.account_id;
    if (params.request_type === "view_account") {
      const a = chain.accounts[id];
      return a ? rpcResult({ amount: "1000", storage_usage: 100, ...a }) : rpcError("UNKNOWN_ACCOUNT");
    }
    if (params.request_type === "view_access_key_list") return chain.accounts[id] ? rpcResult({ keys: Array.from({ length: chain.keys?.[id] ?? 0 }, () => ({})) }) : rpcError("UNKNOWN_ACCOUNT");
    if (params.request_type === "call_function") {
      const k = `${id}.${params.method_name}`;
      if (!(k in chain.views)) return chain.accounts[id] ? rpcError("CONTRACT_EXECUTION_ERROR") : rpcError("UNKNOWN_ACCOUNT");
      const v = chain.views[k];
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
      const out = typeof v === "function" ? (v as (a: any) => unknown)(args) : v;
      return rpcResult({ result: [...Buffer.from(JSON.stringify(out))], logs: [] });
    }
    return rpcError("UNSUPPORTED");
  };
}

/** A `get_fund` answer with the fields the functions read. */
export const fundState = (o: { tokens?: string[]; held?: string[]; trades?: number; rejections?: number; version?: string } = {}) => {
  const tokens = o.tokens ?? ["pusd.plinthfund.testnet", "wrap.testnet"];
  return {
    config: { operator: "operator.plinthfund.testnet", quote_signer: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc", mandate: { tokens, max_trade_bps: 2500, max_cost_bps: 150, min_seconds_between_trades: 600, max_trades_per_day: 6, max_quote_age_seconds: 300, min_deadline_margin_seconds: 600, subscription_closes_at: 1795219200, management_fee_bps: 100 } },
    held: tokens.map((t, i) => [t, o.held?.[i] ?? "0"]),
    total_shares: "6000000",
    subscription_open: false,
    trading_open: true,
    pending: null,
    trades: o.trades ?? 0,
    rejections: o.rejections ?? 0,
    last_trade_at: 0,
    ...(o.version ? { version: o.version } : {}),
  };
};

// Each request comes from its own address unless a test says otherwise, so the per-address rate
// limits (module state shared by a test file) never couple one test to another.
let caller = 0;
const from = () => ({ "x-real-ip": `test-caller-${++caller}` });
export const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://plinth.example${path}`, { headers: { ...from(), ...headers } });
export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://plinth.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...from(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
