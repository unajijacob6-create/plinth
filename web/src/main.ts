import "./style.css";
import run from "../../data/testnet-run.json";
import { verifyFund, explorer, accountLink, factoryOf, isAccountId, shortAccount, RELEASES, type Net } from "./chain.ts";
import { mountApp, humanReason, type App, type Stats } from "./app.ts";
import { fmt, loadMeta, units, dec } from "./tokens.ts";
import { mountLaunch } from "./launch.ts";
import openFund from "../../data/open-fund.json";
import earnRun from "../../data/earn-run.json";
import agentRun from "../../data/agent-run.json";
import { mountAgent, mountQuorum } from "./agent.ts";
import quorumRun from "../../data/quorum-run.json";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const R: any = run;
const tx = (k: string) => (R.tx[k] ? `<a href="${explorer("testnet", R.tx[k])}" target="_blank" rel="noopener">View transaction ↗</a>` : "");
const TOK: string = R.accounts.token;
const WRAP: string = R.accounts.wrap;
const runRelease = RELEASES[R.code_hash]?.version ?? "an old release";
const factory = factoryOf("testnet");

// ------------------------------------------------------------ phone menu
const menuBtn = $<HTMLButtonElement>("#menu-btn");
const siteNav = $("#site-nav");
const setMenu = (open: boolean) => {
  menuBtn.setAttribute("aria-expanded", String(open));
  siteNav.classList.toggle("open", open);
};
menuBtn.addEventListener("click", () => setMenu(menuBtn.getAttribute("aria-expanded") !== "true"));
siteNav.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) setMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuBtn.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    menuBtn.focus();
  }
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".nav")) setMenu(false);
});

// ------------------------------------------------------------ stats (live, from the chain)
function paintStats(s: Stats) {
  const cells: [string, string][] = [
    s.factoryCount !== null ? [String(s.factoryCount), s.factoryCount === 1 ? "fund created through the factory" : "funds created through the factory"] : [String(s.listed), "funds listed below, all on old releases"],
    [String(s.keys), "access keys across the funds listed"],
    [String(s.trades), s.trades === 1 ? "trade sent by the funds listed" : "trades sent by the funds listed"],
    [String(s.refusals), s.refusals === 1 ? "proposal refused on chain" : "proposals refused on chain"],
  ];
  const el = $("#stats");
  el.innerHTML = cells.map(([b, t]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join("");
  el.setAttribute("aria-busy", "false");
  $("#stats-note").textContent = `Read from NEAR testnet just now, across the ${s.listed} ${s.listed === 1 ? "fund" : "funds"} listed under Try it.`;
}
$("#limits-status").textContent = factory ? "Funds created through the factory on this page run release 0.3." : "No release 0.3 fund is live on testnet yet.";

// ------------------------------------------------------------ lifecycle
const proofHead = `Recorded on testnet, release ${esc(runRelease)}`;
const steps = [
  {
    t: "Launch keyless",
    body: `<p>One call to the factory creates the fund account, points it at the one published copy of the code and sets the rules. No key is ever added, so the account has no key from its first block.</p><ul><li>Allowed tokens, trade size, cost cap, time between trades</li><li>The only manager, and the 1Click signing key</li></ul>`,
    proof: `Fund <a href="${accountLink("testnet", R.fund)}" target="_blank" rel="noopener">${esc(shortAccount(R.fund))}</a><br/>Created in ${tx("create_fund_keyless")}<br/>Access keys after creation: <b>${esc(R.access_keys_after_create)}</b><br/><span class="muted">This run created the fund directly, before the factory existed.</span>`,
  },
  {
    t: "Join",
    body: `<p>During the join window, depositors send the fund its base token and get one share per token. Trading starts only after the window closes, so shares are priced without a price feed.</p><p>After the window, funds that allow it take new joiners in kind: you add every token the fund holds, in the fund's own proportions, and receive shares. No price is involved either way.</p>`,
    proof: `Alice ${esc(fmt(TOK, "60000000"))} ${tx("alice_subscribe")}<br/>Bob ${esc(fmt(TOK, "40000000"))} ${tx("bob_subscribe")}`,
  },
  {
    t: "Propose",
    op: true,
    body: `<p>The manager, a person or an AI agent, hands the contract a live 1Click quote. That is all it can do. It cannot withdraw, pause or change the rules.</p><p>A fund can also be launched with no manager. Then anyone can ask a fixed program for a proposal, and it goes through the same checks.</p>`,
    proof: `Manager ${esc(shortAccount(R.accounts.operator))}<br/>Accepted proposal: ${tx("propose_trade")}`,
  },
  {
    t: "Contract checks",
    body: `<p>The contract verifies 1Click's signature over the quote, then the rules:</p><ul><li>output and refunds go to the fund, nowhere else</li><li>both tokens allowed; size within the limit; all-in cost within the cap, from the signed dollar values</li><li>quote fresh, deposit address open long enough and never used before</li></ul>`,
    proof: `Refused: output to the manager ${tx("refused_wrong_recipient")}<br/>Refused: 30% in one trade ${tx("refused_too_large")}`,
  },
  {
    t: "Send and settle",
    body: `<p>The contract registers the 1Click deposit address on the token and transfers the input in one step. 1Click hands the output to the fund, which settles the trade on the spot.</p><p>The fund counts a token only when it sees it arrive. It never trusts a balance it reads for trade output.</p>`,
    proof: `Deposit address received ${esc(fmt(TOK, R.deposit_address_pusd))}<br/>Delivered ${tx("solver_delivers")}<br/>Settled ${tx("settle")}<br/><span class="muted">In this older run the trade was settled by a separate call that read the fund's balance. Release 0.3 removed that step; it is where the known issue was.</span>`,
  },
  {
    t: "Exit in kind",
    body: `<p>Any holder burns shares, all or some, and receives the same fraction of every token the fund holds. No price, no price feed, no manager. If a transfer fails, the amount stays owed and can be claimed later.</p>`,
    proof: `Bob exited with 40% ${tx("bob_redeem")}<br/>received ${esc(fmt(TOK, R.bob_received.pusd))} + ${esc(fmt(WRAP, R.bob_received.wnear))}`,
  },
];
const stepsEl = $(".steps");
stepsEl.innerHTML = steps.map((s, i) => `<button role="tab" id="tab-${i}" aria-controls="step-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="${s.op ? "who-op" : ""}"><span class="n">0${i + 1}</span>${s.t}</button>`).join("");
const show = (i: number) => {
  stepsEl.querySelectorAll("button").forEach((b, j) => {
    b.setAttribute("aria-selected", String(j === i));
    b.tabIndex = j === i ? 0 : -1;
  });
  $("#step-panel").innerHTML = `<div><h3>${steps[i].t}</h3>${steps[i].body}</div><div class="proof"><p class="eyebrow">${proofHead}</p>${steps[i].proof}</div>`;
  $("#step-panel").setAttribute("aria-labelledby", `tab-${i}`);
};
stepsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) show([...stepsEl.children].indexOf(b));
});
stepsEl.addEventListener("keydown", (e) => {
  const cur = [...stepsEl.children].findIndex((b) => b.getAttribute("aria-selected") === "true");
  const k = (e as KeyboardEvent).key;
  if (k !== "ArrowRight" && k !== "ArrowLeft") return;
  const n = (cur + (k === "ArrowRight" ? 1 : steps.length - 1)) % steps.length;
  show(n);
  (stepsEl.children[n] as HTMLElement).focus();
});
show(0);

