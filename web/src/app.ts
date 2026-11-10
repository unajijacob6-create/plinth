// Live fund dashboards and wallet actions (testnet).
import { view, rpc, explorer, accountLink } from "./chain.ts";
import { onAccount, restore, signIn, signOut, send, isCancel, currentAccount } from "./wallet.ts";

const NET = "testnet" as const;
const STORAGE = "1250000000000000000000";
const DECIMALS: Record<string, number> = { "wrap.testnet": 24, "wrap.near": 24, "meta-v2.pool.testnet": 24, "meta-pool.near": 24 };
const SYMBOLS: Record<string, string> = { "wrap.testnet": "wNEAR", "wrap.near": "wNEAR", "meta-v2.pool.testnet": "stNEAR", "meta-pool.near": "stNEAR" };
const SYMBOL = (t: string) => SYMBOLS[t] ?? (t.startsWith("pusd.") ? "pUSD" : t.split(".")[0]);
const dec = (t: string) => DECIMALS[t] ?? 6;
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
  const pct = (a: string, b: string) => `${((Number(a) / Number(b)) * 100).toFixed(0)}%`;
  const rules: [RegExp, (...m: string[]) => string][] = [
    [/^trade of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => `Trade is ${pct(a, held)} of the holding; the limit is ${Number(bps) / 100}%`],
    [/^stake of (\d+) is over (\d+) bps of the (\d+) held$/, (_, a, bps, held) => `Stake is ${pct(a, held)} of the wNEAR held; the limit is ${Number(bps) / 100}%`],
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
}

async function load(f: FundCard) {
  const [state, keys, trades, rejections] = await Promise.all([
    view(NET, f.id, "get_fund"),
    rpc(NET, "query", { request_type: "view_access_key_list", finality: "final", account_id: f.id }),
    view(NET, f.id, "get_trades", { from: 0, limit: 50 }),
    view(NET, f.id, "get_rejections", { from: 0, limit: 50 }),
  ]);
  f.state = state;
  const me = currentAccount();
  const mine = me ? await Promise.all([view<string>(NET, f.id, "get_shares", { account_id: me }), view<string[]>(NET, f.id, "get_owed", { account_id: me })]) : null;
  render(f, state, keys.keys.length, trades, rejections, mine);
}

function render(f: FundCard, s: any, keyCount: number, trades: any[], rejections: any[], mine: [string, string[]] | null) {
  const m = s.config.mandate;
  const open = s.subscription_open;
  const total = BigInt(s.total_shares);
  const tokens: string[] = m.tokens;
  const myShares = mine ? BigInt(mine[0]) : 0n;
  const owed = mine?.[1] ?? [];
  const myValue = total > 0n && myShares > 0n ? s.held.map(([t, v]: [string, string]) => fmt(t, (BigInt(v) * myShares) / total)).join(" + ") : "";
  const lastTrades = trades.slice(-4).reverse();
  const lastRefusals = rejections.slice(-3).reverse();
  f.el.innerHTML = `
    <header class="fund-h">
      <div><h3><a href="${accountLink(NET, f.id)}" target="_blank" rel="noopener" class="mono">${esc(f.id)}</a></h3><p class="muted small">${esc(f.blurb)}</p></div>
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
        currentAccount()
          ? `<p class="small">You (${esc(currentAccount())}): <b>${esc(myShares.toLocaleString("en"))}</b> shares${myValue ? ` = ${esc(myValue)}` : ""}${owed.some((x) => x !== "0") ? ` · owed ${owed.map((x, i) => (x !== "0" ? esc(fmt(tokens[i], x)) : "")).filter(Boolean).join(", ")}` : ""}</p>
             <div class="actions">
               ${open ? `<label class="sr" for="amt-${esc(f.id)}">pUSD to join with</label><input id="amt-${esc(f.id)}" class="amt" inputmode="decimal" value="10" aria-label="pUSD amount" /><button class="btn primary sm" data-act="join">Join with pUSD</button>` : ""}
               ${myShares > 0n ? `<button class="btn ghost sm" data-act="exit">Exit in kind</button>` : ""}
               ${owed.some((x) => x !== "0") ? `<button class="btn ghost sm" data-act="claim">Claim owed</button>` : ""}
               ${s.pending ? `<button class="btn ghost sm" data-act="settle">Settle trade</button>` : ""}
             </div>`
          : `<p class="small muted">Connect a testnet wallet above to join or exit.</p>`
      }
      <p class="status small" aria-live="polite"></p>
    </div>`;
}

