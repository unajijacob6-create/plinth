// The app: every fund, live from the chain, with the wallet actions.
import { mountShell } from "./shell.ts";
import "./app.css";
import { mountApp } from "./app.ts";
import { isAccountId, factoryTotals } from "./chain.ts";
import run from "../../data/testnet-run.json";
import openFund from "../../data/open-fund.json";
import earnRun from "../../data/earn-run.json";

mountShell("app", false);
const R: any = run;
/**
 * The four funds from before release 0.3, kept as history (README and the Security page list the same
 * four). Funds in the data files that turn out to be old join them.
 */
const LEGACY_IDS: string[] = [(openFund as any).previous?.fund, "open.plinthfund.testnet", "fund-mwa9jwo8.plinthfund.testnet", "earn-mwad1ypv.plinthfund.testnet"].filter((x, i, a): x is string => typeof x === "string" && x.length > 0 && a.indexOf(x) === i);
const raw = new URLSearchParams(location.search).get("fund")?.trim().toLowerCase() ?? "";
const linked = isAccountId(raw) ? raw : null;

// The live numbers: the same function and the same scope as on Home, read independently of the
// cards, so one slow card never holds them up. If the chain cannot be read they say so, never "0".
const summary = document.getElementById("dash-summary");
if (summary)
  factoryTotals("testnet").then(
    (t) => {
      const cells: [number, string][] = [
        [t.funds, t.funds === 1 ? "fund created through the factory" : "funds created through the factory"],
        [t.keys, "access keys across those funds"],
        [t.trades, t.trades === 1 ? "trade sent by those funds" : "trades sent by those funds"],
        [t.refusals, t.refusals === 1 ? "proposal refused by those funds" : "proposals refused by those funds"],
      ];
      summary.innerHTML = cells.map(([n, l]) => `<div><dt>${l}</dt><dd>${n.toLocaleString("en")}</dd></div>`).join("");
      summary.setAttribute("aria-busy", "false");
      summary.dataset.scope = t.read < t.funds ? `newest ${t.read}` : "all";
    },
    () => {
      summary.innerHTML = `<p class="sum-fail">These numbers could not be read from NEAR testnet just now. The funds below are read one by one.</p>`;
      summary.setAttribute("aria-busy", "false");
      summary.classList.add("failed");
    },
  );

void mountApp({
  known: [
    { id: (openFund as any).fund, title: "Open fund", blurb: "Anyone can join with test pUSD while its window is open, and leave at any time." },
    { id: R.fund, title: "Demo fund", blurb: "The fund from the recorded run; the AI manager traded it." },
    { id: (earnRun as any).fund, title: "Earning fund", blurb: "Stakes idle wNEAR into Meta Pool stNEAR; the manager is paid in new shares." },
  ],
  legacy: LEGACY_IDS.map((id) => ({ id, title: id.split(".")[0], blurb: "A fund from before release 0.3, kept as history." })),
  linked,
});
