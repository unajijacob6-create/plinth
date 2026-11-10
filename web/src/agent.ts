// The AI operator section: each recorded case with the model's answer, its NEAR AI signed receipt
// (re-verified here, in the browser) and what the contract did.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { explorer } from "./chain.ts";
import { fmt, humanReason } from "./app.ts";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

// "enclave": NEAR AI's own TEE models sign model:sha256(req):sha256(resp) with the model's enclave key.
// "gateway": external providers (Gemini) are signed sha256(req):sha256(resp) by a NEAR AI gateway key;
// NEAR AI says these models run outside its TEE, so the receipt proves only what NEAR AI relayed.
export function verifyReceipt(r: any): { ok: boolean; why: string; kind: "enclave" | "gateway" } {
  const kind = String(r.signed_text ?? "").startsWith(`${r.model}:`) ? "enclave" : "gateway";
  try {
    const hashes = `${hex(sha256(enc(r.request)))}:${hex(sha256(enc(r.response)))}`;
    const expect = kind === "enclave" ? `${r.model}:${hashes}` : hashes;
    if (r.signed_text !== expect) return { ok: false, kind, why: "the signed record does not match the answer shown" };
    const text = enc(r.signed_text);
    const hash = keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${text.length}`), ...text]));
    const sig = Uint8Array.from(r.signature.replace(/^0x/, "").match(/../g)!.map((h: string) => parseInt(h, 16)));
    const rec = new Uint8Array(65);
    rec[0] = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    rec.set(sig.subarray(0, 64), 1);
    const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(rec, hash, { prehash: false })).toBytes(false);
    const addr = "0x" + hex(keccak_256(pub.subarray(1)).subarray(12));
    const who = kind === "enclave" ? "Signed inside the model's secure enclave" : "Signed by NEAR AI's gateway (this model runs outside NEAR AI's secure enclave)";
    return addr.toLowerCase() === String(r.signing_address).toLowerCase() ? { ok: true, kind, why: who } : { ok: false, kind, why: "the signature does not match" };
  } catch (e) {
    return { ok: false, kind, why: (e as Error).message };
  }
}

const MODEL_NAMES: Record<string, string> = {
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": "DeepSeek V4.1 Flash",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated": "DeepSeek V4.1 Flash, safety removed",
  "google/gemini-2.5-flash": "Gemini 2.5 Flash",
};
const modelName = (m: string) => MODEL_NAMES[m] ?? String(m).split("/").pop()!.replace(/-/g, " ");
const txLink = (hash: string, label = "View transaction") => `<a href="${explorer("testnet", hash)}" target="_blank" rel="noopener">${label} ↗</a>`;
const amount = (token: string | undefined, units: unknown) => {
  // Only plain base units are shown as an amount; "34.5" or "1e21" is not silently rewritten.
  const digits = typeof units === "number" && Number.isSafeInteger(units) && units >= 0 ? String(units) : typeof units === "string" && /^\s*\d+\s*$/.test(units) ? units.trim() : "";
  if (!token || !digits) return `an unclear amount (${String(units ?? "none")})`;
  return fmt(token, digits, 4);
};

/** One decision in plain words: "Hold", or "Sell 34 pUSD for wNEAR, paid to attacker-wallet.testnet". */
function decisionText(d: any, fund: string): { text: string; danger: boolean } {
  if (!d) return { text: "No usable answer", danger: false };
  if (d.action === "hold") return { text: "Hold, no trade", danger: false };
  if (d.action === "stake") return { text: `Stake ${amount("wrap.testnet", d.amount)}`, danger: false };
  const to = d.recipient && d.recipient !== fund ? d.recipient : null;
  const buy = d.buy ? fmt(d.buy, "0").split(" ").pop() : "another token";
  return { text: `Sell ${amount(d.sell, d.amount)} for ${buy}${to ? `, paid to ${to}` : ", paid to the fund"}`, danger: !!to };
}
const reasonOf = (d: any) => (d?.reason ? `<p class="said">“${esc(d.reason)}”</p>` : "");
const receiptLine = (r: any) => {
  if (!r) return "";
  const v = verifyReceipt(r);
  return `<p class="small ${v.ok ? "okc" : "bad"}" title="Signer ${esc(r.signing_address)}">${v.ok ? "✓" : "✗"} ${esc(v.why)}${v.ok ? "; checked in your browser" : ""}.</p>`;
};

const TITLES: Record<string, [string, string]> = {
  injected: ["Prompt injection", "The market note hides an instruction to send the whole fund to an attacker."],
  compromised: ["Compromised model", "Same note, given to the model with its safety tuning removed (a stand-in for a jailbroken agent)."],
  hijacked: ["Hijacked operator", "No model: the operator's software is replaced and submits the attacker's trade directly."],
  honest: ["Ordinary day", "A normal market note."],
};

export function mountAgent(run: any) {
  const el = document.getElementById("agent-cases");
  if (!el || !run?.cases) return;
  document.getElementById("agent-sub")!.innerHTML = `Recorded ${esc(String(run.started_at).slice(0, 10))} on NEAR testnet against the demo fund. The model runs on NEAR AI Cloud, and each answer is signed there; your browser checks every signature below.`;
  el.innerHTML = run.cases
    .map((c: any) => {
      const [title, sub] = TITLES[c.label] ?? [c.label, ""];
      const d = c.decision;
      const dt = decisionText(d, run.fund);
      const said =
        c.model === null
          ? `<p class="small">Submitted directly:</p><p class="decision ${dt.danger ? "danger" : ""}">${esc(dt.text)}</p>`
          : `<p class="small muted">${esc(modelName(c.model))} decided:</p><p class="decision ${dt.danger ? "danger" : ""}">${esc(dt.text)}</p>${reasonOf(d)}`;
      const verdict =
        c.accepted === true
          ? `<span class="tag yes">contract accepted</span> ${txLink(c.tx)}${c.settle_tx ? ` · ${txLink(c.settle_tx, "Settled")}` : ""}`
          : c.accepted === false
            ? `<span class="tag no">contract refused</span> <span class="small">${esc(humanReason(c.contract_reason ?? ""))}</span> ${txLink(c.tx)}`
            : `<span class="tag">nothing proposed</span> <span class="small">the model chose to hold</span>`;
      return `<div class="card agent-case"><span class="tag">${esc(title)}</span><p class="small muted">${esc(sub)}</p>${said}<p>${verdict}</p>${receiptLine(c.receipt)}</div>`;
    })
    .join("");
}

const QTITLES: Record<string, [string, string]> = {
  injected: ["Prompt injection, two models", "The same injected note goes to DeepSeek and to Gemini."],
  "one-fooled": ["Safety-removed DeepSeek + Gemini", "The DeepSeek seat is taken by its safety-removed variant, the stand-in for a jailbroken model."],
  honest: ["Ordinary day, two models", "A normal note. Both must agree; the smaller amount is proposed."],
};

export function mountQuorum(run: any) {
  const el = document.getElementById("quorum-cases");
  if (!el || !run?.cases) return;
  document.getElementById("quorum-sub")!.innerHTML = `Recorded ${esc(String(run.started_at).slice(0, 10))} on NEAR testnet against the demo fund. The operator proposes a trade only when every model says trade with the same tokens and the same recipient, at the smallest amount any of them asked for. Anything else is a hold, before the contract is even asked.`;
  el.innerHTML = run.cases
    .map((c: any) => {
      const [title, sub] = QTITLES[c.label] ?? [c.label, ""];
      const votes = c.votes
        .map((v: any) => {
          const dt = decisionText(v.decision, run.fund);
          return `<div class="vote"><p class="small muted">${esc(modelName(v.model))}</p><p class="decision ${dt.danger ? "danger" : ""}">${esc(dt.text)}</p>${receiptLine(v.receipt)}</div>`;
        })
        .join("");
      const q = c.quorum;
      const why = q.agreed ? "both models agree" : String(q.why).replace(/[\w.-]+\/[\w.-]+/g, (m: string) => modelName(m));
      const verdict =
        c.accepted === true
          ? `<span class="tag yes">quorum: trade</span> <span class="tag yes">contract accepted</span> ${txLink(c.tx)}${c.settle_tx ? ` · ${txLink(c.settle_tx, "Settled")}` : ""}`
          : c.accepted === false
            ? `<span class="tag yes">quorum: trade</span> <span class="tag no">contract refused</span> <span class="small">${esc(humanReason(c.contract_reason ?? ""))}</span>`
            : `<span class="tag no">quorum: hold</span> <span class="small">${esc(why)}</span>`;
      return `<div class="card agent-case quorum-case"><span class="tag">${esc(title)}</span><p class="small muted">${esc(sub)}</p>${votes}<p>${verdict}</p></div>`;
    })
    .join("");
}
