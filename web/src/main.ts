import "./style.css";
import run from "../../data/testnet-run.json";
import { verifyFund, explorer, accountLink, type Net } from "./chain.ts";
import { mountApp, fmt, humanReason } from "./app.ts";
import openFund from "../../data/open-fund.json";
import earnRun from "../../data/earn-run.json";
import agentRun from "../../data/agent-run.json";
import { mountAgent, mountQuorum } from "./agent.ts";
import quorumRun from "../../data/quorum-run.json";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const R: any = run;
const tx = (k: string) => (R.tx[k] ? `<a href="${explorer("testnet", R.tx[k])}" target="_blank" rel="noopener">View transaction ↗</a>` : "");
const pusd = (v: string | number) => (Number(v) / 1e6).toLocaleString("en", { maximumFractionDigits: 2 });
const wnear = (v: string | number) => (Number(BigInt(v) / 10n ** 18n) / 1e6).toLocaleString("en", { maximumFractionDigits: 4 });

// ------------------------------------------------------------ stats (all from data/testnet-run.json)
$("#stats").innerHTML = [
  [String(R.access_keys_at_end), "", "access keys on the fund"],
  [String(R.rejections.length), "", "bad trades refused on chain"],
  [String(R.after_redeem.trades), "", "trade settled through the contract"],
  ["40", "%", "of every token to the depositor who left"],
]
  .map(([b, u, s]) => `<div class="stat"><b>${b}<small>${u}</small></b><span>${s}</span></div>`)
  .join("");

// ------------------------------------------------------------ lifecycle
const steps = [
  {
    t: "Launch keyless",
    body: `<p>One transaction creates the fund account, deploys the code and sets the mandate. No key is ever added, so the account has no key from its first block.</p><ul><li>Allowed tokens, trade size, cost cap, cooldown, quote age</li><li>The only operator, and the 1Click signing key</li></ul>`,
    proof: `Fund <a href="${accountLink("testnet", R.fund)}" target="_blank" rel="noopener">${esc(R.fund)}</a><br/>Created in ${tx("create_fund_keyless")}<br/>Access keys after creation: <b>${R.access_keys_after_create}</b>`,
  },
  {
    t: "Subscribe",
    body: `<p>During the subscription window, depositors send the fund its base token and get one share per unit. Trading starts only after the window closes, so shares are priced without an oracle.</p>`,
    proof: `Alice ${pusd(60_000_000)} pUSD ${tx("alice_subscribe")}<br/>Bob ${pusd(40_000_000)} pUSD ${tx("bob_subscribe")}`,
  },
  {
    t: "Propose",
    op: true,
    body: `<p>The operator, a person or an AI agent, hands the contract a live 1Click quote. That is all it can do. It cannot withdraw, pause, change rules or touch any other method.</p>`,
    proof: `Operator ${esc(R.accounts.operator)}<br/>Accepted proposal: ${tx("propose_trade")}`,
  },
  {
    t: "Contract checks",
    body: `<p>The contract verifies 1Click's ed25519 signature over the quote, then the mandate:</p><ul><li>output and refunds go to the fund, nowhere else</li><li>both tokens allowed; size ≤ cap; all-in cost ≤ cap from the signed USD marks</li><li>quote fresh, deposit address open long enough and never used before</li></ul>`,
    proof: `Refused: output to the operator ${tx("refused_wrong_recipient")}<br/>Refused: 30% in one trade ${tx("refused_too_large")}`,
  },
  {
    t: "Send and settle",
    body: `<p>The contract registers the 1Click deposit address on the token and transfers the input in one receipt. 1Click delivers the output to the fund. Anyone can then settle the trade: the contract reads the fund's balances and closes it.</p>`,
    proof: `Deposit address received ${pusd(R.deposit_address_pusd)} pUSD<br/>Delivered ${tx("solver_delivers")} · settled ${tx("settle")} → <b>${esc(R.settle_status)}</b>`,
  },
  {
    t: "Redeem in kind",
    body: `<p>Any holder burns shares and receives the same fraction of every token the fund holds. No price, no oracle, no operator. If a transfer fails, the amount stays owed and can be claimed later.</p>`,
    proof: `Bob redeemed 40% ${tx("bob_redeem")}<br/>received ${pusd(R.bob_received.pusd)} pUSD + ${wnear(R.bob_received.wnear)} wNEAR`,
  },
];
const stepsEl = $(".steps");
stepsEl.innerHTML = steps.map((s, i) => `<button role="tab" id="tab-${i}" aria-controls="step-panel" aria-selected="${i === 0}" class="${s.op ? "who-op" : ""}"><span class="n">0${i + 1}</span>${s.t}</button>`).join("");
const show = (i: number) => {
  stepsEl.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
  $("#step-panel").innerHTML = `<div><h3>${steps[i].t}</h3>${steps[i].body}</div><div class="proof"><p class="eyebrow">On testnet</p>${steps[i].proof}</div>`;
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
input.value = R.fund;
out.innerHTML = `<span class="muted">Enter a fund account and press Verify. Prefilled with the recorded testnet fund.</span>`;
async function runVerify() {
  const id = input.value.trim();
  if (!id) return;
  out.innerHTML = `<span class="muted">Reading ${esc(id)} from ${net.value}…</span>`;
  try {
    const v = await verifyFund(net.value as Net, id);
    const lines = v.checks.map((c) => `<div class="line"><span class="mark ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"}</span><div><div class="t">${esc(c.label)}</div><div class="d">${esc(c.detail)}</div></div></div>`).join("");
    const s = v.state;
    const kv = s
      ? `<div class="kv">Holds ${s.held.map(([t, a]: [string, string]) => esc(fmt(t, a))).join(" · ")}<br/>${esc(BigInt(s.total_shares).toLocaleString("en"))} shares · ${esc(s.trades)} trades · ${esc(s.rejections)} refused${s.pending ? " · a trade is in flight" : ""}</div>`
      : "";
    out.innerHTML = lines + kv + `<div class="verdict ${v.ok ? "ok" : "bad"}">${v.ok ? "Verified: nobody can change this fund or block its exit." : "Not verified: see the failed checks above."}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="verdict bad">Could not read ${esc(id)}: ${esc((e as Error).message)}</div>`;
  }
}
$("#verify-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void runVerify();
});

