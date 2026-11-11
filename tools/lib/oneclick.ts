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
  try {
    const msg = signedMessage(r.quoteRequest as any, r.quote as any, r.timestamp);
    const sig = bs58.decode(r.signature.replace(/^ed25519:/, ""));
    const pk = bs58.decode(key.replace(/^ed25519:/, ""));
    return ed25519.verify(sig, new TextEncoder().encode(msg), pk);
  } catch {
    return false;
  }
}

/** The 32 bytes of an ed25519 public key written as base58 with or without the `ed25519:` prefix
 *  (the contract accepts both: quote.rs `decode_public_key`). null if it is not such a key. */
export function ed25519KeyBytes(key: unknown): Uint8Array | null {
  if (typeof key !== "string") return null;
  try {
    const b = bs58.decode(key.replace(/^ed25519:/, ""));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** Whether two key strings are the same key, whatever their prefix. */
export function sameEd25519Key(a: unknown, b: unknown): boolean {
  const x = ed25519KeyBytes(a), y = ed25519KeyBytes(b);
  return !!x && !!y && x.every((v, i) => v === y[i]);
}

/** The `customRecipientMsg` release 0.3 requires: 1Click then delivers the output with
 *  `ft_transfer_call(msg = "trade:<id>")` and the trade settles inside that call. `tradeId` is the
 *  fund's `get_fund().trades` at the time of the proposal (the id the new trade will get). */
export const tradeMsg = (tradeId: number | bigint | string): string => {
  if (!/^\d+$/.test(String(tradeId))) throw new Error(`trade id must be a non-negative integer, got ${tradeId}`);
  return `trade:${BigInt(tradeId)}`;
};

export interface QuoteParams {
  fund: string;
  sellToken: string;
  buyToken: string;
  amount: string; // base units of sellToken
  /** The fund's current `get_fund().trades` (the next trade id); signed into the quote as customRecipientMsg. */
  tradeId: number;
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
    customRecipientMsg: tradeMsg(p.tradeId),
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
  const out = BigInt(quote.amountOut ?? 0);
  if (out === 0n) return 10_000n; // nothing out: the whole input is cost (and the contract refuses it)
  const worst = (outUsd * BigInt(quote.minAmountOut ?? 0)) / out;
  return inUsd === 0n ? 10_000n : ((inUsd > worst ? inUsd - worst : 0n) * 10_000n) / inUsd;
}

/** A trade as the contract reports it (`Trade` in lib.rs). */
export interface TradeView {
  id: number;
  stake: boolean;
  sell: number;
  buy: number;
  amount_in: string;
  quoted_out: string;
  min_out: string;
  refund_fee: string;
  cost_bps: number;
  deposit_address: string;
  deposit_deadline: number;
  sent_at: number;
  status: "Sending" | "Sent" | "Settled" | "Refunded" | "Failed" | "Abandoned";
  received_out: string;
  received_refund: string;
  closed_at: number | null;
}

/** `get_fund()` (FundView in lib.rs). Fields a release before 0.3 does not report are optional. */
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
      min_subscription?: string;
      max_total_subscriptions?: string;
      management_fee_bps?: number;
      staking?: { wrap_index: number; lst_index: number; min_stake: string; price_method?: string; max_price_slippage_bps?: number } | null;
      open_ended?: boolean;
      strategy?: { outlayer: string; wasm_url: string; wasm_hash: string; max_instructions: number; max_execution_seconds: number; secrets_profile?: string | null; secrets_owner?: string | null; exclusive: boolean } | null;
    };
    storage_deposit?: string;
  };
  held: [string, string][];
  total_shares?: string;
  total_subscribed?: string;
  pending: TradeView | null;
  /** Number of trades so far = the id the next trade gets. */
  trades: number;
  rejections?: number;
  last_trade_at: number;
  registered?: boolean[];
  trades_today?: number;
  near_available_for_registrations?: string;
  // Release 0.3:
  version?: string;
  owed_total?: string[];
  basket_total?: string[];
  near_free?: string;
  max_daily_cost_bps?: number;
  strategy_started?: number;
  /** In-kind joins are refused until this time (Unix seconds; 0 = not blocked). */
  joins_blocked_until?: number;
  stranded_near?: string;
}

/** Why `propose_trade` / `stake_idle` would panic for the operator, if it would. */
const noManager = (s: FundState) => (s.config.mandate.strategy?.exclusive ? ["this fund has no manager: only its strategy proposes (rebalance)"] : []);

/** The contract's stake_idle checks, off-chain, so a stake the contract would refuse is never sent
 *  (a refusal is stored on chain and spends the fund's storage NEAR). */
