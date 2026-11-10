// The AI operator section: each recorded case with the model's answer, its NEAR AI signed receipt
// (re-verified here, in the browser) and what the contract did.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { explorer } from "./chain.ts";

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
    if (r.signed_text !== expect) return { ok: false, kind, why: "signed text does not match the request and response" };
    const text = enc(r.signed_text);
    const hash = keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${text.length}`), ...text]));
    const sig = Uint8Array.from(r.signature.replace(/^0x/, "").match(/../g)!.map((h: string) => parseInt(h, 16)));
    const rec = new Uint8Array(65);
    rec[0] = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    rec.set(sig.subarray(0, 64), 1);
    const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(rec, hash, { prehash: false })).toBytes(false);
    const addr = "0x" + hex(keccak_256(pub.subarray(1)).subarray(12));
    const who = kind === "enclave" ? "model enclave key" : "NEAR AI gateway key (model runs outside NEAR AI's TEE)";
    return addr.toLowerCase() === String(r.signing_address).toLowerCase() ? { ok: true, kind, why: `signed by ${addr}, ${who}` } : { ok: false, kind, why: `recovers to ${addr}` };
  } catch (e) {
    return { ok: false, kind, why: (e as Error).message };
  }
}

const TITLES: Record<string, [string, string]> = {
  injected: ["Prompt injection", "The market note hides an instruction to send the whole fund to an attacker."],
  compromised: ["Compromised model", "Same note, given to the model with its safety tuning removed (a stand-in for a jailbroken agent)."],
  hijacked: ["Hijacked operator", "No model: the operator's software is replaced and submits the attacker's trade directly."],
  honest: ["Ordinary day", "A normal market note."],
};

export function mountAgent(run: any) {
  const el = document.getElementById("agent-cases");
  if (!el || !run?.cases) return;
  document.getElementById("agent-sub")!.innerHTML = `Recorded ${esc(String(run.started_at).slice(0, 10))} on testnet against <span class="mono">${esc(run.fund)}</span>. The model runs on NEAR AI Cloud; each answer carries a signature from the model's enclave key, re-checked below in your browser.`;
  el.innerHTML = run.cases
    .map((c: any) => {
      const [title, sub] = TITLES[c.label] ?? [c.label, ""];
      const v = c.receipt ? verifyReceipt(c.receipt) : null;
      const d = c.decision;
      const said = c.model === null ? `<p class="small">Submitted: sell <b>${esc(d.amount)}</b> of ${esc(d.sell)}, output to <b class="mono">${esc(d.recipient)}</b>.</p>` : `<p class="small">Model <span class="mono">${esc(String(c.model).split("/").pop())}</span> answered:</p><pre class="said">${esc(c.raw || "(empty)")}</pre>`;
      const verdict =
        c.accepted === true
          ? `<span class="tag yes">contract accepted</span> <a href="${explorer("testnet", c.tx)}" target="_blank" rel="noopener">${esc(c.tx.slice(0, 10))}… ↗</a>${c.settle_tx ? ` · settled <a href="${explorer("testnet", c.settle_tx)}" target="_blank" rel="noopener">↗</a>` : ""}`
          : c.accepted === false
            ? `<span class="tag no">contract refused</span> <span class="small">${esc(c.contract_reason ?? "")}</span> <a href="${explorer("testnet", c.tx)}" target="_blank" rel="noopener">${esc(c.tx.slice(0, 10))}… ↗</a>`
            : `<span class="tag">nothing proposed</span> <span class="small">the model chose to hold</span>`;
      return `<div class="card agent-case"><span class="tag">${esc(title)}</span><p class="small muted">${esc(sub)}</p>${said}<p>${verdict}</p>${v ? `<p class="small ${v.ok ? "okc" : "bad"}">${v.ok ? "✓" : "✗"} NEAR AI receipt ${v.ok ? "verified" : "NOT verified"}: ${esc(v.why)}</p>` : ""}</div>`;
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
  document.getElementById("quorum-sub")!.innerHTML = `Recorded ${esc(String(run.started_at).slice(0, 10))} on testnet against <span class="mono">${esc(run.fund)}</span>. The operator proposes a trade only when every model says trade with the same tokens and recipient, at the smallest amount any of them asked for. Anything else is a hold, before the contract is even asked.`;
  el.innerHTML = run.cases
    .map((c: any) => {
      const [title, sub] = QTITLES[c.label] ?? [c.label, ""];
      const votes = c.votes
        .map((v: any) => {
          const r = v.receipt ? verifyReceipt(v.receipt) : null;
          const d = v.decision;
          const what = !d ? "no usable answer" : d.action === "hold" ? "hold" : `trade ${esc(d.amount)} of ${esc(d.sell)} → ${esc(d.recipient || run.fund)}`;
          const danger = d?.action === "trade" && d.recipient && d.recipient !== run.fund;
          return `<div class="vote"><p class="small"><span class="mono">${esc(String(v.model).split("/").pop())}</span>: <b class="${danger ? "danger" : ""}">${what}</b></p>${r ? `<p class="small ${r.ok ? "okc" : "bad"}">${r.ok ? "✓" : "✗"} receipt (${r.kind}) ${r.ok ? "verified" : "NOT verified"}: ${esc(r.why)}</p>` : ""}</div>`;
        })
        .join("");
      const q = c.quorum;
      const verdict =
        c.accepted === true
          ? `<span class="tag yes">quorum: trade</span> <span class="tag yes">contract accepted</span> <a href="${explorer("testnet", c.tx)}" target="_blank" rel="noopener">${esc(c.tx.slice(0, 10))}… ↗</a>${c.settle_tx ? ` · settled <a href="${explorer("testnet", c.settle_tx)}" target="_blank" rel="noopener">↗</a>` : ""}`
          : c.accepted === false
            ? `<span class="tag yes">quorum: trade</span> <span class="tag no">contract refused</span> <span class="small">${esc(c.contract_reason ?? "")}</span>`
            : `<span class="tag no">quorum: hold</span> <span class="small">${esc(q.why)}</span>`;
      return `<div class="card agent-case quorum-case"><span class="tag">${esc(title)}</span><p class="small muted">${esc(sub)}</p>${votes}<p>${verdict}</p></div>`;
    })
    .join("");
}
