import { mountShell } from "./shell.ts";
import "./app.css";
import run from "../../data/testnet-run.json";
import { explorer, accountLink, shortAccount, RELEASES } from "./chain.ts";
import { humanReason } from "./app.ts";
import { fmt, units, dec } from "./tokens.ts";
import agentRun from "../../data/agent-run.json";
import quorumRun from "../../data/quorum-run.json";
import { mountAgent, mountQuorum } from "./agent.ts";
import { mountCarousel } from "./carousel.ts";

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
const proofHead = `Recorded on NEAR testnet · release ${esc(runRelease)}`;
const link = (id: string) => `<a href="${accountLink("testnet", id)}" target="_blank" rel="noopener">${esc(shortAccount(id))}</a>`;
type Row = [string, string];
const steps: { t: string; op?: boolean; body: string; rows: Row[]; note?: string }[] = [
  {
    t: "Launch keyless",
    body: `<p>One call to the factory creates the fund account, points it at the one published copy of the code and sets the rules. No key is ever added, so the account has no key from its first block.</p><ul><li>Allowed tokens, trade size, cost cap, time between trades</li><li>The only manager, and the 1Click signing key</li></ul>`,
    rows: [
      ["Fund", link(R.fund)],
      ["Created", tx("create_fund_keyless")],
      ["Access keys after creation", `<b>${esc(R.access_keys_after_create)}</b>`],
      ...(R.created?.relay && !runKnown ? ([["Refund account", `${link(R.created.relay)}, created with it`]] as Row[]) : []),
    ],
    note: runKnown ? "This run created the fund directly, before the factory existed." : undefined,
  },
  {
    t: "Join",
    body: `<p>During the join window, depositors send the fund its base token and get one share per token. Trading starts only after the window closes, so shares are priced without a price feed.</p><p>After the window, funds that allow it take new joiners in kind: you add every token the fund holds, in the fund's own proportions, and receive shares. No price is involved either way.</p>`,
    rows: [
      ["Alice joined with", `<b>${esc(fmt(TOK, "60000000"))}</b> · ${tx("alice_subscribe")}`],
      ["Bob joined with", `<b>${esc(fmt(TOK, "40000000"))}</b> · ${tx("bob_subscribe")}`],
    ],
  },
  {
    t: "Propose",
    op: true,
    body: `<p>The manager, a person or an AI agent, hands the contract a live 1Click quote. That is all it can do. It cannot withdraw, pause or change the rules.</p><p>A fund can also be launched with no manager. Then anyone can ask a fixed program for a proposal, and it goes through the same checks.</p>`,
    rows: [
      ["Manager", `<b>${esc(shortAccount(R.accounts.operator))}</b>`],
      ["Accepted proposal", tx("propose_trade")],
    ],
  },
  {
    t: "Contract checks",
    body: `<p>The contract verifies 1Click's signature over the quote, then the rules:</p><ul><li>output goes to the fund and refunds to the fund's own refund account, nowhere else</li><li>both tokens allowed; size within the limit; all-in cost within the cap, from the signed dollar values</li><li>quote fresh, deposit address open long enough and never used before</li></ul>`,
    rows: [
      ["Refused: output to the manager", tx("refused_wrong_recipient")],
      ["Refused: 30% in one trade", tx("refused_too_large")],
    ],
  },
  {
    t: "Send and settle",
    body: `<p>The contract registers the 1Click deposit address on the token and transfers the input in one step. 1Click hands the output to the fund, which settles the trade on the spot.</p><p>If the trade fails, 1Click's refund goes to the fund's refund account: a second keyless account that holds nothing else and can only pass tokens on to its fund. Anyone can press the button that hands it over.</p><p>The fund counts a token only when it is handed it. It reads no balance anywhere.</p>`,
    rows: runKnown
      ? [
          ["Deposit address received", `<b>${esc(fmt(TOK, R.deposit_address_pusd))}</b>`],
          ["Delivered", tx("solver_delivers")],
          ["Settled", tx("settle")],
        ]
      : [
          ["Deposit address received", `<b>${esc(fmt(TOK, R.deposit_address_pusd))}</b>`],
          ["Delivered and settled", tx("solver_delivers")],
          ...(R.tx.refund_sent_to_relay
            ? ([
                ["Refund reached the refund account", tx("refund_sent_to_relay")],
                ["Handed to the fund", tx("relay_forward")],
              ] as Row[])
            : []),
        ],
    note: runKnown ? "In this older run the trade was settled by a separate call that read the fund's balance. Release 0.3 removed that step; it is where the known issue was." : undefined,
  },
  {
    t: "Exit in kind",
    body: `<p>Any holder burns shares, all or some, and receives the same fraction of every token the fund holds. No price, no price feed, no manager. If a transfer fails, the amount stays owed and can be claimed later.</p>`,
    rows: [
      ["Bob exited with", `<b>40 shares</b> · ${tx("bob_redeem")}`],
      ["He received", `<b>${esc(fmt(TOK, R.bob_received.pusd))} + ${esc(fmt(WRAP, R.bob_received.wnear))}</b>`],
    ],
  },
];
const stepsEl = $(".steps");
stepsEl.innerHTML = steps
  .map((s, i) => `<button role="tab" id="tab-${i}" aria-controls="step-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span class="n">0${i + 1}</span><span class="st">${s.t}</span>${s.op ? `<span class="op-tag">The manager's only step</span>` : ""}</button>`)
  .join("");
const show = (i: number) => {
  stepsEl.querySelectorAll("button").forEach((b, j) => {
    b.setAttribute("aria-selected", String(j === i));
    b.tabIndex = j === i ? 0 : -1;
  });
  const s = steps[i];
  const panel = $("#step-panel");
  panel.innerHTML = `<div class="sp-text"><p class="sp-n">Step ${i + 1} of ${steps.length}</p><h3>${s.t}</h3>${s.body}</div>
    <div class="proof"><p class="proof-h">${proofHead}</p><dl class="proof-rows">${s.rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${s.note ? `<p class="proof-note">${esc(s.note)}</p>` : ""}</div>`;
  panel.setAttribute("aria-labelledby", `tab-${i}`);
  panel.classList.remove("swap");
  void panel.offsetWidth;
  panel.classList.add("swap");
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
$("#timeline").innerHTML = T.map(([k, h, p, c]) => `<li class="${c ?? ""}"><div class="tl-h"><b>${esc(h)}</b>${c === "no" ? `<span class="tl-state">Refused</span>` : ""}</div><p>${esc(p)}</p><p class="tl-link">${tx(k)}</p></li>`).join("");

// ------------------------------------------------------------ refusals
$("#refusal-cards").innerHTML = R.rejections
  .map((r: any, i: number) => `<div class="card refusal"><p class="outcome no"><span class="oc-ic" aria-hidden="true"></span><span><b>Refused on chain</b></span></p><h3>${esc(humanReason(r.reason))}</h3><p>Recorded in the contract's own refusal log.</p><p class="case-links">${tx(i === 0 ? "refused_wrong_recipient" : "refused_too_large")}</p></div>`)
  .join("");

mountAgent(agentRun);
mountQuorum(quorumRun);
mountCarousel(document.getElementById("agent-cases"), "AI manager cases");
mountCarousel(document.getElementById("quorum-cases"), "Two-model cases");
