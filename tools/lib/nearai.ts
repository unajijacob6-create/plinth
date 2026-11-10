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
  const request = JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, max_tokens: 2000 });
  const res = await fetch(`${NEARAI_API}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: request });
  const response = await res.text();
  if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}: ${response.slice(0, 200)}`);
  const body = JSON.parse(response);
  const sig = await fetch(`${NEARAI_API}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.json() as Promise<any>);
  return {
    content: body.choices?.[0]?.message?.content ?? "",
    receipt: { model, chat_id: body.id, request, response, signed_text: sig.text, signature: sig.signature, signing_address: sig.signing_address },
  };
}

/** Offline check: the signed text names this model and the hashes of these exact bytes, and the
 *  signature recovers to the stated signing address. (That the address belongs to an attested TEE is
 *  shown by NEAR AI's attestation report for the model; see README.) */
export function verifyReceipt(r: Receipt): { ok: boolean; checks: string[] } {
  const checks: string[] = [];
  const expect = `${r.model}:${sha256hex(r.request)}:${sha256hex(r.response)}`;
  const textOk = r.signed_text === expect;
  checks.push(textOk ? "signed text = model:sha256(request):sha256(response)" : `signed text differs from ${expect.slice(0, 60)}…`);
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
  const sigOk = recovered.toLowerCase() === r.signing_address.toLowerCase();
  checks.push(sigOk ? `signature recovers to ${r.signing_address}` : `signature recovers to ${recovered || "nothing"}, not ${r.signing_address}`);
  return { ok: textOk && sigOk, checks };
}
