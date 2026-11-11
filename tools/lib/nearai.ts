// NEAR AI Cloud (OpenAI-compatible, models served in TEEs). Every completion can be fetched with a
// signature by the model's enclave key over `model:sha256(request body):sha256(response body)`.
// We keep the exact request and response bytes, so anyone can re-check the receipt offline:
// recompute both hashes and recover the signer from the signature (Ethereum personal_sign).
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const NEARAI_API = process.env.NEARAI_API ?? "https://cloud-api.near.ai/v1";
export const AGENT_MODEL = process.env.PLINTH_AGENT_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
// The session proxy injects the real key; a placeholder keeps the client happy elsewhere.
const KEY = process.env.NEARAI_API_KEY ?? "proxy-injected";

export interface Receipt {
  model: string;
  chat_id: string;
  request: string; // exact bytes sent
  response: string; // exact bytes received
  signed_text: string;
  signature: string;
  signing_address: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export async function chat(system: string, user: string, model = AGENT_MODEL): Promise<{ content: string; receipt: Receipt }> {
  const request = JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, max_tokens: 8000 });
  const res = await fetch(`${NEARAI_API}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: request });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}: ${response.slice(0, 200)}`);
  const body = JSON.parse(response);
  const sigRes = await fetch(`${NEARAI_API}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${KEY}` } });
  // No signature is a receipt that does not verify, not a crash: the answer is still recorded.
  const sig: any = sigRes.ok ? await sigRes.json().catch(() => ({})) : {};
  return {
    content: body.choices?.[0]?.message?.content ?? "",
    receipt: { model, chat_id: body.id, request, response, signed_text: String(sig.text ?? ""), signature: String(sig.signature ?? ""), signing_address: String(sig.signing_address ?? "") },
  };
}

/** What a receipt can prove.
 *  - "enclave": models NEAR AI Cloud runs in its own TEEs (e.g. DeepSeek). The model's enclave key signs
 *    `model:sha256(request):sha256(response)`; NEAR AI's attestation report for the model ties that key
 *    to attested hardware (see README).
 *  - "gateway": external providers (e.g. Google Gemini) proxied by NEAR AI Cloud. A NEAR AI key signs
 *    `sha256(request):sha256(response)` (no model name). NEAR AI's attestation endpoint answers, for these
 *    models: "TEE attestation is not supported for external providers. External providers run outside of
 *    our Trusted Execution Environment." So the receipt shows which bytes NEAR AI relayed, nothing more. */
export type ReceiptKind = "enclave" | "gateway";

/** External providers NEAR AI Cloud proxies (their answers get gateway receipts, never enclave ones). */
const EXTERNAL = /^(google|openai|anthropic|x-ai|mistralai|meta-llama-api)\//;
export function receiptKind(r: Pick<Receipt, "model">): ReceiptKind {
  return EXTERNAL.test(r.model) ? "gateway" : "enclave";
}

/** The signing addresses NEAR AI attests: the model's enclave key(s) and the gateway key, read from
 *  its attestation report (`model_attestations[].signing_address`, `gateway_attestation.signing_address`).
 *  The report also carries the TDX quotes those keys are bound to; checking the quotes themselves is
 *  NEAR AI's verifier's job and is not repeated here. External models have no report of their own,
 *  so their gateway key is read from the report of `reportModel`. */
export interface Attested {
  at: string;
  enclave: Record<string, string[]>;
  gateway: string[];
}
export async function attestedSigners(models: string[], reportModel = AGENT_MODEL): Promise<Attested> {
  const out: Attested = { at: new Date().toISOString(), enclave: {}, gateway: [] };
  for (const m of new Set([...models, reportModel])) {
    if (EXTERNAL.test(m)) continue;
    const r = await fetch(`${NEARAI_API}/attestation/report?model=${encodeURIComponent(m)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${KEY}` } });
    if (!r.ok) continue;
    const d: any = await r.json().catch(() => ({}));
    out.enclave[m] = (d.model_attestations ?? []).map((a: any) => String(a.signing_address).toLowerCase()).filter(Boolean);
    const g = d.gateway_attestation?.signing_address;
    if (g && !out.gateway.includes(g.toLowerCase())) out.gateway.push(String(g).toLowerCase());
  }
  return out;
}

/** Offline check: the signed text covers the hashes of these exact bytes (and, for enclave receipts,
 *  names the model), and the signature recovers to the stated signing address. With `attested`, the
 *  signer must also be one NEAR AI attests for this model (enclave) or its gateway: without that, a
 *  receipt only proves it is self-consistent, since anyone can sign with a key of their own. */
export function verifyReceipt(r: Receipt, attested?: Attested): { ok: boolean; kind: ReceiptKind; pinned: boolean; checks: string[] } {
  const checks: string[] = [];
  const kind = receiptKind(r);
  if (!r.signed_text || !r.signature || !r.signing_address) return { ok: false, kind, pinned: false, checks: ["no signature was returned for this answer"] };
  const hashes = `${sha256hex(r.request)}:${sha256hex(r.response)}`;
  const expect = kind === "enclave" ? `${r.model}:${hashes}` : hashes;
  const textOk = r.signed_text === expect;
  checks.push(
    textOk
      ? kind === "enclave"
        ? "signed text = model:sha256(request):sha256(response) (model enclave key)"
        : "signed text = sha256(request):sha256(response) (NEAR AI gateway key; this model runs outside NEAR AI's TEE)"
      : `signed text differs from ${expect.slice(0, 60)}…`,
  );
  let recovered = "";
  try {
    const msg = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${new TextEncoder().encode(r.signed_text).length}${r.signed_text}`);
    const hash = keccak_256(msg);
    const sig = Uint8Array.from(Buffer.from(r.signature.replace(/^0x/, ""), "hex"));
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    const recSig = new Uint8Array(65);
    recSig[0] = v;
    recSig.set(sig.subarray(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(recSig, hash, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    recovered = "0x" + Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(12)).toString("hex");
  } catch (e) {
    checks.push(`signature does not parse: ${(e as Error).message}`);
  }
  const sigOk = recovered !== "" && recovered.toLowerCase() === r.signing_address.toLowerCase();
  checks.push(sigOk ? `signature recovers to ${r.signing_address}` : `signature recovers to ${recovered || "nothing"}, not ${r.signing_address}`);
  let pinned = false;
  if (attested) {
    const allowed = kind === "enclave" ? attested.enclave[r.model] ?? [] : attested.gateway;
    pinned = allowed.includes(recovered.toLowerCase());
    checks.push(pinned ? `signer is the ${kind === "enclave" ? "model enclave key" : "gateway key"} NEAR AI attested on ${attested.at.slice(0, 10)}` : `signer ${recovered || "?"} is not a key NEAR AI attests for ${kind === "enclave" ? r.model : "its gateway"}`);
  }
  return { ok: textOk && sigOk && (!attested || pinned), kind, pinned, checks };
}
