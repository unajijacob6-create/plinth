// Live fund dashboards and wallet actions (testnet).
import { view, rpc, explorer, accountLink } from "./chain.ts";
import { onAccount, restore, signIn, signOut, send, isCancel, currentAccount } from "./wallet.ts";

const NET = "testnet" as const;
const STORAGE = "1250000000000000000000";
const DECIMALS: Record<string, number> = { "wrap.testnet": 24, "wrap.near": 24, "meta-v2.pool.testnet": 24, "meta-pool.near": 24 };
const SYMBOLS: Record<string, string> = { "wrap.testnet": "wNEAR", "wrap.near": "wNEAR", "meta-v2.pool.testnet": "stNEAR", "meta-pool.near": "stNEAR" };
/** Token metadata read from the token itself (ft_metadata), for tokens not in the tables above. */
const META: Record<string, { decimals: number; symbol: string }> = {};
export async function loadMeta(net: "testnet" | "mainnet", tokens: string[]): Promise<void> {
  await Promise.all(
    tokens
      .filter((t) => !(t in META) && !(t in DECIMALS) && !t.startsWith("pusd."))
      .map(async (t) => {
        const m = await view<any>(net, t, "ft_metadata").catch(() => null);
        if (m && Number.isInteger(m.decimals)) META[t] = { decimals: m.decimals, symbol: String(m.symbol ?? "").slice(0, 12) || shortName(t) };
      }),
  );
}
const shortName = (t: string) => (/^[0-9a-f]{64}$/.test(t) ? `${t.slice(0, 6)}…` : t.split(".")[0]);
const SYMBOL = (t: string) => SYMBOLS[t] ?? META[t]?.symbol ?? (t.startsWith("pusd.") ? "pUSD" : shortName(t));
const dec = (t: string) => DECIMALS[t] ?? META[t]?.decimals ?? 6;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function fmt(t: string, v: string | bigint, digits = 4): string {
  const n = BigInt(v);
  const d = dec(t);
  const whole = n / 10n ** BigInt(d);
  const frac = (n % 10n ** BigInt(d)).toString().padStart(d, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en")}${frac ? "." + frac : ""} ${SYMBOL(t)}`;
}
/** The contract's refusal reasons, in plain words for the page (the chain keeps the exact text). */
export function humanReason(r: string): string {
  // Exact, one decimal, rounded up so a trade just over the limit never reads as equal to it.
  const pct = (a: string, b: string) => {
    if (BigInt(b) === 0n) return "all";
    const tenths = (BigInt(a) * 1000n + BigInt(b) - 1n) / BigInt(b);
    return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""}%`;
  };
  const rules: [RegExp, (...m: string[]) => string][] = [
    [/^trade of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => (BigInt(held) === 0n ? "The fund holds none of that token" : `Trade is ${pct(a, held)} of the holding; the limit is ${Number(bps) / 100}%`)],
    [/^stake of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => (BigInt(held) === 0n ? "The fund holds no wNEAR to stake" : `Stake is ${pct(a, held)} of the wNEAR held; the limit is ${Number(bps) / 100}%`)],
    [/^stake of \d+ is below the minimum \d+$/, () => "Stake is below the fund's minimum"],
    [/^all-in cost (\d+) bps is over the mandate's (\d+) bps$/, (_, c, m) => `Trade would cost ${Number(c) / 100}%; the limit is ${Number(m) / 100}%`],
    [/^quote is (\d+) s old; the mandate allows (\d+) s$/, (_, a, m) => `Quote is ${a} seconds old; the limit is ${m}`],
    [/^quote must deliver to and refund to this fund on NEAR$/, () => "The trade would pay someone other than the fund"],
    [/^(.+) -> (.+) is not allowed by the mandate$/, () => "That pair of tokens is not allowed by the fund's rules"],
    [/^the quote's deposit address closes too soon$/, () => "The quote expires too soon"],
    [/^this deposit address was already used$/, () => "The quote was already used once"],
    [/^customRecipientMsg is not allowed$|^(.+) is not supported$/, () => "The quote asks for an option the fund does not allow"],
  ];
  for (const [re, f] of rules) {
    const m = r.match(re);
    if (m) return f(...m);
  }
  return r.charAt(0).toUpperCase() + r.slice(1);
}
const ago = (s: number) => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - s);
  return d < 90 ? `${d}s ago` : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 172800 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
};

interface FundCard {
  id: string;
  title: string;
  blurb: string;
  el: HTMLElement;
  state?: any;
  /** Kept across re-renders so a result message and a typed amount are never wiped. */
  msg: string;
  amount: string;
  busy: boolean;
}

const REDEEM_WAIT_SECONDS = 600;
const now = () => Math.floor(Date.now() / 1000);
const tail = (n: number, k: number) => ({ from: Math.max(0, n - k), limit: k });

async function load(f: FundCard) {
  const me = currentAccount();
  const state = await view<any>(NET, f.id, "get_fund");
  // Read only the newest entries: the contract pages from the start.
  const [keys, trades, rejections, mine] = await Promise.all([
    rpc(NET, "query", { request_type: "view_access_key_list", finality: "final", account_id: f.id }),
    view<any[]>(NET, f.id, "get_trades", tail(Number(state.trades), 4)),
    view<any[]>(NET, f.id, "get_rejections", tail(Number(state.rejections), 3)),
    me ? Promise.all([view<string>(NET, f.id, "get_shares", { account_id: me }), view<string[]>(NET, f.id, "get_owed", { account_id: me })]) : Promise.resolve(null),
  ]);
  // The wallet changed while this was loading: these numbers belong to someone else.
  if (currentAccount() !== me) return;
  f.state = state;
  render(f, me, state, keys.keys.length, trades, rejections, mine as [string, string[]] | null);
}

/** Exit is blocked by the contract for 10 minutes after a trade is sent, until it settles. */
function exitWait(s: any): number {
  return s.pending ? Math.max(0, Number(s.pending.sent_at) + REDEEM_WAIT_SECONDS - now()) : 0;
}

function render(f: FundCard, me: string | null, s: any, keyCount: number, trades: any[], rejections: any[], mine: [string, string[]] | null) {
  const m = s.config.mandate;
  const open = s.subscription_open;
  const total = BigInt(s.total_shares);
  const tokens: string[] = m.tokens;
  const myShares = mine ? BigInt(mine[0]) : 0n;
  const owed = mine?.[1] ?? [];
  const myValue = total > 0n && myShares > 0n ? s.held.map(([t, v]: [string, string]) => fmt(t, (BigInt(v) * myShares) / total)).join(" + ") : "";
  const lastTrades = [...trades].reverse();
  const lastRefusals = [...rejections].reverse();
  const wait = exitWait(s);
  const canSettle = s.pending?.status === "Sent";
  f.el.innerHTML = `
    <header class="fund-h">
      <div><h3><a href="${accountLink(NET, f.id)}" target="_blank" rel="noopener">${esc(f.id)}</a></h3><p class="muted small">${esc(f.blurb)}</p></div>
      <div class="chips"><span class="chip ${keyCount === 0 ? "ok" : "bad"}">${keyCount} keys</span><span class="chip">${open ? `joins open until ${new Date(m.subscription_closes_at * 1000).toISOString().slice(0, 10)}` : "trading"}</span>${s.pending ? `<span class="chip warn">trade in flight</span>` : ""}</div>
    </header>
    <div class="fund-grid">
      <div class="kv"><span>Holdings</span><b>${s.held.map(([t, v]: [string, string]) => esc(fmt(t, v))).join("<br/>")}</b></div>
      <div class="kv"><span>Shares</span><b>${esc(total.toLocaleString("en"))}</b></div>
      <div class="kv"><span>Trades · refusals</span><b>${esc(s.trades)} · ${esc(s.rejections)}</b></div>
      <div class="kv"><span>Rules</span><b class="small">≤ ${m.max_trade_bps / 100}% per trade · ≤ ${m.max_cost_bps / 100}% cost · ≤ ${m.max_trades_per_day}/day${m.management_fee_bps ? ` · fee ${m.management_fee_bps / 100}%/yr in shares` : ""}${m.staking ? ` · stakes into ${SYMBOL(m.tokens[m.staking.lst_index])}` : ""}</b></div>
    </div>
    ${lastTrades.length ? `<div class="mini"><p class="eyebrow">Recent trades</p>${lastTrades.map((t) => `<div class="row"><span class="tags">${t.stake ? `<span class="tag">stake</span> ` : ""}<span class="tag ${t.status === "Settled" ? "yes" : t.status === "Failed" || t.status === "Abandoned" ? "no" : ""}">${esc(t.status)}</span></span><span>${esc(fmt(tokens[t.sell], t.amount_in.toString()))} → ${t.status === "Settled" ? esc(fmt(tokens[t.buy], t.received_out)) : `≥ ${esc(fmt(tokens[t.buy], t.min_out))}`}</span><span class="muted small">${ago(t.sent_at)}</span></div>`).join("")}</div>` : ""}
    ${lastRefusals.length ? `<div class="mini"><p class="eyebrow">Refused on chain</p>${lastRefusals.map((r) => `<div class="row"><span class="tag no">refused</span><span class="small">${esc(humanReason(r.reason))}</span><span class="muted small">${ago(r.at)}</span></div>`).join("")}</div>` : ""}
    <div class="you">
      ${
        me
          ? `<p class="small">You (${esc(me)}): <b>${esc(myShares.toLocaleString("en"))}</b> shares${myValue ? ` = ${esc(myValue)}` : ""}${owed.some((x) => x !== "0") ? ` · owed ${owed.map((x, i) => (x !== "0" ? esc(fmt(tokens[i], x)) : "")).filter(Boolean).join(", ")}` : ""}</p>
             <div class="actions">
               ${open ? `<label class="sr" for="amt-${esc(f.id)}">pUSD to join with</label><input id="amt-${esc(f.id)}" class="amt" inputmode="decimal" value="${esc(f.amount)}" aria-label="pUSD amount" /><button class="btn primary sm" data-act="join" ${f.busy ? "disabled" : ""}>Join with pUSD</button>` : ""}
               ${myShares > 0n ? (wait > 0 ? `<button class="btn ghost sm" disabled>Exit opens in ${Math.ceil(wait / 60)} min</button>` : `<button class="btn ghost sm" data-act="exit" ${f.busy ? "disabled" : ""}>Exit in kind</button>`) : ""}
               ${owed.some((x) => x !== "0") ? `<button class="btn ghost sm" data-act="claim" ${f.busy ? "disabled" : ""}>Claim owed</button>` : ""}
               ${canSettle ? `<button class="btn ghost sm" data-act="settle" ${f.busy ? "disabled" : ""}>Settle trade</button>` : ""}
             </div>
             ${myShares > 0n && wait > 0 ? `<p class="small muted">A trade is in flight. Exits open once it settles, or ${Math.ceil(wait / 60)} min after it was sent.</p>` : ""}`
          : `<p class="small muted">Connect a testnet wallet above to join or exit.</p>`
      }
      <p class="status small" aria-live="polite">${esc(f.msg)}</p>
    </div>`;
  const input = f.el.querySelector(".amt") as HTMLInputElement | null;
  input?.addEventListener("input", () => (f.amount = input.value));
}

const setMsg = (f: FundCard, msg: string) => {
  f.msg = msg;
  const st = f.el.querySelector(".status");
  if (st) st.textContent = msg;
};

async function registrations(me: string, tokens: string[]): Promise<any[]> {
  const calls: any[] = [];
  for (const t of tokens) {
    if ((await view(NET, t, "storage_balance_of", { account_id: me })) === null) calls.push({ receiverId: t, methodName: "storage_deposit", args: { account_id: me, registration_only: true }, deposit: STORAGE, gas: "30000000000000" });
  }
  return calls;
}

async function act(f: FundCard, kind: string) {
  const me = currentAccount();
  if (!me || f.busy) return;
  f.busy = true;
  try {
    // Act on fresh state, not the last poll.
    const s = await view<any>(NET, f.id, "get_fund");
    f.state = s;
    const m = s.config.mandate;
    const tokens: string[] = m.tokens;
    const shares = async () => BigInt(await view<string>(NET, f.id, "get_shares", { account_id: me }));
    setMsg(f, "Waiting for your wallet…");
    if (kind === "join") {
      const v = f.amount.trim();
      if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error("enter an amount like 10 or 2.5");
      const [w, d = ""] = v.split(".");
      const units = BigInt(w) * 1_000_000n + BigInt((d + "000000").slice(0, 6));
      if (!s.subscription_open) throw new Error("joins are closed for this fund");
      if (units < BigInt(m.min_subscription)) throw new Error(`the minimum is ${fmt(tokens[0], m.min_subscription)}`);
      const room = BigInt(m.max_total_subscriptions) - BigInt(s.total_subscribed);
      if (units > room) throw new Error(`the fund has room for ${fmt(tokens[0], room > 0n ? room : 0n)} more`);
      const bal = BigInt(await view<string>(NET, tokens[0], "ft_balance_of", { account_id: me }).catch(() => "0"));
      if (bal < units) throw new Error(`you have ${fmt(tokens[0], bal)}; take test pUSD from the faucet above`);
      const before = await shares();
      await send([{ receiverId: tokens[0], methodName: "ft_transfer_call", args: { receiver_id: f.id, amount: units.toString(), msg: "" }, deposit: "1", gas: "150000000000000" }]);
      const got = (await shares()) - before;
      setMsg(f, got > 0n ? `Joined: ${got.toLocaleString("en")} new shares.` : "The fund returned your pUSD; no shares were issued.");
    } else if (kind === "exit") {
      if (exitWait(s) > 0) throw new Error("a trade is in flight; exits open once it settles or 10 minutes after it was sent");
      const mine = await shares();
      if (mine === 0n) throw new Error("you have no shares in this fund");
      // Register only on tokens you will actually receive (your share of a zero holding is nothing).
      const total = BigInt(s.total_shares);
      const receiving = tokens.filter((t, i) => (BigInt(s.held[i][1]) * mine) / total > 0n);
      await send([...(await registrations(me, receiving)), { receiverId: f.id, methodName: "redeem", args: { shares: mine.toString() }, gas: "200000000000000" }]);
      const left = await shares();
      setMsg(f, left < mine ? "Exited: your share of every token is on its way to you." : "The exit did not go through; your shares are unchanged.");
    } else if (kind === "claim") {
      const owed = await view<string[]>(NET, f.id, "get_owed", { account_id: me });
      // A payout fails mostly because you are not registered on that token: register first.
      const need = tokens.filter((_, i) => owed[i] && owed[i] !== "0");
      if (!need.length) throw new Error("nothing is owed to you");
      await send([...(await registrations(me, need)), { receiverId: f.id, methodName: "claim", args: {}, gas: "150000000000000" }]);
      setMsg(f, "Claim sent. Anything that still cannot be paid stays owed to you.");
    } else if (kind === "settle") {
      if (s.pending?.status !== "Sent") throw new Error("there is no trade ready to settle");
      await send([{ receiverId: f.id, methodName: "settle", args: {}, gas: "100000000000000" }]);
      const after = await view<any>(NET, f.id, "get_fund");
      setMsg(f, after.pending ? "Not settled yet: the output has not arrived. Try again in a minute." : "Settled.");
    }
  } catch (e) {
    setMsg(f, isCancel(e) ? "Cancelled." : `Failed: ${(e as Error).message ?? e}`);
  } finally {
    f.busy = false;
  }
  await load(f).catch(() => {});
}

export async function mountApp(funds: { id: string; title: string; blurb: string }[]) {
  const root = document.getElementById("funds")!;
  const cards: FundCard[] = funds.map((f) => {
    const el = document.createElement("article");
    el.className = "fund";
    el.innerHTML = `<p class="muted">Loading ${esc(f.id)}…</p>`;
    root.appendChild(el);
    return { ...f, el, msg: "", amount: "10", busy: false };
  });
  for (const c of cards) {
    c.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
      if (b && !b.disabled) void act(c, b.dataset.act!);
    });
  }
  const bar = document.getElementById("wallet-bar")!;
  let barMsg = "";
  const setBar = (m: string) => {
    barMsg = m;
    const st = bar.querySelector(".status");
    if (st) st.textContent = m;
  };
  const faucet = async () => {
    const me = currentAccount();
    if (!me) return;
    try {
      setBar("Waiting for your wallet…");
      const tok = "pusd.plinthfund.testnet";
      const calls: any[] = (await view(NET, tok, "storage_balance_of", { account_id: me })) === null ? [{ receiverId: tok, methodName: "storage_deposit", args: { account_id: me }, deposit: STORAGE, gas: "30000000000000" }] : [];
      calls.push({ receiverId: tok, methodName: "mint", args: { account_id: me, amount: "100000000" }, gas: "30000000000000" });
      await send(calls);
      setBar("100 test pUSD sent to you.");
    } catch (e) {
      setBar(isCancel(e) ? "Cancelled." : `Failed: ${(e as Error).message ?? e}`);
    }
    void refresh();
  };
  const refresh = async () => {
    await Promise.all(cards.map((c) => load(c).catch((e) => (c.el.innerHTML = `<p class="bad">Could not read ${esc(c.id)}: ${esc((e as Error).message)}</p>`))));
    const me = currentAccount();
    let bal = "";
    if (me) {
      try {
        bal = fmt("pusd.plinthfund.testnet", await view<string>(NET, "pusd.plinthfund.testnet", "ft_balance_of", { account_id: me }));
      } catch {
        bal = "";
      }
    }
    if (currentAccount() !== me) return;
    bar.innerHTML = me
      ? `<span class="small">${esc(me)}</span>${bal ? `<span class="small muted">${esc(bal)}</span>` : ""}<button class="btn ghost sm" data-w="faucet">Get 100 test pUSD</button><button class="btn ghost sm" data-w="out">Disconnect</button><span class="status small" aria-live="polite">${esc(barMsg)}</span>`
      : `<button class="btn primary" data-w="in">Connect a testnet wallet</button><span class="small muted">Test tokens only. Nothing here is money.</span><span class="status small" aria-live="polite">${esc(barMsg)}</span>`;
  };
  bar.addEventListener("click", async (e) => {
    const w = ((e.target as HTMLElement).closest("button[data-w]") as HTMLButtonElement | null)?.dataset.w;
    if (w === "in") await signIn().catch(() => {});
    if (w === "out") {
      barMsg = "";
      cards.forEach((c) => (c.msg = ""));
      await signOut();
    }
    if (w === "faucet") await faucet();
  });
  onAccount(() => void refresh());
  await restore();
  await refresh();
  // Poll, but never re-render a card while its wallet action runs or while you are typing in it.
  setInterval(() => void Promise.all(cards.filter((c) => !c.busy && !c.el.contains(document.activeElement)).map((c) => load(c).catch(() => {}))), 20_000);
}

export { explorer };
