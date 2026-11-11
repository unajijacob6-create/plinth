// GET /api/funds and GET /api/fund: what the chain says about Plinth funds, read with view calls only.
// These answers are a convenience (one request instead of many, cached by the CDN). They are not a
// verification: the site's verifier and `npm run verify` read the chain themselves and check the code.
import releasesFile from "../../data/releases.json" with { type: "json" };
import { NO_CODE_HASH, hashToBase58, type Release, type ReleasesFile } from "../../tools/lib/classify.ts";
import { fail, json, mapLimit, methodNotAllowed, type Deps } from "./http.ts";
import { RpcError, isAccountId, near, parseNetwork, type AccountView, type Near, type Network } from "./near.ts";

const RELEASES = releasesFile as ReleasesFile;

/** Funds created before the factory existed (the three on the site: open, demo, earning). They run
 *  releases 0.1 / 0.2, which have a known issue (data/releases.json), and stay listed so their
 *  depositors can find them and exit. */
export const LEGACY_FUNDS: Record<Network, string[]> = {
  testnet: ["open2.plinthfund.testnet", "fund-mwa9jwo8.plinthfund.testnet", "earn-mwad1ypv.plinthfund.testnet"],
  mainnet: [],
};

export const CACHE_CHAIN = "public, max-age=0, s-maxage=20, stale-while-revalidate=60";
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const TAIL = 10;

/** The factory for a network: PLINTH_FACTORY_<NETWORK> if set (not a secret), else data/releases.json. */
export function factoryFor(network: Network, env: Deps["env"], releases: ReleasesFile = RELEASES): string | null {
  const f = env[`PLINTH_FACTORY_${network.toUpperCase()}`] || releases.factories?.[network];
  return isAccountId(f) ? f : null;
}

export interface CodeInfo {
  kind: "none" | "local" | "global-by-hash" | "global-by-account";
  /** base58 sha256 the account is pinned to, if any. */
  hash: string | null;
  release: { version: string; commit: string; note?: string; known_issue?: string } | null;
}

/** Which code an account runs and whether its hash is a Plinth release. Looks the hash up; does not
 *  download or inspect the code. */
export function codeInfo(a: Pick<AccountView, "code_hash" | "global_contract_hash" | "global_contract_account_id">, releases: Record<string, Release> = RELEASES.releases): CodeInfo {
  let kind: CodeInfo["kind"];
  let hash: string | null = null;
  if (a.global_contract_account_id) kind = "global-by-account";
  else if (a.global_contract_hash) {
    kind = "global-by-hash";
    hash = hashToBase58(a.global_contract_hash);
  } else if (!a.code_hash || a.code_hash === NO_CODE_HASH) kind = "none";
  else {
    kind = "local";
    hash = hashToBase58(a.code_hash);
  }
  const r = hash ? releases[hash] : undefined;
  return { kind, hash, release: r ? { version: r.version, commit: r.commit, ...(r.note ? { note: r.note } : {}), ...(r.known_issue ? { known_issue: r.known_issue } : {}) } : null };
}

export interface FundSummary {
  id: string;
  legacy: boolean;
  known_issue: boolean;
  /** false when the account did not answer `get_fund` (then `error` says why and the rest is absent). */
  ok: boolean;
  error?: string;
  creator?: string;
  created_at?: number;
  release?: string | null;
  version?: string | null;
  operator?: string;
  tokens?: string[];
  held?: [string, string][];
  total_shares?: string;
  trades?: number;
  rejections?: number;
  subscription_open?: boolean;
  trading_open?: boolean;
  subscription_closes_at?: number;
  pending?: boolean;
  open_ended?: boolean;
  management_fee_bps?: number;
  staking?: boolean;
  strategy?: boolean;
}

