import { mountShell } from "./shell.ts";
import "./app.css";
import run from "../../data/testnet-run.json";
import { verifyFund, factoryOf, factoryFunds, isAccountId, shortAccount, type Net } from "./chain.ts";
import { fmt, loadMeta, units, dec } from "./tokens.ts";

mountShell("verify", true);
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const R: any = run;

// ------------------------------------------------------------ verifier
const input = $<HTMLInputElement>("#fund-id");
const net = $<HTMLSelectElement>("#fund-net");
const out = $("#verify-out");
const linkedRaw = new URLSearchParams(location.search).get("fund")?.trim().toLowerCase() ?? "";
const linked = isAccountId(linkedRaw) ? linkedRaw : null;
let userTyped = false;
input.addEventListener("input", () => (userTyped = true));
input.value = linked ?? R.fund;
out.innerHTML = `<span class="muted">Enter a fund account and press Verify. ${linked ? "Prefilled with the fund from your link." : "Prefilled with the fund from the recorded run."}</span>`;
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
    const tag = v.status === "known-issue" ? `<p class="known-tag"><b>Known issue: old release.</b> Release ${esc(v.release?.version ?? "")} can count tokens that bounce back as the fund's own. <a href="${import.meta.env.BASE_URL}security/#limit-known">Read about the bug</a></p>` : "";
    const verdict =
      v.status === "clean"
        ? `<div class="verdict ok">Verified: no keys, published code that nobody can change, a listed release with no known issue, and rules that add up.</div>`
        : v.status === "test-signer"
          ? `<div class="verdict note">Keys, code and rules check out. Quotes are signed by a test signer chosen by the fund's creator, not by NEAR Intents: a testnet stand-in only.</div>`
          : v.status === "known-issue"
            ? `<div class="verdict warn">Keys and code check out, but this release has a known accounting bug. Treat this fund as history, not as safe.${v.standIn ? " Its quotes are signed by a test signer, a testnet stand-in." : ""}</div>`
          : `<div class="verdict bad">Not verified: see the failed checks above.</div>`;
    const relayFor = v.relayFor ? `<p class="relay-hint">This is the refund account of <b>${esc(shortAccount(v.relayFor))}</b>. <a href="?fund=${encodeURIComponent(v.relayFor)}">Verify that fund</a></p>` : "";
    out.innerHTML = lines + kv + tag + relayFor + verdict;
  } catch (e) {
    if (seq !== verifySeq) return;
    out.innerHTML = `<div class="verdict bad">Could not read ${esc(shortAccount(id))}: ${esc((e as Error).message)}.</div>`;
  }
}
$("#verify-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void runVerify();
});

// The newest fund from the factory is the better default than the recorded one.
const factory = factoryOf("testnet");
if (factory && !linked)
  void factoryFunds("testnet", factory, 0, 1).then(
    ({ funds }) => {
      if (funds[0] && !userTyped) {
        input.value = funds[0].account_id;
        out.innerHTML = `<span class="muted">Enter a fund account and press Verify. Prefilled with the newest fund from the factory.</span>`;
      }
    },
    () => {},
  );
if (linked) void runVerify();
