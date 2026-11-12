// Live fund cards and wallet actions (testnet): the list of funds, what each holds, joining,
// exiting, joining in kind, and the buttons anyone can press.
import { view, settle, keyCount, explorer, accountLink, releaseOf, factoryOf, factoryFunds, shortAccount, short, isOneClick, TEST_SIGNER_WORDS, type CodeInfo, type FactoryEntry } from "./chain.ts";
import { onAccount, restore, signIn, signOut, send, isCancel, currentAccount, canBatch, ChainFailure, PartlySent, type Call } from "./wallet.ts";
import autoRun from "../../data/auto-run.json";
import { loadMeta, hasMeta, fmt, symbol, dec, units, plain, parseUnits, pct, pctOf, loadPrices, havePrices, usd, money } from "./tokens.ts";

export { fmt, loadMeta } from "./tokens.ts";
export { explorer };

const NET = "testnet" as const;
const STORAGE = "1250000000000000000000";
const BASKET_DEPOSIT = "5000000000000000000000"; // 0.005 NEAR, fixed by the contract
const REBALANCE_DEPOSIT = "10000000000000000000000"; // 0.01 NEAR
const TGAS = (n: number) => `${n}000000000000`;
const REDEEM_WAIT_SECONDS = 600;
const STRATEGY_TIMEOUT_SECONDS = 600;
const PAGE = 6;
/** What one trade's record costs the fund in storage, on top of the deposit-address registration. */
const TRADE_RECORD_NEAR = 3_500_000_000_000_000_000_000n; // ~0.0035 NEAR (300 to 370 bytes)
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const now = () => Math.floor(Date.now() / 1000);
const tail = (n: number, k: number) => ({ from: Math.max(0, n - k), limit: Math.min(n, k) });
const big = (v: unknown) => BigInt(String(v ?? "0"));

/** Where a fund's Share link points: this page with the fund preselected, or the API's short link. */
export function shareUrl(id: string): string {
  const api = import.meta.env.VITE_PLINTH_API as string | undefined;
  if (typeof api === "string") return `${api.replace(/\/$/, "") || location.origin}/f/${encodeURIComponent(id)}`;
  return `${location.origin}${import.meta.env.BASE_URL}app/?fund=${encodeURIComponent(id)}`;
}

/** A message this page wrote itself: shown as it is. */
export class UserError extends Error {}

