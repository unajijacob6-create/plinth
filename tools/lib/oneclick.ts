// NEAR Intents 1Click: request quotes and verify their signatures exactly as the Plinth contract
// does (contracts/plinth/src/quote.rs). The operator runs this check before proposing, so a quote
// the contract would refuse is caught off-chain first (unless you want the refusal on chain).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

export const ONECLICK_API = process.env.ONECLICK_API ?? "https://1click.chaindefuser.com";
/** 1Click manager key, as shipped in @defuse-protocol/one-click-sdk-typescript. */
export const ONECLICK_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

export interface QuoteResponse {
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp: string;
  correlationId?: string;
}

const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === 0 || v === "");

/** base58(sha256(stable json)) of the signed field subset; mirrors quote.rs `signed_message`. */
export function signedMessage(req: Record<string, any>, quote: Record<string, any>, timestamp: string): string {
  const f: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) f[k] = v;
  };
  for (const k of ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"]) put(k, req[k]);
  for (const k of ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"]) if (truthy(req[k])) put(k, req[k]);
  for (const k of ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"]) put(k, quote[k]);
  if (req.dry === false) for (const k of ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"]) if (truthy(quote[k])) put(k, quote[k]);
  put("timestamp", timestamp);
  const json = "{" + Object.keys(f).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(f[k])}`).join(",") + "}";
  return bs58.encode(sha256(new TextEncoder().encode(json)));
}

export function verifySignature(r: QuoteResponse, key = ONECLICK_KEY): boolean {
  const msg = signedMessage(r.quoteRequest as any, r.quote as any, r.timestamp);
  const sig = bs58.decode(r.signature.replace(/^ed25519:/, ""));
  const pk = bs58.decode(key.replace(/^ed25519:/, ""));
  try {
    return ed25519.verify(sig, new TextEncoder().encode(msg), pk);
  } catch {
    return false;
  }
}

export interface QuoteParams {
  fund: string;
  sellToken: string;
  buyToken: string;
  amount: string; // base units of sellToken
  dry: boolean;
  slippageBps?: number;
  deadlineMinutes?: number;
}

/** POST /v0/quote. recipient and refundTo are the fund; origin and destination are NEAR NEP-141. */
export async function requestQuote(p: QuoteParams): Promise<QuoteResponse> {
  const body = {
    dry: p.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: `nep141:${p.sellToken}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${p.buyToken}`,
    amount: p.amount,
    refundTo: p.fund,
    refundType: "ORIGIN_CHAIN",
    recipient: p.fund,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + (p.deadlineMinutes ?? 10) * 60_000).toISOString(),
    quoteWaitingTimeMs: 0,
  };
  const res = await fetch(`${ONECLICK_API}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "plinth/0.1 (+https://github.com/unajijacob6-create/plinth)" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click quote HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as QuoteResponse;
}

export async function status(depositAddress: string): Promise<{ status: string; [k: string]: unknown }> {
  const res = await fetch(`${ONECLICK_API}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: { "user-agent": "plinth/0.1" } });
  if (!res.ok) throw new Error(`1Click status HTTP ${res.status}`);
  return (await res.json()) as any;
}

const usdMicros = (s: string): bigint => {
  const [i, f = ""] = s.split(".");
  if (!/^\d+$/.test(i) || !/^\d*$/.test(f)) throw new Error(`not a decimal: ${s}`);
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};

/** All-in cost in bps at the worst-case output; mirrors lib.rs `cost_bps`. */
export function costBps(quote: Record<string, any>): bigint {
  const inUsd = usdMicros(String(quote.amountInUsd));
  const outUsd = usdMicros(String(quote.amountOutUsd));
  const worst = (outUsd * BigInt(quote.minAmountOut)) / BigInt(quote.amountOut);
  return inUsd === 0n ? 10_000n : ((inUsd > worst ? inUsd - worst : 0n) * 10_000n) / inUsd;
}

export interface FundState {
  config: {
    operator: string;
    quote_signer: string;
    mandate: {
      tokens: string[];
      max_trade_bps: number;
      max_cost_bps: number;
      min_seconds_between_trades: number;
      max_trades_per_day: number;
      max_quote_age_seconds: number;
      min_deadline_margin_seconds: number;
      subscription_closes_at: number;
    };
  };
  held: [string, string][];
  pending: unknown | null;
  last_trade_at: number;
  registered?: boolean[];
  trades_today?: number;
}

/** The contract's checks, off-chain. Returns the reasons it would refuse (empty = it would accept). */
export function preflight(r: QuoteResponse, fund: string, s: FundState, nowS = Math.floor(Date.now() / 1000)): string[] {
  const why: string[] = [];
  const m = s.config.mandate;
  const q = r.quote as any;
  const req = r.quoteRequest as any;
  if (!verifySignature(r, s.config.quote_signer)) why.push("signature does not verify against the fund's quote signer");
  if (req.dry !== false) why.push("dry quote");
  if (req.swapType !== "EXACT_INPUT" || req.depositType !== "ORIGIN_CHAIN" || req.recipientType !== "DESTINATION_CHAIN") why.push("unsupported quote shape");
  if (req.recipient !== fund || req.refundTo !== fund || req.refundType !== "ORIGIN_CHAIN") why.push("must deliver to and refund to the fund");
  if (truthy(req.customRecipientMsg)) why.push("customRecipientMsg not allowed");
  for (const k of ["virtualChainRecipient", "virtualChainRefundRecipient"]) if (truthy(req[k])) why.push(`${k} not supported`);
  if (truthy(q.depositMemo)) why.push("depositMemo not supported");
  if ((s.trades_today ?? 0) >= m.max_trades_per_day) why.push("trades for today used up");
  const idx = (a: string) => m.tokens.indexOf(String(a).replace(/^nep141:/, ""));
  const sell = idx(req.originAsset), buy = idx(req.destinationAsset);
  if (sell < 0 || buy < 0) why.push("token not in the mandate");
  if (sell === buy) why.push("same token");
  if (s.registered && ((sell >= 0 && !s.registered[sell]) || (buy >= 0 && !s.registered[buy]))) why.push("fund not registered on a token");
  if (nowS < m.subscription_closes_at) why.push("subscription window still open");
  if (s.pending) why.push("a trade is in flight");
  if (s.last_trade_at > 0 && nowS < s.last_trade_at + m.min_seconds_between_trades) why.push("cooldown");
  if (sell >= 0 && BigInt(q.amountIn) * 10_000n > BigInt(s.held[sell][1]) * BigInt(m.max_trade_bps)) why.push(`over ${m.max_trade_bps} bps of holding`);
  const c = costBps(q);
  if (c > BigInt(m.max_cost_bps)) why.push(`cost ${c} bps > ${m.max_cost_bps}`);
  const issued = Math.floor(Date.parse(r.timestamp) / 1000);
  if (nowS - issued > m.max_quote_age_seconds) why.push("quote too old");
  if (Math.floor(Date.parse(q.deadline) / 1000) < nowS + m.min_deadline_margin_seconds) why.push("deposit address closes too soon");
  return why;
}