async function act(f: FundCard, kind: string, status: HTMLElement) {
  const s = f.state;
  const tokens: string[] = s.config.mandate.tokens;
  const me = currentAccount();
  try {
    status.textContent = "Waiting for your wallet…";
    if (kind === "join") {
      const v = (f.el.querySelector(".amt") as HTMLInputElement).value.trim();
      if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error("enter an amount like 10 or 2.5");
      const [w, d = ""] = v.split(".");
      const units = (BigInt(w) * 1_000_000n + BigInt((d + "000000").slice(0, 6))).toString();
      await send([{ receiverId: tokens[0], methodName: "ft_transfer_call", args: { receiver_id: f.id, amount: units, msg: "" }, deposit: "1", gas: "150000000000000" }]);
    } else if (kind === "exit") {
      const shares = await view<string>(NET, f.id, "get_shares", { account_id: me });
      const calls: any[] = [];
      // Make sure you can receive every token the fund holds; otherwise that part stays owed to you.
      for (const t of tokens) {
        if ((await view(NET, t, "storage_balance_of", { account_id: me })) === null) calls.push({ receiverId: t, methodName: "storage_deposit", args: { account_id: me, registration_only: true }, deposit: STORAGE, gas: "30000000000000" });
      }
      calls.push({ receiverId: f.id, methodName: "redeem", args: { shares }, gas: "200000000000000" });
      await send(calls);
    } else if (kind === "claim") {
      await send([{ receiverId: f.id, methodName: "claim", args: {}, gas: "150000000000000" }]);
    } else if (kind === "settle") {
      await send([{ receiverId: f.id, methodName: "settle", args: {}, gas: "100000000000000" }]);
    }
    status.textContent = "Done.";
  } catch (e) {
    status.textContent = isCancel(e) ? "Cancelled." : `Failed: ${(e as Error).message ?? e}`;
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
    return { ...f, el };
  });
  for (const c of cards) {
    c.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
      if (b) void act(c, b.dataset.act!, c.el.querySelector(".status") as HTMLElement);
    });
  }
  const bar = document.getElementById("wallet-bar")!;
  const faucet = async () => {
    const st = bar.querySelector(".status") as HTMLElement;
    try {
      st.textContent = "Waiting for your wallet…";
      const tok = "pusd.plinthfund.testnet";
      await send([
        { receiverId: tok, methodName: "storage_deposit", args: { account_id: currentAccount() }, deposit: STORAGE, gas: "30000000000000" },
        { receiverId: tok, methodName: "mint", args: { account_id: currentAccount(), amount: "100000000" }, gas: "30000000000000" },
      ]);
      st.textContent = "100 test pUSD sent to you.";
    } catch (e) {
      st.textContent = isCancel(e) ? "Cancelled." : `Failed: ${(e as Error).message ?? e}`;
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
    bar.innerHTML = me
      ? `<span class="mono small">${esc(me)}</span>${bal ? `<span class="small muted">${esc(bal)}</span>` : ""}<button class="btn ghost sm" data-w="faucet">Get 100 test pUSD</button><button class="btn ghost sm" data-w="out">Disconnect</button><span class="status small" aria-live="polite"></span>`
      : `<button class="btn primary" data-w="in">Connect a testnet wallet</button><span class="small muted">Test tokens only. Nothing here is money.</span><span class="status small" aria-live="polite"></span>`;
  };
  bar.addEventListener("click", async (e) => {
    const w = ((e.target as HTMLElement).closest("button[data-w]") as HTMLButtonElement | null)?.dataset.w;
    if (w === "in") await signIn().catch(() => {});
    if (w === "out") await signOut();
    if (w === "faucet") await faucet();
  });
  onAccount(() => void refresh());
  await restore();
  await refresh();
  setInterval(() => void Promise.all(cards.map((c) => load(c).catch(() => {}))), 20_000);
}

export { explorer };