// ------------------------------------------------------------ verifier
const input = $<HTMLInputElement>("#fund-id");
const net = $<HTMLSelectElement>("#fund-net");
const out = $("#verify-out");
const linkedRaw = new URLSearchParams(location.search).get("fund")?.trim().toLowerCase() ?? "";
const linked = isAccountId(linkedRaw) ? linkedRaw : null;
let userTyped = false;
input.addEventListener("input", () => (userTyped = true));
input.value = linked ?? R.fund;
out.innerHTML = `<span class="muted">Enter a fund account and press Verify. ${linked ? "Prefilled with the fund from your link." : "Prefilled with the fund from the recorded run, which is on an old release."}</span>`;
let verifySeq = 0;
async function runVerify() {
  const id = input.value.trim().toLowerCase();
  if (!id) return;
  const seq = ++verifySeq;
  if (!isAccountId(id)) {
    out.innerHTML = `<div class="verdict bad">That is not a valid account name.</div>`;
    return;
  }
  out.innerHTML = `<span class="muted">Reading ${esc(shortAccount(id))} from ${esc(net.value)}…</span>`;
  try {
    const v = await verifyFund(net.value as Net, id);
    if (v.state) await loadMeta(net.value as Net, v.state.config.mandate.tokens);
    if (seq !== verifySeq) return;
    const lines = v.checks
      .map((c) => `<div class="line"><span class="mark ${c.warn ? "warn" : c.note ? "note" : c.ok ? "ok" : "bad"}" aria-hidden="true">${c.warn ? "!" : c.note ? "i" : c.ok ? "✓" : "✗"}</span><div><div class="t"><span class="sr">${c.warn ? "Warning: " : c.note ? "Note: " : c.ok ? "Passed: " : "Failed: "}</span>${esc(c.label)}</div><div class="d">${esc(c.detail)}</div></div></div>`)
      .join("");
    const s = v.state;
    const kv = s
      ? `<div class="kv">Holds ${s.held.map(([t, a]: [string, string]) => esc(fmt(t, a))).join(" · ")}<br/>${esc(units(s.total_shares, dec(s.config.mandate.tokens[0]), 6))} shares issued · ${esc(s.trades)} trades · ${esc(s.rejections)} refused${s.pending ? " · a trade is in flight" : ""}</div>`
      : "";
    const tag = v.status === "known-issue" ? `<p class="known-tag"><b>Known issue: old release.</b> Release ${esc(v.release?.version ?? "")} can count tokens that bounce back as the fund's own. <a href="#limit-known">Read the limit</a></p>` : "";
    const verdict =
      v.status === "clean"
        ? `<div class="verdict ok">Verified: no keys, published code that nobody can change, a listed release with no known issue, and rules that add up.</div>`
        : v.status === "test-signer"
          ? `<div class="verdict note">Keys, code and rules check out. Quotes are signed by a test signer chosen by the fund's creator, not by NEAR Intents: a testnet stand-in only.</div>`
          : v.status === "known-issue"
            ? `<div class="verdict warn">Keys and code check out, but this release has a known accounting bug. Treat this fund as history, not as safe.${v.standIn ? " Its quotes are signed by a test signer, a testnet stand-in." : ""}</div>`
          : `<div class="verdict bad">Not verified: see the failed checks above.</div>`;
    out.innerHTML = lines + kv + tag + verdict;
  } catch (e) {
    if (seq !== verifySeq) return;
    out.innerHTML = `<div class="verdict bad">Could not read ${esc(shortAccount(id))}: ${esc((e as Error).message)}.</div>`;
  }
}
$("#verify-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void runVerify();
});
function verifyNow(id: string, scroll = true) {
  input.value = id;
  net.value = "testnet";
  userTyped = true;
  if (scroll) $("#verify").scrollIntoView({ block: "start" });
  void runVerify();
}

