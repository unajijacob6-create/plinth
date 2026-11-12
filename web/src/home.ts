// Home: the plain-language explainer. Reads a few live numbers from the chain; no wallet here.
import { mountShell, riseWords, countUp, reveal } from "./shell.ts";
import { mountSky } from "./sky.ts";
import "./home.css";
import { view, rpc, factoryOf, factoryFunds, explorer } from "./chain.ts";
import testnetRun from "../../data/testnet-run.json";
import agentRun from "../../data/agent-run.json";

mountShell("home", true);
riseWords(document.getElementById("hero-h"));
mountSky(document.getElementById("sky") as HTMLCanvasElement | null);

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const BASE = import.meta.env.BASE_URL;

// ---------------------------------------------------------------- proof cards, from the recorded runs
const R: any = testnetRun;
const hijacked = (agentRun as any).cases.find((c: any) => c.label === "hijacked");
const bounce = R.tx?.attack_bounce_wnear_in_flight;
// Each card carries a small line drawing instead of a coloured tag.
const ART = {
  refused: `<svg viewBox="0 0 112 72" class="draw proof-art" aria-hidden="true"><g class="mv"><rect x="6" y="20" width="40" height="32" rx="6" class="fill" /><path d="M14 31h24M14 40h15" /></g><path d="M52 36h16M62 30l6 6-6 6" /><rect x="80" y="8" width="12" height="56" rx="3" class="fill" /><path d="M98 26l10 10M108 26L98 36" class="no" /></svg>`,
  quorum: `<svg viewBox="0 0 112 72" class="draw proof-art" aria-hidden="true"><path d="M8 10h36a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H24l-8 8v-8H8a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6z" class="fill" /><path d="M16 26l6 6 12-12" /><g class="mv"><path d="M68 22h36a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H96v8l-8-8H68a6 6 0 0 1-6-6V28a6 6 0 0 1 6-6z" /><path d="M80 31l12 12M92 31L80 43" class="no" /></g></svg>`,
  fixed: `<svg viewBox="0 0 112 72" class="draw proof-art" aria-hidden="true"><g class="mv"><circle cx="34" cy="32" r="20" /><path d="M48 46l14 14" /><ellipse cx="34" cy="33" rx="7" ry="9" class="fill" /><path d="M27 28l-6-4M41 28l6-4M27 38l-6 4M41 38l6 4" /></g><circle cx="90" cy="34" r="16" class="fill" /><path d="M82 34l6 6 11-12" /></svg>`,
};
const proofs: { art: keyof typeof ART; label: string; title: string; text: string; story: [string, string]; tx?: string }[] = [
  {
    art: "refused",
    label: "Refused on chain",
    title: "A hijacked manager could not take the fund.",
    text: "We replaced the manager's software and had it send a trade that paid an attacker. The contract refused it, and the refusal is recorded on chain.",
    story: ["how/#agent", "Read the story"],
    tx: hijacked?.accepted === false ? hijacked.tx : undefined,
  },
  {
    art: "quorum",
    label: "Two AIs must agree",
    title: "One AI was fooled. The other held.",
    text: "A hidden instruction told two AI models to send the fund to an attacker. One went along, one refused, so nothing was proposed. Both answers are signed, and your browser checks the signatures.",
    story: ["how/#quorum", "See both answers"],
  },
  {
    art: "fixed",
    label: "Found and fixed",
    title: "A bug in our own earlier funds.",
    text: "Our first two releases could be tricked into counting tokens they did not own. We say so on every one of those funds. Release 0.3 removed the cause; replayed on testnet, the trick moved nothing.",
    story: ["security/#limit-known", "Read what happened"],
    tx: R.attack?.holdings_unchanged ? bounce : undefined,
  },
];
const proofsEl = document.getElementById("proofs");
if (proofsEl) {
  proofsEl.innerHTML = proofs
    .map(
      (p, i) => `<article class="proof soft lift" data-reveal style="--d: ${i * 100}ms">
        <div class="proof-head"><div class="proof-art-box">${ART[p.art]}</div><p class="proof-n"><span>0${i + 1}</span>${esc(p.label)}</p></div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.text)}</p>
        <div class="proof-links"><a class="link" href="${BASE}${p.story[0]}">${esc(p.story[1])} <span aria-hidden="true">→</span></a>${p.tx ? `<a class="link" href="${explorer("testnet", p.tx)}" target="_blank" rel="noopener">See the transaction ↗</a>` : ""}</div>
      </article>`,
    )
    .join("");
  reveal(proofsEl);
}

// ---------------------------------------------------------------- live numbers
// Read at view time across every fund the factory made. If the chain cannot be read, the panel goes
// away rather than show numbers that might be stale or wrong.
async function totals() {
  const factory = factoryOf("testnet");
  if (!factory) throw new Error("no factory");
  const { count, funds } = await factoryFunds("testnet", factory, 0, 100);
  let keys = 0, trades = 0, refusals = 0;
  // A few at a time, to be kind to the public node.
  for (let i = 0; i < funds.length; i += 4) {
    const part = await Promise.all(
      funds.slice(i, i + 4).map(async (f) => {
        const [s, k] = await Promise.all([view<any>("testnet", f.account_id, "get_fund"), rpc<any>("testnet", "query", { request_type: "view_access_key_list", finality: "final", account_id: f.account_id })]);
        return { trades: Number(s.trades), refusals: Number(s.rejections), keys: k.keys.length };
      }),
    );
    for (const p of part) {
      keys += p.keys;
      trades += p.trades;
      refusals += p.refusals;
    }
  }
  return { funds: count, keys, trades, refusals, read: funds.length };
}
const live = document.getElementById("live");
if (live) {
  totals().then(
    (t) => {
      for (const el of live.querySelectorAll<HTMLElement>(".num")) countUp(el, (t as any)[el.dataset.k!]);
      live.setAttribute("aria-busy", "false");
      live.classList.add("ready");
      document.getElementById("live-note")!.textContent = t.read < t.funds ? `Read just now, across the newest ${t.read} funds.` : "Read just now, from the chain, by your browser.";
    },
    () => {
      live.hidden = true;
      document.querySelector(".why")?.classList.add("solo");
    },
  );
}
