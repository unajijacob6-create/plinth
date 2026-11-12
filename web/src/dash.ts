// The app: every fund, live from the chain, with the wallet actions.
import { mountShell } from "./shell.ts";
import "./app.css";
import { mountApp, type Stats } from "./app.ts";
import { isAccountId } from "./chain.ts";
import run from "../../data/testnet-run.json";
import openFund from "../../data/open-fund.json";
import earnRun from "../../data/earn-run.json";

mountShell("app", false);
const R: any = run;
/** Funds from before release 0.3, kept as history. Those in the data files that turn out to be old join them. */
const LEGACY_IDS: string[] = [(openFund as any).previous?.fund, "fund-mwa9jwo8.plinthfund.testnet", "earn-mwad1ypv.plinthfund.testnet"].filter((x): x is string => typeof x === "string" && x.length > 0);
const raw = new URLSearchParams(location.search).get("fund")?.trim().toLowerCase() ?? "";
const linked = isAccountId(raw) ? raw : null;

const summary = document.getElementById("dash-summary");
void mountApp({
  known: [
    { id: (openFund as any).fund, title: "Open fund", blurb: "Anyone can join with test pUSD while its window is open, and leave at any time." },
    { id: R.fund, title: "Demo fund", blurb: "The fund from the recorded run; the AI manager traded it." },
    { id: (earnRun as any).fund, title: "Earning fund", blurb: "Stakes idle wNEAR into Meta Pool stNEAR; the manager is paid in new shares." },
  ],
  legacy: LEGACY_IDS.map((id) => ({ id, title: id.split(".")[0], blurb: "A fund from before release 0.3, kept as history." })),
  linked,
  onStats: (s: Stats) => {
    if (!summary) return;
    const cells: [number | string, string][] = [
      [s.factoryCount ?? s.listed, s.factoryCount !== null ? "funds created through the factory" : "funds listed"],
      [s.keys, "access keys across the funds listed"],
      [s.trades, "trades sent"],
      [s.refusals, "proposals refused"],
    ];
    summary.innerHTML = cells.map(([n, l]) => `<div><b>${Number(n).toLocaleString("en")}</b><span>${l}</span></div>`).join("");
    summary.setAttribute("aria-busy", "false");
  },
});