// ------------------------------------------------------------ timeline
$("#run-sub").innerHTML = `Recorded ${esc(R.started_at.slice(0, 10))} on NEAR testnet, on release ${esc(runRelease)}, which has the known issue described under <a href="#limit-known">Limits</a>. Every step links to its transaction. 1Click has no testnet, so a test signer and a solver account (${esc(shortAccount(R.accounts.solver))}) stand in for it.`;
const T: [string, string, string, string?][] = [
  ["create_fund_keyless", "Fund created with no keys", `${R.access_keys_after_create} access keys from the first block.`],
  ["alice_subscribe", "Alice joins", `${fmt(TOK, "60000000")} for 60 shares.`],
  ["bob_subscribe", "Bob joins", `${fmt(TOK, "40000000")} for 40 shares.`],
  ["refused_wrong_recipient", "Refused: quote pays the manager", humanReason(R.rejections[0]?.reason ?? ""), "no"],
  ["refused_too_large", "Refused: 30% in one trade", humanReason(R.rejections[1]?.reason ?? ""), "no"],
  ["propose_trade", `Accepted: ${fmt(TOK, R.deposit_address_pusd)} for wNEAR`, "Signature, recipients, size, cost and freshness all within the rules; the contract sent the input itself.", "yes"],
  ["solver_delivers", "Output delivered", `${fmt(WRAP, "20000000000000000000000")} to the fund.`],
  ["settle", "Settled by a separate call", "How releases 0.1 and 0.2 closed a trade. Release 0.3 settles when the output arrives.", "yes"],
  ["bob_redeem", "Bob exits in kind", `${fmt(TOK, R.bob_received.pusd)} + ${fmt(WRAP, R.bob_received.wnear)}, exactly 40% of each.`, "yes"],
];
$("#timeline").innerHTML = T.map(([k, h, p, c]) => `<li class="${c ?? ""}"><div class="tl-h"><b>${esc(h)}</b>${c ? `<span class="tag ${c}">${c === "no" ? "refused" : "ok"}</span>` : ""}${tx(k)}</div><p>${esc(p)}</p></li>`).join("");

// ------------------------------------------------------------ refusals
$("#refusal-cards").innerHTML = R.rejections
  .map((r: any, i: number) => `<div class="card"><span class="tag no">refused</span><h3>${esc(humanReason(r.reason))}</h3><p>Recorded in the contract's own refusal log. ${tx(i === 0 ? "refused_wrong_recipient" : "refused_too_large")}</p></div>`)
  .join("");

// ------------------------------------------------------------ live funds + wallet + launch
let app: App | null = null;
void mountApp({
  legacy: [
    { id: (openFund as any).fund, title: "Open fund", blurb: "Anyone can join with test pUSD while its window is open, and exit at any time." },
    { id: R.fund, title: "Demo fund", blurb: "The fund from the recorded run; the AI operator traded it." },
    { id: (earnRun as any).fund, title: "Earning fund", blurb: "Stakes idle wNEAR into Meta Pool stNEAR; the manager is paid in new shares." },
  ],
  linked,
  onStats: paintStats,
  onNewest: (id) => {
    // The newest fund on the current release is the better default than the recorded old one.
    if (!linked && !userTyped) {
      input.value = id;
      out.innerHTML = `<span class="muted">Enter a fund account and press Verify. Prefilled with the newest fund from the factory.</span>`;
    }
  },
  onVerify: (id) => verifyNow(id),
}).then((a) => (app = a));

mountLaunch((id) => {
  void app?.showFund(id).then(() => verifyNow(id, false));
});

mountAgent(agentRun);
mountQuorum(quorumRun);