export function preflightStake(amount: string, s: FundState & { config: any }, nowS = Math.floor(Date.now() / 1000)): string[] {
  const why: string[] = noManager(s);
  const m: any = s.config.mandate;
  const r = m.staking;
  if (!r) return [...why, "this fund has no staking route"];
  if (!/^\d+$/.test(amount)) return [...why, `amount ${amount} is not in base units`];
  const a = BigInt(amount);
  if (nowS < m.subscription_closes_at) why.push("subscription window still open");
  if (s.pending) why.push("a trade is in flight");
  if (s.last_trade_at > 0 && nowS < s.last_trade_at + m.min_seconds_between_trades) why.push("cooldown");
  const sameDay = s.last_trade_at > 0 && Math.floor(s.last_trade_at / 86_400) === Math.floor(nowS / 86_400);
  if (sameDay && (s.trades_today ?? 0) >= m.max_trades_per_day) why.push("trades for today used up");
  if (a < BigInt(r.min_stake)) why.push(`below the minimum stake ${r.min_stake}`);
  if (a * 10_000n > BigInt(s.held[r.wrap_index][1]) * BigInt(m.max_trade_bps)) why.push(`over ${m.max_trade_bps} bps of the wNEAR held`);
  if (s.registered && (!s.registered[r.wrap_index] || !s.registered[r.lst_index])) why.push("fund not registered on a token");
  // stake_idle needs free NEAR >= reserve + 0.005 NEAR; the view reports free NEAR minus the reserve.
  if (s.near_available_for_registrations !== undefined && BigInt(s.near_available_for_registrations) < 5_000_000_000_000_000_000_000n) why.push("the fund has no NEAR left for the stake's storage");
  return why;
}

/** The contract's propose_trade checks (lib.rs `check_trade`), off-chain. Returns the reasons it
 *  would refuse (empty = it would accept). Not mirrored: whether the deposit address was used before. */
export function preflight(r: QuoteResponse, fund: string, s: FundState, nowS = Math.floor(Date.now() / 1000)): string[] {
  const why: string[] = noManager(s);
  const m = s.config.mandate;
  const q = r.quote as any;
  const req = r.quoteRequest as any;
  if (!verifySignature(r, s.config.quote_signer)) why.push("signature does not verify against the fund's quote signer");
  if (req.dry !== false) why.push("dry quote");
  if (req.swapType !== "EXACT_INPUT" || req.depositType !== "ORIGIN_CHAIN" || req.recipientType !== "DESTINATION_CHAIN") why.push("unsupported quote shape");
  if (req.recipient !== fund || req.refundTo !== fund || req.refundType !== "ORIGIN_CHAIN") why.push("must deliver to and refund to the fund");
  // Release 0.3: the output must be pushed with ft_transfer_call and the id of the trade it pays.
  if (!Number.isInteger(s.trades) || s.trades < 0) why.push("the fund reports no trade count, so the trade id cannot be checked");
  else if (req.customRecipientMsg !== tradeMsg(s.trades)) why.push(`quote must set customRecipientMsg to "${tradeMsg(s.trades)}"`);
  for (const k of ["virtualChainRecipient", "virtualChainRefundRecipient"]) if (truthy(req[k])) why.push(`${k} not supported`);
  if (truthy(q.depositMemo)) why.push("depositMemo not supported");
  // trades_today counts the UTC day of the last trade; a new day starts at zero (as in the contract).
  const sameDay = s.last_trade_at > 0 && Math.floor(s.last_trade_at / 86_400) === Math.floor(nowS / 86_400);
  if (sameDay && (s.trades_today ?? 0) >= m.max_trades_per_day) why.push("trades for today used up");
  const idx = (a: string) => m.tokens.indexOf(String(a).replace(/^nep141:/, ""));
  const sell = idx(req.originAsset), buy = idx(req.destinationAsset);
  if (sell < 0 || buy < 0) why.push("token not in the mandate");
  if (sell === buy) why.push("same token");
  if (s.registered && ((sell >= 0 && !s.registered[sell]) || (buy >= 0 && !s.registered[buy]))) why.push("fund not registered on a token");
  if (nowS < m.subscription_closes_at) why.push("subscription window still open");
  if (s.pending) why.push("a trade is in flight");
  if (s.last_trade_at > 0 && nowS < s.last_trade_at + m.min_seconds_between_trades) why.push("cooldown");
  const amountIn = BigInt(q.amountIn ?? 0), amountOut = BigInt(q.amountOut ?? 0), minOut = BigInt(q.minAmountOut ?? 0);
  if (amountIn === 0n || minOut === 0n || minOut > amountOut) why.push("quote amounts are not usable");
  if (req.amount !== undefined && String(req.amount) !== String(q.amountIn)) why.push("the quote's amount differs from the amount asked for");
  if (sell >= 0 && amountIn * 10_000n > BigInt(s.held[sell][1]) * BigInt(m.max_trade_bps)) why.push(`over ${m.max_trade_bps} bps of holding`);
  const c = costBps(q);
  if (c > BigInt(m.max_cost_bps)) why.push(`cost ${c} bps > ${m.max_cost_bps}`);
  const issued = Math.floor(Date.parse(r.timestamp) / 1000);
  if (nowS - issued > m.max_quote_age_seconds) why.push("quote too old");
  if (issued > nowS + 60) why.push("quote is dated in the future");
  if (s.near_available_for_registrations !== undefined && BigInt(s.near_available_for_registrations) < BigInt(s.config.storage_deposit ?? 0)) why.push("the fund has no NEAR left to register the deposit address");
  const deadline = Math.floor(Date.parse(q.deadline) / 1000);
  if (deadline < nowS + m.min_deadline_margin_seconds) why.push("deposit address closes too soon");
  // lib.rs MAX_DEADLINE_SECONDS: the refund windows are counted from the deadline.
  if (deadline > nowS + 14 * 86_400) why.push("the quote's deadline is more than 14 days away");
  return why;
}