/** Text that reads like code is never shown: the chain keeps the exact words. */
const codeLike = (s: string) => /[{}_()"]|\d{8,}/.test(s);

/** The contract's refusal reasons, in plain words for the page (the chain keeps the exact text). */
export function humanReason(r: string): string {
  // Exact, one decimal, rounded up so a trade just over the limit never reads as equal to it.
  const over = (a: string, b: string) => {
    if (BigInt(b) === 0n) return "all";
    const tenths = (BigInt(a) * 1000n + BigInt(b) - 1n) / BigInt(b);
    return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""}%`;
  };
  const rules: [RegExp, (...m: string[]) => string][] = [
    [/^trade of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => (BigInt(held) === 0n ? "The fund holds none of that token" : `Trade is ${over(a, held)} of the holding; the limit is ${Number(bps) / 100}%`)],
    [/^stake of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => (BigInt(held) === 0n ? "The fund holds no wNEAR to stake" : `Stake is ${over(a, held)} of the wNEAR held; the limit is ${Number(bps) / 100}%`)],
    [/^stake of \d+ is below the minimum \d+$/, () => "Stake is below the fund's minimum"],
    [/^all-in cost (\d+) bps is over the mandate's (\d+) bps$/, (_, c, m) => `Trade would cost ${Number(c) / 100}%; the limit is ${Number(m) / 100}%`],
    [/^quote is (\d+) s old; the mandate allows (\d+) s$/, (_, a, m) => `Quote is ${a} seconds old; the limit is ${m}`],
    [/^quote must deliver to/, () => "The trade would pay someone other than the fund"],
    [/^quote must set customRecipientMsg/, () => "The quote does not tell 1Click to hand the output to the fund with this trade's tag"],
    [/^(.+) -> (.+) is not allowed by the mandate$/, () => "That pair of tokens is not allowed by the fund's rules"],
    [/^the quote's deposit address closes too soon$/, () => "The quote expires too soon"],
    [/^this deposit address was already used$/, () => "The quote was already used once"],
    [/^quote signature does not verify/, () => "The quote is not signed by the signer this fund accepts"],
    [/^quote must be a live/, () => "The quote is only an estimate, not a live quote"],
    [/^quote has no usable USD marks$/, () => "The quote carries no usable prices"],
    [/^quote amounts are not usable$/, () => "The amounts in the quote do not add up"],
    [/^quote(Request)?[ .]/, () => "The quote is incomplete or malformed"],
    [/^customRecipientMsg is not allowed$|^(.+) is not supported$/, () => "The quote asks for an option the fund does not allow"],
    [/^the strategy's (trade|stake) has no/, () => "The program's proposal was incomplete"],
    [/^this fund has no staking route$/, () => "This fund cannot stake"],
    [/^the fund is not registered on one of these tokens$/, () => "The fund is not set up to hold one of these tokens"],
    [/^the fund has no NEAR left/, () => "The fund has no NEAR left for running costs"],
    [/^trading starts when the subscription window closes$/, () => "Trading starts when the join window closes"],
    [/^the mandate's trades for today are used up$/, () => "The fund's trades for today are used up"],
  ];
  for (const [re, f] of rules) {
    const m = r.match(re);
    if (m) return f(...m);
  }
  if (!r || codeLike(r)) return "The proposal broke the fund's rules";
  return r.charAt(0).toUpperCase() + r.slice(1);
}

/** Why a transaction failed, in plain words. */
function humanFailure(e: unknown): string {
  const raw = String((e as any)?.message ?? e ?? "");
  const rules: [RegExp, string][] = [
    [/not enough shares/, "you do not have that many shares"],
    [/a trade is in flight; settle it or wait|a trade is in flight; wait for it to close/, "a trade is in flight; exits open once it closes, or 10 minutes after it was sent"],
    [/a trade is in flight; join when/, "a trade is in flight; join once it has settled"],
    [/basket is too small/, "the fund's holdings changed, so what you added no longer covers the shares you asked for"],
    [/no basket/, "you have no tokens waiting in this fund"],
    [/does not take in-kind joins/, "this fund does not take new joiners after its window"],
    [/subscription window is open/, "the join window is still open; join with the base token"],
    [/failed stake is being wrapped back/, "in-kind joins are paused while NEAR from a failed stake is wrapped back into the fund"],
    [/written-off trade can still be/, "in-kind joins are paused while a written-off trade can still be refunded or delivered"],
    [/no shares to price a join|holds nothing to join/, "the fund is empty, so there is nothing to join in proportion to"],
    [/The account doesn't have enough balance|not enough balance to transfer/i, "the refund account does not hold that amount any more"],
    [/another trade is being sent/, "another trade is being sent; try again shortly"],
    [/strategy run is in flight/, "a run is already in progress; try again in a few minutes"],
    [/trading starts when/, "trading starts when the join window closes"],
    [/already in flight/, "a trade is already in flight"],
    [/too soon after the last trade/, "it is too soon after the last trade"],
    [/trades for today are used up/, "the fund's trades for today are used up"],
    [/attach NEAR|attach 300|attach 0\.005|attach at least/, "the wallet did not attach enough NEAR or gas"],
    [/nothing owed/, "nothing is owed to you"],
    [/Exceeded the prepaid gas|GasExceeded/i, "the transaction ran out of gas"],
    [/NotEnoughBalance|LackBalanceForState|not enough balance/i, "your account does not hold enough NEAR for this"],
  ];
  if (e instanceof UserError) return raw;
  for (const [re, words] of rules) if (re.test(raw)) return words;
  if (e instanceof ChainFailure) return codeLike(raw) ? "the transaction failed on chain" : raw;
  return !raw || codeLike(raw) || raw.length > 140 ? "something went wrong; nothing was changed by this page" : raw;
}

const ago = (s: number) => {
  const d = Math.max(0, now() - s);
  return d < 90 ? `${d}s ago` : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 172800 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
};
const day = (s: number) => new Date(s * 1000).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });

interface Step {
  label: string;
  state: "todo" | "doing" | "done" | "failed";
}
interface Mine {
  shares: bigint;
  owed: string[];
  /** Tokens waiting towards an in-kind join; null when there is no basket. */
  basket: bigint[] | null;
}
interface FundCard {
  id: string;
  title: string;
  blurb: string;
  group: "new" | "legacy";
  el: HTMLElement;
  info?: CodeInfo | null;
  state?: any;
  keyCount?: number;
  trades: any[];
  rejections: any[];
  mine: Mine | null;
  /** What the fund's refund account holds of each token (refunds waiting to be handed over). */
  relay: bigint[] | null;
  /** The connected account's balance of each of the fund's tokens (read while the in-kind panel is open). */
  balances: bigint[] | null;
  /** Kept across re-renders so a result message and typed amounts are never wiped. */
  msg: string;
  msgTx: string;
  busy: boolean;
  /** The first read failed: the card shows why, and the totals do not wait for it. */
  failed?: boolean;
  ui: {
    joinAmt: string;
    exitAmt: string;
    kindAmt: string;
    kindMode: "base" | "pct";
    kindOpen: boolean;
    tradesShown: number;
    refusalsShown: number;
    /** Whether the reader opened the card's details; kept across refreshes. */
    details: boolean;
    steps: Step[];
  };
}

/**
 * What this page lets you do with a fund's code, decided from the chain:
 * "full" for a listed release with no known issue, published once and fixed by its fingerprint;
 * "exit" for a listed old release with a known issue (your way out must stay open);
 * "none" for anything else: shown read-only, no wallet action can send it your tokens.
 */
type Trust = "full" | "exit" | "none";
function trustOf(f: FundCard): Trust {
  const info = f.info;
  if (!info || !info.release) return "none";
  if (info.release.known_issue) return "exit";
  return info.how === "published" && info.release.global ? "full" : "none";
}
const EXIT_ACTIONS = new Set(["exit", "claim", "pct-25", "pct-50", "pct-100"]);

/** Exit is blocked by the contract for 10 minutes after a trade is sent, until it settles. */
function exitWait(s: any): number {
  return s.pending ? Math.max(0, Number(s.pending.sent_at) + REDEEM_WAIT_SECONDS - now()) : 0;
}
const isV03 = (s: any) => typeof s?.version === "string";
/** The most trading can cost a holding in a day, rounded up: it is an upper bound. */
const worstDay = (s: any) => {
  const m = s.config.mandate;
  return Math.min(10_000, Math.ceil((m.max_trade_bps * m.max_cost_bps * m.max_trades_per_day) / 10_000));
};
/** Shares are shown like the base token: one share was issued per base token paid in at launch. */
const shareDec = (s: any) => dec(s.config.mandate.tokens[0]);
const shareWord = (n: string) => (n === "1" ? "share" : "shares");

/** A round number of shares whose slice of the fund is big enough to read. */
function shareUnit(s: any): bigint {
  const total = big(s.total_shares);
  const one = 10n ** BigInt(shareDec(s));
  if (total === 0n) return 1n;
  let pick = 1n;
  for (let u = 1n; u <= 1_000_000n; u *= 10n) {
    pick = u;
    if (s.held.some(([t, v]: [string, string]) => (big(v) * u * one) / total >= 10n ** BigInt(dec(t)))) break;
  }
  // Never more shares than exist.
  while (pick > 1n && pick * one > total) pick /= 10n;
  return pick;
}
const slice = (s: any, shares: bigint): [string, bigint][] => {
  const total = big(s.total_shares);
  return s.held.map(([t, v]: [string, string]) => [t, total > 0n ? (big(v) * shares) / total : 0n]);
};
const sliceText = (parts: [string, bigint][]) => parts.filter(([, v]) => v > 0n).map(([t, v]) => fmt(t, v)).join(" + ") || "nothing yet";
/** USD value of a slice at indicative prices, or null if any part has no price. */
function sliceUsd(parts: [string, bigint][]): number | null {
  if (!havePrices()) return null;
  let sum = 0;
  for (const [t, v] of parts) {
    const x = usd(t, v);
    if (x === null) return null;
    sum += x;
  }
  return sum;
}

/** What an in-kind join of the typed size needs: new shares and the amount of every token. */
function kindPlan(f: FundCard): { shares: bigint; need: bigint[] } | { error: string } | null {
  const s = f.state;
  const tokens: string[] = s.config.mandate.tokens;
  const total = big(s.total_shares);
  const held: bigint[] = s.held.map(([, v]: [string, string]) => big(v));
  const text = f.ui.kindAmt.trim();
  if (!text) return null;
  if (total === 0n || held.every((h) => h === 0n)) return { error: "The fund is empty, so there is nothing to join in proportion to." };
  let shares: bigint;
  if (f.ui.kindMode === "base") {
    const a = parseUnits(text, dec(tokens[0]));
    if (a === null) return { error: "Enter an amount like 10 or 2.5." };
    if (held[0] === 0n) return { error: `The fund holds no ${symbol(tokens[0])} right now. Enter a share of the fund instead.` };
    shares = (a * total) / held[0];
  } else {
    const p = parseUnits(text, 4);
    if (p === null) return { error: "Enter a percent like 5 or 0.5." };
    if (p >= 1_000_000n) return { error: "Enter a percent below 100." };
    // You end up holding p of the fund: s / (total + s) = p.
    shares = (total * p) / (1_000_000n - p);
  }
  if (shares <= 0n) return { error: "That is too small to buy a share." };
  // The contract takes ceil(shares x held / total) of every token it holds.
  const need = held.map((h) => (h > 0n ? (shares * h + total - 1n) / total : 0n));
  return { shares, need };
}
/** Shares the tokens already waiting in a basket would buy, as the contract computes it. */
function basketShares(s: any, basket: bigint[]): bigint {
  const total = big(s.total_shares);
  let out: bigint | null = null;
  s.held.forEach(([, v]: [string, string], i: number) => {
    const h = big(v);
    if (h > 0n) {
      const x = ((basket[i] ?? 0n) * total) / h;
      out = out === null || x < out ? x : out;
    }
  });
  return out ?? 0n;
}

const STATUS: Record<string, [string, string]> = {
  Sending: ["sending", ""],
  Sent: ["waiting for output", ""],
  Settled: ["settled", "yes"],
  Refunded: ["refunded", ""],
  Failed: ["failed", "no"],
  Abandoned: ["written off", "no"],
};
function tradeRow(t: any, tokens: string[]): string {
  const [word, cls] = STATUS[t.status] ?? [String(t.status).toLowerCase(), ""];
  const sold = fmt(tokens[t.sell], String(t.amount_in));
  const got =
    t.status === "Settled"
      ? fmt(tokens[t.buy], String(t.received_out))
      : t.status === "Refunded"
        ? `${fmt(tokens[t.sell], String(t.received_refund ?? "0"))} back`
        : t.status === "Failed"
          ? "nothing left the fund"
          : t.stake
            ? symbol(tokens[t.buy])
            : `at least ${fmt(tokens[t.buy], String(t.min_out))}`;
  return `<div class="row"><span class="tags">${t.stake ? `<span class="tag">stake</span>` : ""}<span class="tag ${cls}">${esc(word)}</span></span><span>${esc(sold)} → ${esc(got)}</span><span class="muted small">${ago(Number(t.sent_at))}</span></div>`;
}

function rulesText(s: any): string {
  const m = s.config.mandate;
  const tokens: string[] = m.tokens;
  const parts = [
    `One trade moves at most ${pctOf(m.max_trade_bps)} of a holding and costs at most ${pctOf(m.max_cost_bps)}.`,
    `At most ${m.max_trades_per_day} ${m.max_trades_per_day === 1 ? "trade" : "trades"} a day, at least ${Math.round(m.min_seconds_between_trades / 60)} minutes apart.`,
    m.management_fee_bps ? `The manager is paid ${pctOf(m.management_fee_bps)} a year in new shares.` : "No management fee.",
  ];
  if (m.staking) parts.push(`Can stake ${symbol(tokens[m.staking.wrap_index])} into ${symbol(tokens[m.staking.lst_index])}.`);
  if (isV03(s)) parts.push(m.open_ended ? "New people can join after the window, in kind." : "Closed to new joins after the window.");
  return parts.join(" ");
}

const AUTO: any = autoRun;
function strategyBlock(f: FundCard, s: any, me: string | null): string {
  const st = s.config.mandate.strategy;
  if (!st) return "";
  const only = !!st.exclusive;
  const testSigner = !isOneClick(s.config.quote_signer);
  const running = Number(s.strategy_started) > 0 && now() < Number(s.strategy_started) + STRATEGY_TIMEOUT_SECONDS;
  // Only an https address is shown as a link.
  let host = "";
  let href = "";
  try {
    const u = new URL(String(st.wasm_url));
    if (u.protocol === "https:") (host = u.hostname), (href = u.href);
  } catch {
    /* not a usable address */
  }
  const fp = esc(short(String(st.wasm_hash), 8, 6));
  // On testnet 1Click's stand-in is run by hand: a trade sent now could wait days for its output,
  // holding up exits' share of it and new joins. So the button is off here, and the recorded run shows
  // what pressing it does.
  const rec = AUTO?.network === "testnet" && AUTO?.tx?.rebalance && AUTO?.trade;
  const tokens: string[] = s.config.mandate.tokens;
  const recTokens: string[] = AUTO?.config?.mandate?.tokens ?? tokens;
  const record = rec
    ? `<div class="rec"><p class="rec-h">Recorded on testnet</p><p>Someone pressed Rebalance on ${esc(shortAccount(String(AUTO.fund)))}. The program proposed selling ${esc(fmt(recTokens[AUTO.trade.sell], String(AUTO.trade.amount_in)))} for at least ${esc(fmt(recTokens[AUTO.trade.buy], String(AUTO.trade.min_out)))}; the fund checked it and sent it, and it settled.</p><p class="case-links"><a href="${explorer(NET, AUTO.tx.rebalance)}" target="_blank" rel="noopener">The rebalance ↗</a>${AUTO.tx.solver_delivers ? ` · <a href="${explorer(NET, AUTO.tx.solver_delivers)}" target="_blank" rel="noopener">The delivery ↗</a>` : ""}</p></div>`
    : "";
  const action =
    NET === "testnet"
      ? `<p class="small muted">On testnet the 1Click stand-in is run by hand, so the Rebalance button is off here.</p>`
      : me
        ? `<div class="actions"><button class="btn ghost sm" data-act="rebalance" ${f.busy || running ? "disabled" : ""}>${running ? "A run is in progress" : "Rebalance now"}</button><span class="small muted">Costs up to 0.01 NEAR; OutLayer sends back what the run does not use. If OutLayer refuses the run, that NEAR stays with the fund.</span></div>`
        : `<p class="small muted">Connect a wallet to press Rebalance.</p>`;
  // Essentials first; how it works and what it does not prove are one tap away.
  return `<div class="panel">
      <p class="eyebrow">${only ? "No manager" : "A program proposes trades"}</p>
      <p class="small">${only ? "No person or account of ours can propose a trade here." : "Besides the manager, a fixed program can propose trades."} A fixed program proposes; the fund checks every proposal against the same rules. Exits never depend on it.</p>
      <details class="more-info"><summary>How it works, and what it does not prove</summary>
      <p class="small">Anyone can press Rebalance. The fund then asks OutLayer to run the program and treats its answer as a proposal, checked against the same rules as any trade.</p>
      <p class="small muted">What this does not prove: the fund cannot check on chain that the program really ran inside a secure enclave. A forged answer could do what a manager could, and no more: propose a trade inside the rules.${testSigner ? " This fund accepts quotes from a test signer, not 1Click, so its trades are a testnet stand-in." : ""}</p>
      <p class="small">Program fingerprint ${href ? `<a href="${esc(href)}" target="_blank" rel="noopener" title="Where the program is fetched from">${fp} ↗</a> <span class="muted">fetched from ${esc(host)}</span>` : fp}</p>
      ${record}
      </details>
      ${action}
    </div>`;
}

function kindNeedHtml(f: FundCard): string {
  const s = f.state;
  const tokens: string[] = s.config.mandate.tokens;
  const plan = kindPlan(f);
  if (!plan) return `<p class="small muted">Enter an amount to see what you need of each token.</p>`;
  if ("error" in plan) return `<p class="small bad">${esc(plan.error)}</p>`;
  const basket = f.mine?.basket;
  const total = big(s.total_shares);
  const rows = tokens
    .map((t, i) => {
      if (plan.need[i] === 0n) return "";
      const waiting = basket?.[i] ?? 0n;
      const toSend = plan.need[i] > waiting ? plan.need[i] - waiting : 0n;
      const have = f.balances?.[i];
      const enough = have === undefined ? null : have >= toSend;
      return `<li><b>${esc(fmt(t, plan.need[i], 6))}</b>${waiting > 0n ? ` <span class="muted">(${esc(fmt(t, waiting, 6))} already waiting)</span>` : ""}<span class="${enough === false ? "bad" : "muted"}">${have === undefined ? "checking what you hold…" : `you hold ${esc(fmt(t, have, 6))}${enough ? "" : ": not enough"}`}</span></li>`;
    })
    .join("");
  return `<ul class="needs">${rows}</ul><p class="small">You get about <b>${esc(units(plan.shares, shareDec(s), 6))}</b> shares, ${esc(pct(plan.shares, total + plan.shares))} of the fund after you join. Anything left over comes straight back to you.</p>`;
}

/** Why in-kind joins are paused right now, in plain words; "" when they are open. */
function joinsPaused(s: any): string {
  if (big(s.stranded_near) > 0n) return "In-kind joins are paused while NEAR from a failed stake is wrapped back into the fund.";
  const until = Number(s.joins_blocked_until ?? 0);
  if (until >= now()) return `In-kind joins are paused until ${new Date((until + 1) * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}: a written-off trade can still be refunded or delivered until then, and joins reopen when that closes.`;
  return "";
}

function kindBlock(f: FundCard, s: any): string {
  const tokens: string[] = s.config.mandate.tokens;
  const paused = joinsPaused(s);
  const basket = f.mine?.basket;
  const waiting = basket && basket.some((x) => x > 0n);
  const stepsHtml = f.ui.steps.length ? `<ol class="progress">${f.ui.steps.map((p) => `<li class="${p.state}"><span class="dot" aria-hidden="true"></span>${esc(p.label)}<span class="sr"> (${p.state === "done" ? "done" : p.state === "doing" ? "in progress" : p.state === "failed" ? "failed" : "to do"})</span></li>`).join("")}</ol>` : "";
  const resume = waiting
    ? `<div class="notice"><p class="small"><b>You have tokens waiting in this fund:</b> ${esc(sliceText(tokens.map((t, i) => [t, basket![i] ?? 0n])))}. They are still yours.</p><div class="actions"><button class="btn primary sm" data-act="kind-finish" ${f.busy || s.pending || paused ? "disabled" : ""}>Finish joining</button><button class="btn ghost sm" data-act="kind-back" ${f.busy ? "disabled" : ""}>Take my tokens back</button></div></div>`
    : "";
  if (!paused && !f.ui.kindOpen && !waiting && !f.ui.steps.length) return `<div class="actions"><button class="btn primary sm" data-act="kind-open" ${f.busy ? "disabled" : ""}>Join in kind</button><span class="small muted">The join window has closed. You can still join by adding every token the fund holds.</span></div>`;
  if (paused) return `<div class="panel kind"><p class="eyebrow">Join in kind</p>${resume}<p class="small">${esc(paused)}</p></div>`;
  const k = esc(f.id);
  const approvals = canBatch() ? "Your wallet asks you to approve once." : "Your wallet asks you to approve each step.";
  return `<div class="panel kind">
      <p class="eyebrow">Join in kind</p>
      <p class="small">You add every token the fund holds, in the fund's own proportions, and get shares for it. No price is used.</p>
      ${resume}
      <div class="field-row">
        <label class="small" for="kind-${k}">How much to put in</label>
        <input id="kind-${k}" class="amt" inputmode="decimal" data-in="kindAmt" value="${esc(f.ui.kindAmt)}" ${f.busy ? "disabled" : ""} />
        <select class="amt unit" data-in="kindMode" aria-label="Unit" ${f.busy ? "disabled" : ""}><option value="base" ${f.ui.kindMode === "base" ? "selected" : ""}>${esc(symbol(tokens[0]))}</option><option value="pct" ${f.ui.kindMode === "pct" ? "selected" : ""}>% of the fund, after I join</option></select>
      </div>
      <div class="kind-need">${kindNeedHtml(f)}</div>
      ${s.pending ? `<p class="small muted">A trade is in flight. Joining opens once it has settled.</p>` : ""}
      <div class="actions"><button class="btn primary sm" data-act="kind-join" ${f.busy || s.pending ? "disabled" : ""}>Join in kind</button><span class="small muted">Opening your place costs 0.005 NEAR. ${approvals}</span></div>
      ${stepsHtml}
    </div>`;
}

function render(f: FundCard) {
  const s = f.state;
  if (!s) return;
  const me = currentAccount() || null;
  const m = s.config.mandate;
  const tokens: string[] = m.tokens;
  const v03 = isV03(s);
  const rel = f.info?.release ?? null;
  const legacy = !!rel?.known_issue;
  const unknown = f.info !== undefined && !rel;
  const open = !!s.subscription_open;
  const total = big(s.total_shares);
  const sd = shareDec(s);
  const one = 10n ** BigInt(sd);
  const base = tokens[0];
  const baseSym = symbol(base);
  const mine = f.mine;
  const myShares = mine?.shares ?? 0n;
  const owed = mine?.owed ?? [];
  const hasOwed = owed.some((x) => x !== "0");
  const wait = exitWait(s);
  const unit = shareUnit(s);
  const unitParts = slice(s, unit * one);
  const unitUsd = total > 0n ? sliceUsd(unitParts) : null;
  const allUsd = total > 0n ? sliceUsd(s.held.map(([t, v]: [string, string]) => [t, big(v)])) : null;
  const unitLabel = unit.toLocaleString("en");
  // Each trade pays a deposit-address registration and stores its own record (an estimate).
  const perTrade = big(s.config.storage_deposit) + TRADE_RECORD_NEAR;
  const tradesLeft = big(s.near_available_for_registrations) / perTrade;
  const trust = trustOf(f);
  const nTrades = Number(s.trades);
  const nRef = Number(s.rejections);
  const shownT = [...f.trades].reverse();
  const shownR = [...f.rejections].reverse();
  // Refunds from 1Click wait in the fund's refund account until someone hands them over.
  const waiting = tokens.map((t, i) => [t, f.relay?.[i] ?? 0n] as [string, bigint]).filter(([, v]) => v > 0n);
  const relayNote = waiting
    .map(([t, v]) => `<div class="notice"><p class="small"><b>A refund of ${esc(fmt(t, v, 6))} is waiting.</b> It sits in this fund's refund account, which can only pass tokens on to the fund. Anyone can hand it over; the fund counts it when it arrives.</p><div class="actions">${me && trust === "full" ? `<button class="btn primary sm" data-act="relay-${tokens.indexOf(t)}" ${f.busy ? "disabled" : ""}>Hand it to the fund</button>` : me ? "" : `<span class="small muted">Connect a testnet wallet to hand it over.</span>`}</div></div>`)
    .join("");
  const k = esc(f.id);
  const dis = f.busy ? "disabled" : "";

  const chips = [
    f.keyCount === undefined ? "" : `<span class="chip ${f.keyCount === 0 ? "ok" : "bad"}">${f.keyCount} keys</span>`,
    rel ? `<span class="chip ${legacy ? "warn" : ""}">release ${esc(rel.version)}</span>` : unknown ? `<span class="chip bad">unlisted code</span>` : "",
    m.strategy ? `<span class="chip">${m.strategy.exclusive ? "No manager" : "program + manager"}</span>` : "",
    isOneClick(s.config.quote_signer) ? "" : `<span class="chip note">test signer</span>`,
    `<span class="chip">${open ? `joins open until ${esc(day(m.subscription_closes_at))}` : "trading"}</span>`,
    s.pending ? `<span class="chip warn">trade in flight</span>` : "",
  ].join("");

  const known = legacy
    ? `<p class="known-tag"><b>Known issue: old release.</b> This fund can count tokens that bounce back as its own, so its exit is not safe and it cannot be fixed. <a href="${import.meta.env.BASE_URL}security/#limit-known">Read about the bug</a></p>`
    : trust === "none" && f.info !== undefined
      ? `<p class="known-tag"><b>Not a verified Plinth fund.</b> This account does not run a listed Plinth release published once by its fingerprint, so this page will not send it your tokens. <a href="${import.meta.env.BASE_URL}verify/?fund=${encodeURIComponent(f.id)}">Check it in the verifier</a></p>`
      : "";

  const usdLine =
    unitUsd !== null && allUsd !== null
      ? `<p class="small muted usd">About ${esc(money(unitUsd))} for ${unitLabel} ${shareWord(unitLabel)}, ${esc(money(allUsd))} for the whole fund. Indicative, mainnet prices${tokens.some((t) => t.startsWith("pusd.")) ? "; pUSD is a test dollar counted as $1" : ""}.</p>`
      : "";

  const history = (title: string, rows: string, shown: number, all: number, kind: "trades" | "refusals", collapsedCount: number) =>
    all
      ? `<div class="mini"><h4 class="group-h">${title}</h4><div class="rows">${rows}</div>${
          all > collapsedCount
            ? `<div class="more">${shown < all ? `<button class="link" data-act="more-${kind}" ${dis}>${all - shown <= 20 ? `Show all ${all}` : `Show 20 more`}</button>` : ""}${shown > collapsedCount ? `<button class="link" data-act="less-${kind}" ${dis}>Show fewer</button>` : ""}</div>`
            : ""
        }</div>`
      : "";
  const lastAt = Number(s.last_trade_at) || 0;
  const summaryBits = [`${nTrades} ${nTrades === 1 ? "trade" : "trades"}`, `${nRef} refused`, lastAt ? `last trade ${ago(lastAt)}` : ""].filter(Boolean).join(" · ");

  // ---- the connected account's part
  let you = trust === "none" ? `<p class="small muted">Read-only: wallet actions are off for this account.</p>` : `<p class="small muted">Connect a testnet wallet above to join or exit.</p>`;
  if (me && trust !== "none") {
    const position =
      myShares > 0n
        ? `<p class="small">Your position: <b>${esc(units(myShares, sd, 6))}</b> ${shareWord(units(myShares, sd, 6))} = ${esc(sliceText(slice(s, myShares)))} <span class="muted">(${esc(pct(myShares, total))} of the fund)</span></p>`
        : `<p class="small muted">You hold no shares in this fund.</p>`;
    const owedLine = hasOwed ? `<p class="small">Owed to you from an earlier exit: ${owed.map((x, i) => (x !== "0" ? esc(fmt(tokens[i], x)) : "")).filter(Boolean).join(", ")}.</p>` : "";
    const join = trust !== "full"
      ? trust === "exit"
        ? `<p class="small muted">Joining is off for this old release. You can still leave with your share, and claim anything owed to you.</p>`
        : ""
      : open
      ? `<div class="actions"><label class="small" for="amt-${k}">Join with</label><input id="amt-${k}" class="amt" inputmode="decimal" data-in="joinAmt" value="${esc(f.ui.joinAmt)}" ${dis} /><span class="small muted">${esc(baseSym)}</span><button class="btn primary sm" data-act="join" ${dis}>Join</button><span class="small muted">1 ${esc(baseSym)} buys 1 share.</span></div>`
      : v03 && m.open_ended
        ? kindBlock(f, s)
        : `<p class="small muted">The join window has closed and this fund takes no new joiners.</p>`;
    const exit =
      myShares > 0n
        ? wait > 0
          ? `<div class="actions"><button class="btn ghost sm" disabled>Exit opens in ${Math.ceil(wait / 60)} min</button></div><p class="small muted">A trade is in flight. Exits open once it settles, or ${Math.ceil(wait / 60)} min after it was sent.</p>`
          : `<div class="actions exit"><label class="small" for="exit-${k}">Exit with</label><input id="exit-${k}" class="amt" inputmode="decimal" data-in="exitAmt" value="${esc(f.ui.exitAmt)}" placeholder="0" ${dis} /><span class="small muted">shares</span>${[25, 50, 100].map((p) => `<button class="pill" data-act="pct-${p}" ${dis} aria-label="${p} percent of your shares">${p}%</button>`).join("")}<button class="btn ghost sm" data-act="exit" ${dis}>Exit in kind</button></div>`
        : "";
    const extra = hasOwed ? `<button class="btn ghost sm" data-act="claim" ${dis}>Claim what is owed</button>` : "";
    you = `${position}${owedLine}${join}${exit}${extra ? `<div class="actions">${extra}</div>` : ""}`;
  }

  // Remember which control had focus, to give it back after the card is redrawn.
  const act = document.activeElement as HTMLElement | null;
  const keep = act && f.el.contains(act) ? (act.dataset.act ? `[data-act="${act.dataset.act}"]` : act.dataset.in ? `[data-in="${act.dataset.in}"]` : act.tagName === "SUMMARY" ? ".fund-more > summary" : "") : "";
  f.el.classList.remove("loading");
  paintIndex(f, rel, legacy);
  const holdsLabel = total > 0n ? `${unitLabel} ${unit === 1n ? "share holds" : "shares hold"}` : "Shares";
  const holdsValue = total > 0n ? unitParts.filter(([, v]) => v > 0n).map(([t, v]) => `<span>${esc(fmt(t, v))}</span>`).join("") || "<span>nothing yet</span>" : "<span>none issued yet</span>";
  f.el.innerHTML = `
    <header class="fund-h">
      <div class="fund-title"><h3><a href="${accountLink(NET, f.id)}" target="_blank" rel="noopener" title="${k}">${esc(f.title)}</a></h3><p class="id">${esc(shortAccount(f.id))}</p></div>
      <div class="chips">${chips}</div>
    </header>
    ${known}
    <p class="blurb">${esc(f.blurb)}${isOneClick(s.config.quote_signer) ? "" : ` ${esc(TEST_SIGNER_WORDS)}`}</p>
    <div class="fund-body">
    <section class="fund-sec" aria-label="What the fund holds">
      <h4 class="group-h">Holdings</h4>
      <div class="fund-grid">
        <div class="kv big"><span>The fund holds</span><b>${s.held.map(([t, v]: [string, string]) => `<span>${esc(fmt(t, v))}</span>`).join("")}</b></div>
        <div class="kv big"><span>${esc(holdsLabel)}</span><b>${holdsValue}</b></div>
      </div>
      ${usdLine}
    </section>
    <section class="you fund-sec" aria-label="Your part">
      <h4 class="group-h">Your part</h4>
      ${you}
      <p class="status small" role="status">${esc(f.msg)}${f.msgTx ? ` <a href="${explorer(NET, f.msgTx)}" target="_blank" rel="noopener">View transaction ↗</a>` : ""}</p>
    </section>
    </div>
    ${relayNote}
    ${strategyBlock(f, s, me)}
    <details class="fund-more" ${f.ui.details ? "open" : ""}>
      <summary><span class="sum-t">Details</span><span class="sum-d">Rules, costs and history · ${esc(summaryBits)}</span></summary>
      <div class="fund-more-in">
        <div class="fund-grid">
          <div class="kv"><span>Shares issued</span><b>${esc(units(total, sd, 6))}</b><em>A share is a claim on a slice of everything the fund holds. One was issued per ${esc(baseSym)} paid in at launch.</em></div>
          <div class="kv"><span>Trades · refused</span><b>${nTrades} · ${nRef}</b><em>Trades the fund sent, and proposals it refused.</em></div>
        </div>
        <div class="facts">
          <h4 class="group-h">Rules, fixed at launch</h4>
          <p>${esc(rulesText(s))}</p>
          <p>The most trading can cost a holding in one day: <b>${esc(pctOf(worstDay(s)))}</b>.</p>
          <p>Running costs: ${tradesLeft > 0n ? `NEAR for about <b>${esc(tradesLeft.toLocaleString("en"))}</b> more trades (an estimate).` : `<b>no NEAR left</b> for new trades. Exits still work.`}</p>
        </div>
        ${history("Recent trades", shownT.map((t) => tradeRow(t, tokens)).join(""), shownT.length, nTrades, "trades", 4)}
        ${history("Refused on chain", shownR.map((r) => `<div class="row"><span class="tag no">refused</span><span>${esc(humanReason(String(r.reason)))}</span><span class="muted small">${ago(Number(r.at))}</span></div>`).join(""), shownR.length, nRef, "refusals", 3)}
      </div>
    </details>
    <footer class="fund-f"><a class="link" href="${esc(shareUrl(f.id))}" data-act="share">Share this fund</a><a class="link" href="${import.meta.env.BASE_URL}verify/?fund=${encodeURIComponent(f.id)}">Verify it</a></footer>`;
  if (keep) {
    const again = f.el.querySelector<HTMLElement>(keep);
    (again && !(again as HTMLButtonElement).disabled ? again : f.el.querySelector<HTMLElement>(".you button:not([disabled]), .you input"))?.focus({ preventScroll: true });
  }
}

const setMsg = (f: FundCard, msg: string, tx = "") => {
  f.msg = msg;
  f.msgTx = tx;
  const st = f.el.querySelector(".status");
  if (st) st.innerHTML = `${esc(msg)}${tx ? ` <a href="${explorer(NET, tx)}" target="_blank" rel="noopener">View transaction ↗</a>` : ""}`;
};

async function load(f: FundCard) {
  const me = currentAccount();
  const [state, info] = await Promise.all([view<any>(NET, f.id, "get_fund"), releaseOf(NET, f.id).catch(() => undefined)]);
  const tokens: string[] = state.config.mandate.tokens;
  await loadMeta(NET, tokens);
  const inKind = isV03(state) && !!state.config.mandate.open_ended;
  const nT = Number(state.trades);
  const nR = Number(state.rejections);
  // Read only the newest entries: the contract pages from the start.
  const relayId: string | null = isV03(state) && typeof state.config.refund_relay === "string" ? state.config.refund_relay : null;
  const [keys, trades, rejections, mine, balances, relay] = await Promise.all([
    keyCount(NET, f.id),
    nT ? view<any[]>(NET, f.id, "get_trades", tail(nT, Math.max(4, f.ui.tradesShown))) : Promise.resolve([]),
    nR ? view<any[]>(NET, f.id, "get_rejections", tail(nR, Math.max(3, f.ui.refusalsShown))) : Promise.resolve([]),
    me
      ? Promise.all([
          view<string>(NET, f.id, "get_shares", { account_id: me }),
          view<string[]>(NET, f.id, "get_owed", { account_id: me }),
          inKind ? view<string[] | null>(NET, f.id, "get_basket", { account_id: me }).catch(() => null) : Promise.resolve(null),
        ])
      : Promise.resolve(null),
    me && inKind && f.ui.kindOpen ? Promise.all(tokens.map((t) => view<string>(NET, t, "ft_balance_of", { account_id: me }).then(big, () => 0n))) : Promise.resolve(null),
    relayId ? Promise.all(tokens.map((t) => view<string>(NET, t, "ft_balance_of", { account_id: relayId }).then(big, () => 0n))) : Promise.resolve(null),
  ]);
  // The wallet changed while this was loading: these numbers belong to someone else.
  if (currentAccount() !== me) return;
  f.state = state;
  f.info = info;
  regroup(f);
  f.keyCount = keys;
  f.trades = trades;
  f.rejections = rejections;
  f.mine = mine ? { shares: big(mine[0]), owed: mine[1], basket: mine[2] ? mine[2].map(big) : null } : null;
  f.balances = balances;
  f.relay = relay;
  render(f);
}

/** The side list of funds: one link per card, kept in step with it. */
function paintIndex(f: FundCard, rel: { version: string; known_issue?: string } | null, legacy: boolean) {
  const list = document.getElementById(f.group === "legacy" ? "index-legacy" : "index-new");
  if (!list) return;
  let li = document.getElementById(`ix-${f.el.id}`);
  if (!li) {
    li = document.createElement("li");
    li.id = `ix-${f.el.id}`;
  }
  if (li.parentElement !== list) list.appendChild(li);
  // Keep the list in the same order as the cards.
  const cardOf = (x: Element) => document.getElementById(x.id.slice(3));
  const sorted = [...list.children].sort((a, b) => {
    const ca = cardOf(a), cb = cardOf(b);
    return ca && cb ? (ca.compareDocumentPosition(cb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0;
  });
  sorted.forEach((x, i) => list.children[i] !== x && list.appendChild(x));
  const s = f.state;
  const pending = !!s?.pending;
  li.innerHTML = `<a href="#${f.el.id}"><span class="ix-name">${esc(f.title)}</span><span class="ix-meta">${rel ? `Release ${esc(rel.version)}` : "Unlisted code"}${legacy ? " · known issue" : ""}${pending ? " · trade in flight" : ""}</span></a>`;
  document.getElementById("index-legacy-h")?.toggleAttribute("hidden", !document.getElementById("index-legacy")?.children.length);
}

/** An element id for a fund's card: every character other than a-z, 0-9 and "-" is spelled out, so two funds never share one. */
export const cardId = (id: string) => `fund-${[...id].map((ch) => (/[a-z0-9-]/.test(ch) ? ch : `_${ch.charCodeAt(0).toString(16)}_`)).join("")}`;

/** Cards start in the group their data suggests; the chain's release decides where they belong. */
let regroup: (f: FundCard) => void = () => {};

async function registrations(me: string, tokens: string[]): Promise<Call[]> {
  const calls: Call[] = [];
  for (const t of tokens) {
    if ((await view(NET, t, "storage_balance_of", { account_id: me })) === null) {
      const bounds = await view<any>(NET, t, "storage_balance_bounds").catch(() => null);
      calls.push({ receiverId: t, methodName: "storage_deposit", args: { account_id: me, registration_only: true }, deposit: typeof bounds?.min === "string" ? bounds.min : STORAGE, gas: TGAS(30) });
    }
  }
  return calls;
}

const paintSteps = (f: FundCard, i: number, state: Step["state"]) => {
  if (f.ui.steps[i]) f.ui.steps[i].state = state;
  render(f);
};

/** Join in kind: open a basket, add each token, join, and get leftovers back. */
async function kindJoin(f: FundCard, me: string, s: any) {
  const m = s.config.mandate;
  const tokens: string[] = m.tokens;
  if (!isV03(s) || !m.open_ended) throw new UserError("this fund does not take new joiners after its window");
  if (s.subscription_open) throw new UserError("the join window is still open; join with the base token");
  if (s.pending) throw new UserError("a trade is in flight; join once it has settled");
  if (joinsPaused(s)) throw new UserError(joinsPaused(s).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
  if (!tokens.every(hasMeta)) throw new UserError("the details of one of the fund's tokens could not be read");
  const plan = kindPlan(f);
  if (!plan) throw new UserError("enter how much to put in");
  if ("error" in plan) throw new UserError(plan.error.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
  const basketRaw = await view<string[] | null>(NET, f.id, "get_basket", { account_id: me });
  const basket = basketRaw ? basketRaw.map(big) : null;
  const toSend = plan.need.map((n, i) => (n > (basket?.[i] ?? 0n) ? n - (basket?.[i] ?? 0n) : 0n));
  // Pre-checks: you hold enough of every token, and both sides can receive each token.
  for (let i = 0; i < tokens.length; i++) {
    if (plan.need[i] === 0n) continue;
    if (!s.registered?.[i]) throw new UserError(`the fund is not set up to receive ${symbol(tokens[i])}`);
    const [bal, reg] = await Promise.all([view<string>(NET, tokens[i], "ft_balance_of", { account_id: me }).then(big, () => 0n), view<any>(NET, tokens[i], "storage_balance_of", { account_id: me }).catch(() => null)]);
    if (reg === null && toSend[i] > 0n) throw new UserError(`your account is not set up to hold ${symbol(tokens[i])} yet, so you have none to add`);
    if (bal < toSend[i]) throw new UserError(`you hold ${fmt(tokens[i], bal, 6)} and need ${fmt(tokens[i], toSend[i], 6)}`);
  }
  const minShares = (plan.shares * 99n) / 100n || 1n;
  const stages: { label: string; calls: Call[]; check?: () => Promise<void> }[] = [];
  if (!basket) stages.push({ label: "Open your place in the fund (0.005 NEAR)", calls: [{ receiverId: f.id, methodName: "open_basket", args: {}, deposit: BASKET_DEPOSIT, gas: TGAS(30) }] });
  tokens.forEach((t, i) => {
    if (toSend[i] === 0n) return;
    stages.push({
      label: `Add ${fmt(t, toSend[i], 6)}`,
      calls: [{ receiverId: t, methodName: "ft_transfer_call", args: { receiver_id: f.id, amount: toSend[i].toString(), msg: "basket" }, deposit: "1", gas: TGAS(100) }],
      check: async () => {
        const b = await view<string[] | null>(NET, f.id, "get_basket", { account_id: me });
        if (!b || big(b[i]) < plan.need[i]) throw new UserError(`the fund sent your ${symbol(t)} back`);
      },
    });
  });
  stages.push({
    label: "Join and get leftovers back",
    calls: [
      { receiverId: f.id, methodName: "join_in_kind", args: { min_shares: minShares.toString() }, gas: TGAS(80) },
      { receiverId: f.id, methodName: "withdraw_basket", args: {}, gas: TGAS(180) },
    ],
  });
  f.ui.steps = stages.map((x) => ({ label: x.label, state: "todo" }));
  const before = big(await view<string>(NET, f.id, "get_shares", { account_id: me }));
  let tx = "";
  if (canBatch() && stages.length > 1) {
    // One approval for every step; the wallet sends them in order.
    f.ui.steps.forEach((p) => (p.state = "doing"));
    render(f);
    setMsg(f, "Waiting for your wallet. One approval covers every step.");
    try {
      tx = (await send(stages.flatMap((x) => x.calls))).hashes.pop() ?? "";
    } catch (e) {
      f.ui.steps.forEach((p) => (p.state = "failed"));
      throw e;
    }
  } else {
    for (let i = 0; i < stages.length; i++) {
      paintSteps(f, i, "doing");
      setMsg(f, `Step ${i + 1} of ${stages.length}: waiting for your wallet.`);
      try {
        tx = (await send(stages[i].calls)).hashes.pop() ?? tx;
        await stages[i].check?.();
      } catch (e) {
        paintSteps(f, i, "failed");
        throw e;
      }
      paintSteps(f, i, "done");
    }
  }
  const after = await settle(() => view<string>(NET, f.id, "get_shares", { account_id: me }, "optimistic").then(big), (v) => v > before);
  const got = after - before;
  if (got <= 0n) {
    f.ui.steps.forEach((p) => p.state === "doing" && (p.state = "failed"));
    throw new UserError("the join did not complete; any tokens you added are still waiting in the fund and you can take them back");
  }
  f.ui.steps = [];
  f.ui.kindOpen = false;
  f.ui.kindAmt = "";
  setMsg(f, `Joined in kind: ${units(got, shareDec(s), 6)} new shares.`, tx);
}

/** Called after every wallet action, so the wallet bar's balance is fresh too. */
let afterAction: () => void = () => {};

async function act(f: FundCard, kind: string) {
  const me = currentAccount();
  if (!me || f.busy) return;
  // Wallet actions only for code this page can vouch for; old releases keep their way out.
  const trust = trustOf(f);
  if (trust === "none" || (trust === "exit" && !EXIT_ACTIONS.has(kind))) {
    setMsg(f, "This page does not send tokens to this account. Check it in the verifier.");
    return;
  }
  f.busy = true;
  render(f);
  try {
    // Act on fresh state, not the last poll.
    const s = await view<any>(NET, f.id, "get_fund");
    f.state = s;
    const m = s.config.mandate;
    const tokens: string[] = m.tokens;
    await loadMeta(NET, tokens);
    const sd = shareDec(s);
    const shares = async () => big(await view<string>(NET, f.id, "get_shares", { account_id: me }, "optimistic"));
    setMsg(f, "Waiting for your wallet…");
    if (kind === "join") {
      const base = tokens[0];
      if (!hasMeta(base)) throw new UserError("the details of the fund's base token could not be read");
      const amount = parseUnits(f.ui.joinAmt, dec(base));
      if (amount === null || amount === 0n) throw new UserError(`enter an amount like 10 or 2.5 (${symbol(base)} has ${dec(base)} decimal places)`);
      if (!s.subscription_open) throw new UserError("joins are closed for this fund");
      if (amount < big(m.min_subscription)) throw new UserError(`the minimum is ${fmt(base, m.min_subscription)}`);
      const room = big(m.max_total_subscriptions) - big(s.total_subscribed);
      if (amount > room) throw new UserError(`the fund has room for ${fmt(base, room > 0n ? room : 0n)} more`);
      const bal = big(await view<string>(NET, base, "ft_balance_of", { account_id: me }).catch(() => "0"));
      if (bal < amount) throw new UserError(`you have ${fmt(base, bal)}${base.startsWith("pusd.") ? "; take test pUSD from the faucet above" : ""}`);
      const before = await shares();
      const r = await send([{ receiverId: base, methodName: "ft_transfer_call", args: { receiver_id: f.id, amount: amount.toString(), msg: "" }, deposit: "1", gas: TGAS(150) }]);
      const got = (await settle(shares, (v) => v > before)) - before;
      setMsg(f, got > 0n ? `Joined: ${units(got, sd, 6)} new shares.` : `No new shares showed up yet. If the fund returned your ${symbol(base)}, it is back in your wallet; the transaction link shows what happened.`, r.hashes[0]);
    } else if (kind === "exit") {
      if (exitWait(s) > 0) throw new UserError("a trade is in flight; exits open once it settles or 10 minutes after it was sent");
      const mine = await shares();
      if (mine === 0n) throw new UserError("you have no shares in this fund");
      if (!hasMeta(tokens[0])) throw new UserError("the details of the fund's base token could not be read; try again in a moment");
      const typed = f.ui.exitAmt.trim();
      // An empty field is not "everything": the 100% button fills in the exact amount.
      const burn = typed ? parseUnits(typed, sd) : null;
      if (burn === null || burn === 0n) throw new UserError("enter how many shares to exit with, like 10 or 2.5, or press 100%");
      if (burn > mine) throw new UserError(`you have ${units(mine, sd, 6)} shares`);
      // Register only on tokens you will actually receive (your share of a zero holding is nothing).
      const total = big(s.total_shares);
      const receiving = tokens.filter((_, i) => (big(s.held[i][1]) * burn) / total > 0n);
      const expect = tokens.map((_, i) => (big(s.held[i][1]) * burn) / total);
      const owedBefore = (await view<string[]>(NET, f.id, "get_owed", { account_id: me }).catch(() => [])).map(big);
      const r = await send([...(await registrations(me, receiving)), { receiverId: f.id, methodName: "redeem", args: { shares: burn.toString() }, gas: TGAS(200) }]);
      const left = await settle(shares, (v) => v < mine);
      if (left < mine) {
        f.ui.exitAmt = "";
        // A payout that bounced (e.g. you could not hold that token) waits for you as owed.
        const owedAfter = (await view<string[]>(NET, f.id, "get_owed", { account_id: me }, "optimistic").catch(() => [])).map(big);
        const stuck = tokens.map((t, i) => [t, (owedAfter[i] ?? 0n) - (owedBefore[i] ?? 0n)] as [string, bigint]).filter(([, v]) => v > 0n);
        const paid = tokens.map((t, i) => [t, expect[i] - (stuck.find(([x]) => x === t)?.[1] ?? 0n)] as [string, bigint]);
        setMsg(
          f,
          stuck.length
            ? `Exited with ${units(mine - left, sd, 6)} shares. ${stuck.map(([t, v]) => fmt(t, v, 6)).join(" and ")} could not be paid yet; it is waiting for you to claim.`
            : `Exited with ${units(mine - left, sd, 6)} shares: ${sliceText(paid)} is on its way to you.`,
          r.hashes.pop(),
        );
      } else setMsg(f, "Your shares have not changed yet. The transaction link shows what happened.", r.hashes.pop());
    } else if (kind === "claim") {
      const owed = await view<string[]>(NET, f.id, "get_owed", { account_id: me });
      // A payout fails mostly because you are not registered on that token: register first.
      const need = tokens.filter((_, i) => owed[i] && owed[i] !== "0");
      if (!need.length) throw new UserError("nothing is owed to you");
      const r = await send([...(await registrations(me, need)), { receiverId: f.id, methodName: "claim", args: {}, gas: TGAS(200) }]);
      setMsg(f, "Claim sent. Anything that still cannot be paid stays owed to you.", r.hashes.pop());
    } else if (kind.startsWith("relay-")) {
      const i = Number(kind.slice(6));
      const relayId: string | undefined = s.config.refund_relay;
      if (!relayId || !tokens[i]) throw new UserError("this fund has no refund account");
      const amount = big(await view<string>(NET, tokens[i], "ft_balance_of", { account_id: relayId }));
      if (amount === 0n) throw new UserError("no refund is waiting any more; someone may have handed it over already");
      const before = big(s.held[i][1]);
      const r = await send([{ receiverId: relayId, methodName: "relay_forward", args: { token: tokens[i], amount: amount.toString() }, gas: TGAS(150) }]);
      const after = await settle(() => view<any>(NET, f.id, "get_fund", {}, "optimistic"), (x) => big(x.held[i][1]) > before);
      setMsg(f, big(after.held[i][1]) > before ? `Handed over: the fund now counts ${fmt(tokens[i], amount, 6)} more.` : "Sent. The fund will count the refund when it arrives.", r.hashes[0]);
    } else if (kind === "rebalance") {
      const st = m.strategy;
      if (!st) throw new UserError("this fund has no program to run");
      if (!s.trading_open) throw new UserError("trading starts when the join window closes");
      if (s.pending) throw new UserError("a trade is already in flight");
      if (Number(s.strategy_started) > 0 && now() <= Number(s.strategy_started) + STRATEGY_TIMEOUT_SECONDS) throw new UserError("a run is already in progress; try again in a few minutes");
      if (Number(s.last_trade_at) > 0 && now() < Number(s.last_trade_at) + Number(m.min_seconds_between_trades)) throw new UserError(`it is too soon after the last trade; try again in ${Math.ceil((Number(s.last_trade_at) + Number(m.min_seconds_between_trades) - now()) / 60)} min`);
      if (Number(s.trades_today) >= Number(m.max_trades_per_day)) throw new UserError("the fund's trades for today are used up");
      setMsg(f, "Waiting for your wallet, then for the program's answer. This can take a minute.");
      const r = await send([{ receiverId: f.id, methodName: "rebalance", args: {}, deposit: REBALANCE_DEPOSIT, gas: TGAS(300) }]);
      const after = await settle(() => view<any>(NET, f.id, "get_fund", {}, "optimistic"), (x) => Number(x.trades) > Number(s.trades) || Number(x.rejections) > Number(s.rejections) || Number(x.strategy_started) === 0);
      const answer = typeof r.value === "string" ? r.value : Number(after.trades) > Number(s.trades) ? "trade" : Number(after.rejections) > Number(s.rejections) ? "refused" : Number(after.strategy_started) > 0 ? "running" : "hold";
      if (answer === "trade" || answer === "stake") {
        // This run's trade has the next id: the count before it was sent.
        const t = (await view<any[]>(NET, f.id, "get_trades", { from: Number(s.trades), limit: 1 }, "optimistic"))[0];
        setMsg(f, t ? `The program proposed a ${t.stake ? "stake" : "trade"} and the fund sent it: ${fmt(tokens[t.sell], String(t.amount_in))} for ${t.stake ? symbol(tokens[t.buy]) : `at least ${fmt(tokens[t.buy], String(t.min_out))}`}.` : "The program proposed a trade and the fund sent it.", r.hashes[0]);
      } else if (answer === "refused") {
        const fresh = Number(after.rejections) > Number(s.rejections) ? (await view<any[]>(NET, f.id, "get_rejections", { from: Number(s.rejections), limit: 1 }, "optimistic"))[0] : null;
        setMsg(f, `The program proposed, and the fund refused: ${fresh ? humanReason(String(fresh.reason)).replace(/^./, (c) => c.toLowerCase()) : "the reason is in the transaction"}.`, r.hashes[0]);
      } else if (answer === "running") {
        setMsg(f, "The run is still in progress. This card will show the result.", r.hashes[0]);
      } else {
        setMsg(f, "Held: the program chose not to trade this time.", r.hashes[0]);
      }
    } else if (kind === "kind-join") {
      await kindJoin(f, me, s);
    } else if (kind === "kind-finish") {
      if (s.pending) throw new UserError("a trade is in flight; join once it has settled");
      if (joinsPaused(s)) throw new UserError(joinsPaused(s).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()));
      const b = await view<string[] | null>(NET, f.id, "get_basket", { account_id: me });
      if (!b) throw new UserError("you have no tokens waiting in this fund");
      const worth = basketShares(s, b.map(big));
      if (worth === 0n) throw new UserError("what is waiting is too small to buy a share at the fund's current holdings; add more or take it back");
      const before = await shares();
      const r = await send([
        { receiverId: f.id, methodName: "join_in_kind", args: { min_shares: ((worth * 99n) / 100n || 1n).toString() }, gas: TGAS(80) },
        { receiverId: f.id, methodName: "withdraw_basket", args: {}, gas: TGAS(180) },
      ]);
      const got = (await settle(shares, (v) => v > before)) - before;
      f.ui.steps = [];
      setMsg(f, got > 0n ? `Joined in kind: ${units(got, sd, 6)} new shares. Leftovers are on their way back to you.` : "The join did not complete; your tokens are still waiting in the fund.", r.hashes[0]);
    } else if (kind === "kind-back") {
      const b = await view<string[] | null>(NET, f.id, "get_basket", { account_id: me });
      if (!b) throw new UserError("you have no tokens waiting in this fund");
      const r = await send([...(await registrations(me, tokens.filter((_, i) => big(b[i]) > 0n))), { receiverId: f.id, methodName: "withdraw_basket", args: {}, gas: TGAS(200) }]);
      f.ui.steps = [];
      setMsg(f, "Your tokens are on their way back to you.", r.hashes.pop());
    }
  } catch (e) {
    const cause = e instanceof PartlySent ? e.cause : e;
    const why = isCancel(cause) ? "you cancelled in the wallet" : humanFailure(cause);
    // Part of an in-kind join may already be in: say exactly what, and how to finish or undo it.
    const basket = kind.startsWith("kind") ? await view<string[] | null>(NET, f.id, "get_basket", { account_id: me }, "optimistic").catch(() => null) : null;
    const waiting = basket ? basket.map(big) : null;
    const tokens: string[] = f.state?.config?.mandate?.tokens ?? [];
    if (waiting && waiting.some((x) => x > 0n)) {
      setMsg(f, `Stopped part way: ${why}. ${sliceText(tokens.map((t, i) => [t, waiting[i] ?? 0n]))} is waiting in this fund for you. Use Finish joining or Take my tokens back below.`);
    } else if (e instanceof PartlySent || (waiting && kind === "kind-join")) {
      setMsg(f, `Stopped part way: ${why}. ${e instanceof PartlySent ? `${e.done} of the transactions went through; the link shows them.` : "Your place in the fund is open, with nothing in it yet."}`, e instanceof PartlySent ? e.hashes[0] ?? "" : "");
    } else setMsg(f, isCancel(cause) ? "Cancelled. Nothing was sent." : `Did not go through: ${why}.`);
  } finally {
    f.busy = false;
  }
  await load(f).catch(() => render(f));
  afterAction();
}

const PUSD = "pusd.plinthfund.testnet";
/** The connect / faucet / disconnect bar. `onChange` reloads whatever the page shows. */
export function mountWalletBar(bar: HTMLElement, onChange: () => Promise<void>, onSignOut: () => void = () => {}): { paint(): Promise<void> } {
  let barMsg = "";
  const setBar = (m: string) => {
    barMsg = m;
    const st = bar.querySelector(".status");
    if (st) st.textContent = m;
  };
  const paint = async () => {
    const me = currentAccount();
    let bal = "";
    if (me) bal = await view<string>(NET, PUSD, "ft_balance_of", { account_id: me }, "optimistic").then((v) => fmt(PUSD, v), () => "");
    if (currentAccount() !== me) return;
    bar.innerHTML = me
      ? `<div class="wb-who"><span class="wb-label">Connected</span><span class="who" title="${esc(me)}">${esc(shortAccount(me))}</span>${bal ? `<span class="wb-bal">${esc(bal)}</span>` : ""}</div><div class="wb-actions"><button class="btn ghost sm" data-w="faucet">Get 100 test pUSD</button><button class="btn ghost sm" data-w="out">Disconnect</button></div><span class="status small" role="status">${esc(barMsg)}</span>`
      : `<div class="wb-who"><span class="wb-label">Wallet</span><span class="wb-hint">Test tokens only. Nothing here is money.</span></div><div class="wb-actions"><button class="btn primary sm" data-w="in">Connect a testnet wallet</button></div><span class="status small" role="status">${esc(barMsg)}</span>`;
  };
  let busy = false;
  const faucet = async () => {
    const me = currentAccount();
    // Set before anything is awaited, so a double click sends one request.
    if (!me || busy) return;
    busy = true;
    bar.querySelectorAll<HTMLButtonElement>("button[data-w]").forEach((b) => (b.disabled = true));
    try {
      setBar("Waiting for your wallet…");
      const calls: Call[] = (await view(NET, PUSD, "storage_balance_of", { account_id: me })) === null ? [{ receiverId: PUSD, methodName: "storage_deposit", args: { account_id: me }, deposit: STORAGE, gas: TGAS(30) }] : [];
      calls.push({ receiverId: PUSD, methodName: "mint", args: { account_id: me, amount: (100n * 10n ** BigInt(dec(PUSD))).toString() }, gas: TGAS(30) });
      const before = big(await view<string>(NET, PUSD, "ft_balance_of", { account_id: me }).catch(() => "0"));
      await send(calls);
      await settle(() => view<string>(NET, PUSD, "ft_balance_of", { account_id: me }, "optimistic").then(big), (v) => v > before);
      setBar("100 test pUSD sent to you.");
    } catch (e) {
      setBar(isCancel(e) ? "Cancelled. Nothing was sent." : `Did not go through: ${humanFailure(e)}.`);
    }
    busy = false;
    await Promise.all([onChange(), paint()]);
  };
  bar.addEventListener("click", async (e) => {
    const w = ((e.target as HTMLElement).closest("button[data-w]") as HTMLButtonElement | null)?.dataset.w;
    if (w === "in") await signIn().catch(() => {});
    if (w === "out") {
      barMsg = "";
      onSignOut();
      await signOut();
    }
    if (w === "faucet") await faucet();
  });
  return { paint };
}

export interface AppOptions {
  /** Funds named in the data files; the chain decides which group each belongs in. */
  known: { id: string; title: string; blurb: string }[];
  /** Funds from before release 0.3. */
  legacy: { id: string; title: string; blurb: string }[];
  /** A fund named in the page address (?fund=...). */
  linked: string | null;
  /** The newest fund from the factory, once known. */
  onNewest?(id: string): void;
}
export interface App {
  /** Put a fund at the top of the list (after it was just created) and scroll to it. */
  showFund(id: string): Promise<void>;
}

export async function mountApp(opt: AppOptions): Promise<App> {
  const rootNew = document.getElementById("funds-new")!;
  const rootLegacy = document.getElementById("funds-legacy")!;
  const legacyWrap = document.getElementById("funds-legacy-wrap") as HTMLDetailsElement;
  const note = document.getElementById("funds-note")!;
  const moreBtn = document.getElementById("funds-more") as HTMLButtonElement;
  const factory = factoryOf(NET);
  const cards: FundCard[] = [];
  let factoryLoaded = 0;
  let newestId = "";

  regroup = (c) => {
    const rel = c.info?.release;
    if (!rel) return;
    const want: FundCard["group"] = rel.known_issue ? "legacy" : "new";
    if (want === c.group) return;
    c.group = want;
    (want === "legacy" ? rootLegacy : rootNew).appendChild(c.el);
  };
  const publish = () => {};

  const loadCard = (c: FundCard) =>
    load(c).catch((e) => {
      if (!c.state) {
        c.failed = true;
        c.el.classList.remove("loading");
        c.el.innerHTML = `<p class="bad">Could not read ${esc(shortAccount(c.id))}: ${esc((e as Error).message)}.</p>`;
      }
    });

  function addCard(def: { id: string; title: string; blurb: string }, group: FundCard["group"], where: "start" | "end" = "end"): FundCard {
    const existing = cards.find((c) => c.id === def.id);
    if (existing) return existing;
    const el = document.createElement("article");
    el.className = "fund loading";
    el.id = cardId(def.id);
    el.innerHTML = `<div class="sk sk-h"></div><div class="sk sk-l"></div><div class="sk sk-grid"></div><div class="sk sk-l"></div><div class="sk sk-l short"></div><span class="sr">Loading ${esc(shortAccount(def.id))}</span>`;
    const root = group === "legacy" ? rootLegacy : rootNew;
    if (where === "start") root.prepend(el);
    else root.appendChild(el);
    const c: FundCard = { ...def, group, el, trades: [], rejections: [], mine: null, balances: null, relay: null, msg: "", msgTx: "", busy: false, ui: { joinAmt: "10", exitAmt: "", kindAmt: "", kindMode: "base", kindOpen: false, tradesShown: 0, refusalsShown: 0, details: false, steps: [] } };
    cards.push(c);
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const a = b.dataset.act!;
      if (a === "share") {
        e.preventDefault();
        const url = (b as HTMLAnchorElement).href;
        (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(
          () => setMsg(c, "Link copied. Anyone who opens it lands on this fund."),
          () => {
            // No clipboard here: show the link to copy by hand, and stay on the page.
            setMsg(c, "Copy this link:");
            const st = c.el.querySelector(".status");
            if (st) {
              const field = document.createElement("input");
              field.className = "amt share-field";
              field.readOnly = true;
              field.value = url;
              field.setAttribute("aria-label", "Link to this fund");
              st.append(" ", field);
              field.select();
            }
          },
        );
      } else if (a.startsWith("pct-")) {
        const p = BigInt(a.slice(4));
        const mine = c.mine?.shares ?? 0n;
        c.ui.exitAmt = plain(p === 100n ? mine : (mine * p) / 100n, shareDec(c.state));
        render(c);
      } else if (a === "more-trades" || a === "more-refusals" || a === "less-trades" || a === "less-refusals") {
        const key = a.endsWith("trades") ? "tradesShown" : "refusalsShown";
        const all = Number(a.endsWith("trades") ? c.state.trades : c.state.rejections);
        const now = Math.max(c.ui[key], a.endsWith("trades") ? 4 : 3);
        c.ui[key] = a.startsWith("less") ? 0 : all - now <= 20 ? all : now + 20;
        void loadCard(c);
      } else if (a === "kind-open") {
        c.ui.kindOpen = true;
        render(c);
        void loadCard(c).then(() => (c.el.querySelector("[data-in=kindAmt]") as HTMLElement | null)?.focus());
      } else void act(c, a).then(publish);
    });
    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const key = t.dataset.in as "joinAmt" | "exitAmt" | "kindAmt" | "kindMode" | undefined;
      if (!key) return;
      (c.ui as any)[key] = t.value;
      if (key === "kindAmt" || key === "kindMode") {
        const need = c.el.querySelector(".kind-need");
        if (need && c.state) need.innerHTML = kindNeedHtml(c);
      }
    };
    el.addEventListener("input", onInput);
    // "toggle" does not bubble: listen while it travels down to the details element.
    el.addEventListener("toggle", (e) => {
      if ((e.target as HTMLElement).classList?.contains("fund-more")) c.ui.details = (e.target as HTMLDetailsElement).open;
    }, true);
    el.addEventListener("change", onInput);
    return c;
  }

  const factoryDef = (e: FactoryEntry) => ({ id: e.account_id, title: e.account_id.split(".")[0], blurb: `Created ${day(Number(e.created_at))} by ${shortAccount(e.creator)} through the factory. Anyone can create a fund this way.` });

  async function loadFactoryPage(): Promise<FundCard[]> {
    if (!factory) return [];
    const { count, funds } = await factoryFunds(NET, factory, factoryLoaded, PAGE);
    // New funds may have been created since the first page: skip the ones already listed.
    const fresh = funds.filter((e) => !cards.some((c) => c.id === e.account_id));
    if (factoryLoaded === 0 && funds[0]) newestId = funds[0].account_id;
    const added = fresh.map((e) => addCard(factoryDef(e), "new"));
    // Keep the factory's order on the page, newest first, whichever cards the data files put there first.
    if (factoryLoaded === 0) for (const e of [...funds].reverse()) {
      const c = cards.find((x) => x.id === e.account_id);
      if (c && c.group === "new") rootNew.prepend(c.el);
    }
    factoryLoaded += funds.length;
    moreBtn.hidden = factoryLoaded >= count;
    return added;
  }

  // Scrolling to a card once is not enough: cards above it keep growing as the chain answers.
  // Keep it in view for a few seconds, unless the reader has started scrolling themselves.
  let userScrolled = false;
  for (const ev of ["wheel", "touchstart", "keydown"]) window.addEventListener(ev, () => (userScrolled = true), { passive: true });
  function focusCard(c: FundCard) {
    if (c.group === "legacy") legacyWrap.open = true;
    cards.forEach((x) => x.el.classList.toggle("focus", x === c));
    userScrolled = false;
    const start = Date.now();
    const keep = () => {
      if (userScrolled || Date.now() - start > 10_000) return;
      c.el.scrollIntoView({ block: "start", behavior: "auto" });
      setTimeout(keep, 400);
    };
    keep();
  }

  // ---- first paint: skeletons for everything we know about, then the chain fills them in
  for (const l of opt.legacy) addCard(l, "legacy");
  let first: FundCard[] = [];
  if (factory) {
    try {
      first = await loadFactoryPage();
      if (newestId) opt.onNewest?.(newestId);
      note.textContent = newestId ? "" : "The factory is live on testnet and no fund has been created through it yet. You can create the first one under Launch a fund.";
    } catch (e) {
      note.textContent = `The list of new funds could not be read from the factory: ${(e as Error).message}. The earlier funds below are still shown.`;
    }
  } else {
    note.textContent = "No release 0.3 fund is live on testnet yet. New funds will be listed here, read from the factory, as soon as it is. Until then the earlier funds below show how joining and exiting work.";
  }
  // The funds named in the data files come after the factory's list, so nothing jumps when it arrives.
  for (const k of opt.known) if (!opt.legacy.some((l) => l.id === k.id)) addCard(k, "new");
  note.hidden = !note.textContent;
  // With nothing newer to show, the earlier funds are the page: open the group.
  if (!newestId && !opt.known.length) legacyWrap.open = true;
  let linkedCard: FundCard | null = null;
  if (opt.linked) {
    linkedCard = cards.find((c) => c.id === opt.linked) ?? addCard({ id: opt.linked, title: opt.linked.split(".")[0], blurb: "Opened from a shared link." }, "new", "start");
    if (linkedCard.group === "legacy") legacyWrap.open = true;
  }

  // ---- wallet bar
  const bar = mountWalletBar(document.getElementById("wallet-bar")!, async () => {
    await Promise.all(cards.map(loadCard));
    publish();
  }, () => cards.forEach((c) => ((c.msg = ""), (c.msgTx = ""), (c.ui.steps = []))));
  const refresh = async () => {
    await Promise.all([...cards.map(loadCard), bar.paint()]);
    publish();
  };
  afterAction = () => void bar.paint();
  moreBtn.addEventListener("click", async () => {
    moreBtn.disabled = true;
    const added = await loadFactoryPage().catch(() => []);
    await Promise.all(added.map(loadCard));
    moreBtn.disabled = false;
    publish();
  });
  onAccount(() => void refresh());
  void loadPrices().then((p) => p && cards.forEach((c) => !c.busy && !c.el.contains(document.activeElement) && render(c)));
  // The chain is read straight away; the wallet library loads alongside and repaints when it is ready.
  void restore();
  await refresh();
  if (linkedCard) focusCard(linkedCard);
  // Poll only the cards on screen, one after another, and never a card whose wallet action is running
  // or that you are typing in.
  const onScreen = new Set<HTMLElement>();
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? onScreen.add(e.target as HTMLElement) : onScreen.delete(e.target as HTMLElement)))) : null;
  const watch = () => cards.forEach((c) => io?.observe(c.el));
  watch();
  setInterval(async () => {
    if (document.hidden) return;
    watch();
    for (const c of cards.filter((x) => !x.busy && (io ? onScreen.has(x.el) : true) && !x.el.contains(document.activeElement))) {
      await load(c).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 30_000);

  return {
    async showFund(id: string) {
      const c = addCard({ id, title: id.split(".")[0], blurb: `Created just now by ${shortAccount(currentAccount() || "you")} through the factory.` }, "new", "start");
      note.hidden = true;
      await loadCard(c);
      focusCard(c);
      publish();
    },
  };
}
