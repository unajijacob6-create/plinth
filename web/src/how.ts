import { mountShell } from "./shell.ts";
import "./app.css";
import run from "../../data/testnet-run.json";
import { explorer, accountLink, shortAccount, RELEASES } from "./chain.ts";
import { humanReason } from "./app.ts";
import { fmt, units, dec } from "./tokens.ts";
import agentRun from "../../data/agent-run.json";
import quorumRun from "../../data/quorum-run.json";
import { mountAgent, mountQuorum } from "./agent.ts";

mountShell("how", true);
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const R: any = run;
const tx = (k: string) => (R.tx[k] ? `<a href="${explorer("testnet", R.tx[k])}" target="_blank" rel="noopener">View transaction ↗</a>` : "");
const TOK: string = R.accounts.token;
const WRAP: string = R.accounts.wrap;
// A fund made by the factory reports its code under global_contract_hash; older ones under code_hash.
const runRel = RELEASES[R.global_contract_hash ?? ""] ?? RELEASES[R.code_hash];
const runRelease = runRel?.version ?? "an unlisted release";
const runKnown = !!runRel?.known_issue;

// ------------------------------------------------------------ lifecycle
const proofHead = `Recorded on testnet, release ${esc(runRelease)}`;
const steps = [
  {
    t: "Launch keyless",
    body: `<p>One call to the factory creates the fund account, points it at the one published copy of the code and sets the rules. No key is ever added, so the account has no key from its first block.</p><ul><li>Allowed tokens, trade size, cost cap, time between trades</li><li>The only manager, and the 1Click signing key</li></ul>`,
    proof: `Fund <a href="${accountLink("testnet", R.fund)}" target="_blank" rel="noopener">${esc(shortAccount(R.fund))}</a><br/>Created in ${tx("create_fund_keyless")}<br/>Access keys after creation: <b>${esc(R.access_keys_after_create)}</b>${runKnown ? `<br/><span class="muted">This run created the fund directly, before the factory existed.</span>` : R.created?.relay ? `<br/>Refund account <a href="${accountLink("testnet", R.created.relay)}" target="_blank" rel="noopener">${esc(shortAccount(R.created.relay))}</a>, created with it` : ""}`,
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
    body: `<p>The contract verifies 1Click's signature over the quote, then the rules:</p><ul><li>output goes to the fund and refunds to the fund's own refund account, nowhere else</li><li>both tokens allowed; size within the limit; all-in cost within the cap, from the signed dollar values</li><li>quote fresh, deposit address open long enough and never used before</li></ul>`,
    proof: `Refused: output to the manager ${tx("refused_wrong_recipient")}<br/>Refused: 30% in one trade ${tx("refused_too_large")}`,
  },
  {
    t: "Send and settle",
    body: `<p>The contract registers the 1Click deposit address on the token and transfers the input in one step. 1Click hands the output to the fund, which settles the trade on the spot.</p><p>If the trade fails, 1Click's refund goes to the fund's refund account: a second keyless account that holds nothing else and can only pass tokens on to its fund. Anyone can press the button that hands it over.</p><p>The fund counts a token only when it is handed it. It reads no balance anywhere.</p>`,
    proof: runKnown
      ? `Deposit address received ${esc(fmt(TOK, R.deposit_address_pusd))}<br/>Delivered ${tx("solver_delivers")}<br/>Settled ${tx("settle")}<br/><span class="muted">In this older run the trade was settled by a separate call that read the fund's balance. Release 0.3 removed that step; it is where the known issue was.</span>`
      : `Deposit address received ${esc(fmt(TOK, R.deposit_address_pusd))}<br/>Delivered and settled in one step ${tx("solver_delivers")}${R.tx.refund_sent_to_relay ? `<br/>A refund reached the refund account ${tx("refund_sent_to_relay")}<br/>and was handed to the fund ${tx("relay_forward")}` : ""}`,
  },
  {
    t: "Exit in kind",
    body: `<p>Any holder burns shares, all or some, and receives the same fraction of every token the fund holds. No price, no price feed, no manager. If a transfer fails, the amount stays owed and can be claimed later.</p>`,
    proof: `Bob exited with his 40 shares ${tx("bob_redeem")}<br/>received ${esc(fmt(TOK, R.bob_received.pusd))} + ${esc(fmt(WRAP, R.bob_received.wnear))}`,
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

// ------------------------------------------------------------ timeline
$("#run-sub").innerHTML = `Recorded ${esc(R.started_at.slice(0, 10))} on NEAR testnet, on release ${esc(runRelease)}${runKnown ? `, which has the known issue described under <a href="${import.meta.env.BASE_URL}security/#limit-known">Security page</a>` : ""}. Every step links to its transaction. 1Click has no testnet, so a test signer and a solver account (${esc(shortAccount(R.accounts.solver))}) stand in for it.`;
const T: [string, string, string, string?][] = [
  ["create_fund_keyless", "Fund created with no keys", `${R.access_keys_after_create} access keys from the first block.`],
  ["alice_subscribe", "Alice joins", `${fmt(TOK, "60000000")} for 60 shares.`],
  ["bob_subscribe", "Bob joins", `${fmt(TOK, "40000000")} for 40 shares.`],
  ["refused_wrong_recipient", "Refused: quote pays the manager", humanReason(R.rejections[0]?.reason ?? ""), "no"],
  ["refused_too_large", "Refused: 30% in one trade", humanReason(R.rejections[1]?.reason ?? ""), "no"],
  ["propose_trade", `Accepted: ${fmt(TOK, R.deposit_address_pusd)} for wNEAR`, "Signature, recipients, size, cost and freshness all within the rules; the contract sent the input itself.", "yes"],
  ["solver_delivers", runKnown ? "Output delivered" : "Output delivered and settled on the spot", `${fmt(WRAP, R.settled_trade?.received_out ?? "20000000000000000000000")} to the fund.`, runKnown ? undefined : "yes"],
  ...(runKnown ? [["settle", "Settled by a separate call", "How releases 0.1 and 0.2 closed a trade. Release 0.3 settles when the output arrives.", "yes"] as [string, string, string, string?]] : []),
  ...(R.tx.carol_join_in_kind && R.join_in_kind ? [["carol_join_in_kind", "Carol joins in kind", `After the window: she added ${fmt(TOK, R.join_in_kind.basket[0])} + ${fmt(WRAP, R.join_in_kind.basket[1])}, the fund's own proportions, and received ${units(R.join_in_kind.shares_minted, dec(TOK), 6)} shares. No price was used.`, "yes"] as [string, string, string, string?]] : []),
  ...(R.tx.refund_sent_to_relay && R.refund ? [["refund_sent_to_relay", "A refund arrives at the refund account", `1Click's stand-in refunded a second trade: ${fmt(TOK, R.refund.amount)} after its fee. The fund did not see it land; its refund account did.`], ["relay_forward", "Handed to the fund", `${shortAccount(R.refund.forwarded_by)} pressed the button. The fund counted the ${fmt(TOK, R.refund.amount)} when it was handed over.`, "yes"]] as [string, string, string, string?][] : []),
  ["bob_redeem", "Bob exits in kind", `${fmt(TOK, R.bob_received.pusd)} + ${fmt(WRAP, R.bob_received.wnear)}: his 40 shares' slice of each token the fund held at that moment.`, "yes"],
];
$("#timeline").innerHTML = T.map(([k, h, p, c]) => `<li class="${c ?? ""}"><div class="tl-h"><b>${esc(h)}</b>${c ? `<span class="tag ${c}">${c === "no" ? "refused" : "ok"}</span>` : ""}${tx(k)}</div><p>${esc(p)}</p></li>`).join("");

// ------------------------------------------------------------ refusals
$("#refusal-cards").innerHTML = R.rejections
  .map((r: any, i: number) => `<div class="card"><span class="tag no">refused</span><h3>${esc(humanReason(r.reason))}</h3><p>Recorded in the contract's own refusal log. ${tx(i === 0 ? "refused_wrong_recipient" : "refused_too_large")}</p></div>`)
  .join("");

mountAgent(agentRun);
mountQuorum(quorumRun);
