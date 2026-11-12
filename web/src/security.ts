// Security: the known issue, what release 0.3 changed, what the chain proves and what is still trusted.
import { mountShell } from "./shell.ts";
import "./app.css";
import { explorer } from "./chain.ts";
import run from "../../data/testnet-run.json";

mountShell("security", true);
const R: any = run;
// The replay of the old trick against release 0.3, when the recorded run includes it.
const replay = document.getElementById("replay");
const tx = R.tx?.attack_bounce_wnear_in_flight;
if (replay && tx && R.attack?.holdings_unchanged)
  replay.innerHTML = `On testnet we replayed the same trick against a release 0.3 fund while a trade was in flight: the fund kept nothing it did not own, and its holdings did not move. <a href="${explorer("testnet", tx)}" target="_blank" rel="noopener">See the transaction ↗</a>`;
else replay?.remove();