/** The few fields of `get_fund` a list needs. */
export function compactFund(s: any): Omit<FundSummary, "id" | "legacy" | "known_issue" | "ok"> {
  const m = s?.config?.mandate ?? {};
  return {
    version: typeof s?.version === "string" ? s.version : null,
    operator: s?.config?.operator,
    tokens: m.tokens,
    held: s?.held,
    total_shares: s?.total_shares,
    trades: Number(s?.trades ?? 0),
    rejections: Number(s?.rejections ?? 0),
    subscription_open: s?.subscription_open,
    trading_open: s?.trading_open,
    subscription_closes_at: m.subscription_closes_at,
    pending: !!s?.pending,
    open_ended: !!m.open_ended,
    management_fee_bps: m.management_fee_bps ?? 0,
    staking: !!m.staking,
    strategy: !!m.strategy,
  };
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export interface FundsList {
  network: Network;
  factory: string | null;
  /** Set when a factory is configured but could not be read; the legacy list is still returned. */
  factory_error?: string;
  factory_code_hash?: string;
  factory_release?: string | null;
  /** Number of funds the factory has created (0 without a factory). */
  fund_count: number;
  from: number;
  limit: number;
  /** Factory funds of this page, newest first, then the legacy funds. */
  funds: FundSummary[];
  fetched_at: string;
}

export async function listFunds(n: Near, o: { factory: string | null; from?: number; limit?: number; legacy?: string[]; releases?: Record<string, Release>; now: number }): Promise<FundsList> {
  const releases = o.releases ?? RELEASES.releases;
  const limit = Math.min(LIST_MAX, Math.max(1, o.limit ?? LIST_DEFAULT));
  const out: FundsList = { network: n.network, factory: o.factory, fund_count: 0, from: 0, limit, funds: [], fetched_at: new Date(o.now).toISOString() };
  let entries: { account_id: string; creator: string; created_at: number }[] = [];
  let factoryIssue = false;
  let factoryRelease: string | null = null;
  if (o.factory) {
    try {
      const [count, codeHash] = await Promise.all([n.view<number>(o.factory, "fund_count"), n.view<string>(o.factory, "get_code_hash")]);
      out.fund_count = Number(count);
      // Without `from`: the newest page.
      out.from = Math.min(Math.max(0, o.from ?? out.fund_count - limit), out.fund_count);
      const rel = releases[codeHash];
      out.factory_code_hash = codeHash;
      out.factory_release = factoryRelease = rel?.version ?? null;
      factoryIssue = !!rel?.known_issue;
      if (out.fund_count > out.from) entries = (await n.view<typeof entries>(o.factory, "get_funds", { from: out.from, limit })).filter((e) => isAccountId(e?.account_id));
    } catch (e) {
      out.factory_error = short(e);
      entries = [];
    }
  }
  const legacyIds = (o.legacy ?? LEGACY_FUNDS[n.network]).filter((id) => !entries.some((e) => e.account_id === id));
  const jobs: { id: string; legacy: boolean; entry?: (typeof entries)[number] }[] = [...entries.reverse().map((e) => ({ id: e.account_id, legacy: false, entry: e })), ...legacyIds.map((id) => ({ id, legacy: true }))];
  out.funds = await mapLimit(jobs, 6, async (j): Promise<FundSummary> => {
    const base = { id: j.id, legacy: j.legacy, ...(j.entry ? { creator: j.entry.creator, created_at: Number(j.entry.created_at) } : {}) };
    try {
      // Factory funds all run the factory's code; a legacy fund's release comes from its own account.
      const [state, acct] = await Promise.all([n.view<any>(j.id, "get_fund"), j.legacy ? n.account(j.id).catch(() => null) : Promise.resolve(null)]);
      const rel = j.legacy ? (acct ? codeInfo(acct, releases).release : null) : null;
      return { ...base, known_issue: j.legacy ? true : factoryIssue, ok: true, release: j.legacy ? rel?.version ?? null : factoryRelease, ...compactFund(state) };
    } catch (e) {
      return { ...base, known_issue: j.legacy ? true : factoryIssue, ok: false, error: short(e) };
    }
  });
  return out;
}

export interface FundDetail {
  id: string;
  network: Network;
  legacy: boolean;
  /** The release's known issue, in words; null if none is recorded. */
  known_issue: string | null;
  /** Created by the configured factory (its account name ends in the factory's). */
  from_factory: boolean;
  account: { amount: string; storage_usage: number; code_hash: string; global_contract_hash: string | null; global_contract_account_id: string | null };
  access_keys: number;
  code: CodeInfo;
  /** `get_fund()` as the contract returns it; null if the account does not answer like a fund. */
  fund: any | null;
  fund_error?: string;
  /** The newest entries, oldest first (as the contract pages them). */
  trades: any[];
  rejections: any[];
  fetched_at: string;
}

const tail = (count: number, k: number) => ({ from: Math.max(0, count - k), limit: k });

/** Everything about one fund. Throws RpcError with rpcName UNKNOWN_ACCOUNT if there is no such account. */
export async function fundDetail(n: Near, id: string, o: { factory: string | null; now: number; history?: boolean; releases?: Record<string, Release> }): Promise<FundDetail> {
  const [acct, keys, state] = await Promise.all([n.account(id), n.accessKeyCount(id), n.view<any>(id, "get_fund").then((s) => ({ s, e: undefined as string | undefined }), (e) => ({ s: null, e: short(e) }))]);
  const code = codeInfo(acct, o.releases);
  const s = state.s;
  const [trades, rejections] =
    s && o.history !== false
      ? await Promise.all([
          Number(s.trades) > 0 ? n.view<any[]>(id, "get_trades", tail(Number(s.trades), TAIL)).catch(() => []) : Promise.resolve([]),
          Number(s.rejections) > 0 ? n.view<any[]>(id, "get_rejections", tail(Number(s.rejections), TAIL)).catch(() => []) : Promise.resolve([]),
        ])
      : [[], []];
  return {
    id,
    network: n.network,
    legacy: LEGACY_FUNDS[n.network].includes(id),
    known_issue: code.release?.known_issue ?? null,
    from_factory: !!o.factory && id.endsWith(`.${o.factory}`),
    account: { amount: acct.amount, storage_usage: acct.storage_usage, code_hash: acct.code_hash, global_contract_hash: acct.global_contract_hash ?? null, global_contract_account_id: acct.global_contract_account_id ?? null },
    access_keys: keys,
    code,
    fund: s,
    ...(state.e ? { fund_error: state.e } : {}),
    trades,
    rejections,
    fetched_at: new Date(o.now).toISOString(),
  };
}

/** RPC trouble as an HTTP answer: 404 for an unknown account, 503 when the RPC is the problem. */
export function rpcFailure(e: unknown, id?: string): Response {
  if (e instanceof RpcError && e.rpcName === "UNKNOWN_ACCOUNT") return fail(404, "unknown_account", `There is no account ${id ?? ""} on this network.`.replace("  ", " "));
  if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return fail(504, "rpc_timeout", "The NEAR RPC did not answer in time.");
  return fail(503, "rpc_unavailable", `The NEAR RPC could not be read: ${short(e)}`, { "retry-after": "5" });
}

const intParam = (v: string | null): number | undefined => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : undefined);

export async function handleFunds(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const q = new URL(request.url).searchParams;
  const network = parseNetwork(q.get("network"));
  if (!network) return fail(400, "bad_network", `"network" is testnet or mainnet.`);
  try {
    const list = await listFunds(near(deps, network), { factory: factoryFor(network, deps.env), from: intParam(q.get("from")), limit: intParam(q.get("limit")), now: deps.now() });
    return json(list, 200, { "cache-control": CACHE_CHAIN });
  } catch (e) {
    return rpcFailure(e);
  }
}

export async function handleFund(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const q = new URL(request.url).searchParams;
  const network = parseNetwork(q.get("network"));
  if (!network) return fail(400, "bad_network", `"network" is testnet or mainnet.`);
  const id = q.get("id");
  if (!isAccountId(id)) return fail(400, "bad_account_id", `"id" must be a NEAR account id.`);
  try {
    const d = await fundDetail(near(deps, network), id, { factory: factoryFor(network, deps.env), now: deps.now() });
    return json(d, 200, { "cache-control": CACHE_CHAIN });
  } catch (e) {
    return rpcFailure(e, id);
  }
}
