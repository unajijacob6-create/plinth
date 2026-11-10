// The AI operator section: each recorded case with the model's answer, its NEAR AI signed receipt
// (re-verified here, in the browser) and what the contract did.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { explorer } from "./chain.ts";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

export function verifyReceipt(r: any): { ok: boolean; why: string } {
  try {
    const expect = `${r.model}:${hex(sha256(enc(r.request)))}:${hex(sha256(enc(r.response)))}`;
    if (r.signed_text !== expect) return { ok: false, why: "signed text does not match the request and response" };
    const text = enc(r.signed_text);
    const hash = keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${text.length}`), ...text]));
    const sig = Uint8Array.from(r.signature.replace(/^0x/, "").match(/../g)!.map((h: string) => parseInt(h, 16)));
    const rec = new Uint8Array(65);
    rec[0] = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    rec.set(sig.subarray(0, 64), 1);
    const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(rec, hash, { prehash: false })).toBytes(false);
    const addr = "0x" + hex(keccak_256(pub.subarray(1)).subarray(12));
    return addr.toLowerCase() === String(r.signing_address).toLowerCase() ? { ok: true, why: `signed by ${addr}` } : { ok: false, why: `recovers to ${addr}` };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
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