// ------------------------------------------------------------ timeline
$("#run-sub").innerHTML = `Recorded ${esc(R.started_at.slice(0, 10))} on NEAR testnet. Every step links to its transaction. 1Click has no testnet, so a test signer and a solver account (${esc(R.accounts.solver)}) stand in for it.`;
const T: [string, string, string, string?][] = [
  ["create_fund_keyless", "Fund created with no keys", `${R.access_keys_after_create} access keys from the first block.`],
  ["alice_subscribe", "Alice subscribes", "60 pUSD → 60,000,000 shares."],
  ["bob_subscribe", "Bob subscribes", "40 pUSD → 40,000,000 shares."],
  ["refused_wrong_recipient", "Refused: quote pays the operator", humanReason(R.rejections[0]?.reason ?? ""), "no"],
  ["refused_too_large", "Refused: 30% in one trade", humanReason(R.rejections[1]?.reason ?? ""), "no"],
  ["propose_trade", "Accepted: 10 pUSD → wNEAR", "Signature, recipients, size, cost and freshness all within the mandate; the contract sent the input itself.", "yes"],
  ["solver_delivers", "Output delivered", `${wnear("20000000000000000000000")} wNEAR to the fund.`],
  ["settle", "Settled by anyone", `Status ${R.settle_status}.`, "yes"],
  ["bob_redeem", "Bob exits in kind", `${pusd(R.bob_received.pusd)} pUSD + ${wnear(R.bob_received.wnear)} wNEAR, exactly 40% of each.`, "yes"],
];
$("#timeline").innerHTML = T.map(([k, h, p, c]) => `<li class="${c ?? ""}"><div class="tl-h"><b>${esc(h)}</b>${c ? `<span class="tag ${c}">${c === "no" ? "refused" : "ok"}</span>` : ""}${tx(k)}</div><p>${esc(p)}</p></li>`).join("");

// ------------------------------------------------------------ refusals
$("#refusal-cards").innerHTML = R.rejections
  .map((r: any, i: number) => `<div class="card"><span class="tag no">refused</span><h3>${esc(humanReason(r.reason))}</h3><p>Recorded in the contract's own refusal log. ${tx(i === 0 ? "refused_wrong_recipient" : "refused_too_large")}</p></div>`)
  .join("");

// ------------------------------------------------------------ live funds + wallet
void mountApp([
  { id: (openFund as any).fund, title: "Open fund", blurb: "Anyone can join with test pUSD until 21 November and exit at any time. Can stake idle wNEAR into stNEAR; 1%/yr fee in shares." },
  { id: R.fund, title: "Demo fund", blurb: "The fund from the recorded run; the AI operator trades it." },
  { id: (earnRun as any).fund, title: "Earning fund", blurb: "Stakes idle wNEAR into Meta Pool stNEAR at par; the operator is paid 1%/yr in new shares, no price feed." },
]);

mountAgent(agentRun);
mountQuorum(quorumRun);
