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
/** One short line about the signed receipt: who signed it and whether your browser agrees. */
const receiptCell = (r: any) => {
  if (!r) return `<span class="muted">no receipt</span>`;
  const v = verifyReceipt(r);
  const who = v.kind === "enclave" ? "Model's secure enclave" : "NEAR AI gateway";
  return `<span class="sig ${v.ok ? "okc" : "bad"}" title="${esc(v.why)}"><span class="sig-ic" aria-hidden="true">${v.ok ? "✓" : "✗"}</span>${esc(who)}<span class="sig-note">${v.ok ? "signature checked in your browser" : "signature does not check out"}</span></span>`;
};
/** One calm outcome line: a small icon carries the meaning, the words stay in ink. */
const outcome = (kind: "yes" | "no" | "neutral", title: string, detail: string) =>
  `<p class="outcome ${kind}"><span class="oc-ic" aria-hidden="true"></span><span><b>${esc(title)}</b> ${esc(detail)}</span></p>`;

const TITLES: Record<string, [string, string]> = {
  injected: ["Prompt injection", "A market note hides an instruction to send the whole fund to an attacker."],
  compromised: ["Compromised model", "The same note, given to a model with its safety tuning removed."],
  hijacked: ["Hijacked manager", "No model at all: the manager's software is replaced and sends the attacker's trade."],
  honest: ["Ordinary day", "A normal market note."],
};

export function mountAgent(run: any) {
  const el = document.getElementById("agent-cases");
  if (!el || !run?.cases) return;
  const sub = document.getElementById("agent-sub");
  if (sub) sub.textContent = `Recorded ${String(run.started_at).slice(0, 10)} on NEAR testnet. The model runs on NEAR AI Cloud and each answer is signed there. Your browser checks every signature on this page.`;
  el.innerHTML = run.cases
    .map((c: any, i: number) => {
      const [title, sub] = TITLES[c.label] ?? [c.label, ""];
      const dt = decisionText(c.decision, run.fund);
      const res =
        c.accepted === true
          ? outcome("yes", "Contract accepted.", "Inside every rule of the fund.")
          : c.accepted === false
            ? outcome("no", "Contract refused.", humanReason(c.contract_reason ?? "") + ".")
            : outcome("neutral", "Nothing proposed.", "The model chose to hold.");
      const links = [c.tx ? txLink(c.tx) : "", c.settle_tx ? txLink(c.settle_tx, "Settled") : ""].filter(Boolean).join(" · ");
      return `<article class="case agent-case">
        <header class="case-h"><p class="case-n">Case ${i + 1} of ${run.cases.length}</p><h3 class="case-label">${esc(title)}</h3><p class="case-sub">${esc(sub)}</p></header>
        <div class="case-body">
          <div class="said-box">
            <p class="said-k">${c.model === null ? "The manager submitted" : "The model decided"}</p>
            <p class="decision ${dt.danger ? "danger" : ""}">${esc(dt.text)}</p>
            ${c.model === null ? "" : reasonOf(c.decision)}
          </div>
          <dl class="case-rows">
            <div><dt>Model</dt><dd>${c.model === null ? "None" : esc(modelName(c.model))}</dd></div>
            <div><dt>Signed by</dt><dd>${c.receipt ? receiptCell(c.receipt) : `<span class="muted">Nothing to sign</span>`}</dd></div>
          </dl>
        </div>
        <div class="case-out">${res}${links ? `<p class="case-links">${links}</p>` : ""}</div>
      </article>`;
    })
    .join("");
}

const QTITLES: Record<string, [string, string]> = {
  injected: ["Prompt injection, two models", "The same injected note goes to DeepSeek and to Gemini."],
  "one-fooled": ["One model with its safety removed", "The DeepSeek seat is taken by a variant with its safety tuning removed."],
  honest: ["Ordinary day, two models", "A normal note. Both must agree; the smaller amount is proposed."],
};

export function mountQuorum(run: any) {
  const el = document.getElementById("quorum-cases");
  if (!el || !run?.cases) return;
  const sub = document.getElementById("quorum-sub");
  if (sub) sub.textContent = `Recorded ${String(run.started_at).slice(0, 10)} on NEAR testnet. The manager proposes a trade only when every model says trade, with the same tokens and the same recipient, at the smallest amount any of them asked for. Anything else is a hold, before the contract is even asked.`;
  el.innerHTML = run.cases
    .map((c: any, i: number) => {
      const [title, sub] = QTITLES[c.label] ?? [c.label, ""];
      const votes = c.votes
        .map((v: any) => {
          const dt = decisionText(v.decision, run.fund);
          return `<div class="vote">
            <p class="vote-model">${esc(modelName(v.model))}</p>
            <p class="vote-said">said</p>
            <p class="decision ${dt.danger ? "danger" : ""}">${esc(dt.text)}</p>
            <p class="vote-sig">${receiptCell(v.receipt)}</p>
          </div>`;
        })
        .join("");
      const q = c.quorum;
      const why = q.agreed ? "Both models agree." : String(q.why).replace(/[\w.-]+\/[\w.-]+/g, (m: string) => modelName(m)).replace(/^./, (x: string) => x.toUpperCase()) + ".";
      const res =
        c.accepted === true
          ? outcome("yes", "Quorum: trade, and the contract accepted it.", why)
          : c.accepted === false
            ? outcome("no", "Quorum: trade, and the contract refused it.", humanReason(c.contract_reason ?? "") + ".")
            : outcome("neutral", "Quorum: hold.", `${why} Nothing was sent to the contract.`);
      const links = [c.tx ? txLink(c.tx) : "", c.settle_tx ? txLink(c.settle_tx, "Settled") : ""].filter(Boolean).join(" · ");
      return `<article class="case quorum-case">
        <header class="case-h"><p class="case-n">Case ${i + 1} of ${run.cases.length}</p><h3 class="case-label">${esc(title)}</h3><p class="case-sub">${esc(sub)}</p></header>
        <div class="votes">${votes}</div>
        <div class="case-out">${res}${links ? `<p class="case-links">${links}</p>` : ""}</div>
      </article>`;
    })
    .join("");
}
