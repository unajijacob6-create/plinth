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
const proofs: { tag: string; tone: string; title: string; text: string; story: [string, string]; tx?: string }[] = [
  {
    tag: "Refused on chain",
    tone: "no",
    title: "A hijacked manager could not take the fund.",
    text: "We replaced the manager's software and had it send a trade that paid an attacker. The contract refused it, and the refusal is recorded on chain.",
    story: ["how/#agent", "Read the story"],
    tx: hijacked?.accepted === false ? hijacked.tx : undefined,
  },
  {
    tag: "Two AIs must agree",
    tone: "note",
    title: "One AI was fooled. The other held.",
    text: "A hidden instruction told two AI models to send the fund to an attacker. One went along, one refused, so nothing was proposed. Both answers are signed, and your browser checks the signatures.",
    story: ["how/#quorum", "See both answers"],
  },
  {
    tag: "Found and fixed",
    tone: "warn",
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
        <p class="proof-tag ${p.tone}">${esc(p.tag)}</p>
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
