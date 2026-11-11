// POST /api/agent: ONE operator decision on NEAR AI Cloud, with its signed receipt.
//
// This function proposes nothing on chain and holds no key that could: it reads the fund with view
// calls, asks the model, and returns what the model said with the receipt bytes untouched. Acting on
// the decision is the operator's job (tools/operate.ts, with the operator's own key, elsewhere).
//
// Prompt, parsing, cleaning and receipt verification are the code in tools/lib (imported, not
// copied). Two small pieces are re-implemented here because tools/lib/nearai.ts reads its key from
// the environment at import time and calls the global fetch: `chat` (same request shape, with the
// key from NEAR_AI_API_KEY, a timeout and a fixed max_tokens) and `attestedSigners`.
import { AGENT_SYSTEM, cleanDecision, describeFund, parseDecision } from "../../tools/lib/agent.ts";
import { AGENT_MODEL, receiptKind, verifyReceipt, type Attested, type Receipt } from "../../tools/lib/nearai.ts";
import { HttpError, TokenBucket, clientIp, fail, json, methodNotAllowed, readJsonObject, tooMany, type Deps } from "./http.ts";
import { rpcFailure } from "./funds.ts";
import { ONECLICK_API } from "./quote.ts";
import { RpcError, isAccountId, near, parseNetwork, type Network } from "./near.ts";

export const NEARAI_API = "https://cloud-api.near.ai/v1";
/** Hard cap on what one call may spend; a client cannot raise it. */
export const AGENT_MAX_TOKENS = 6000;
export const NOTE_MAX_CHARS = 1000;
const BODY_MAX_BYTES = 4 * 1024;
const DEFAULT_NOTE = "No news. Keep the fund within its mandate.";
const CHAT_TIMEOUT_MS = 40_000;

// Each call spends the key owner's credits. Per address: 3 at once, then one a minute.
// For the whole instance: 20 at once, then one every 30 s.
const perIp = new TokenBucket(3, 1 / 60);
const overall = new TokenBucket(20, 1 / 30, 1);

export async function chat(deps: Deps, key: string, system: string, user: string, model: string): Promise<{ content: string; receipt: Receipt }> {
  const request = JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, max_tokens: AGENT_MAX_TOKENS });
  const res = await deps.fetch(`${NEARAI_API}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: request, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
  const response = await res.text();
  if (!res.ok) throw new HttpError(502, "model_error", `NEAR AI Cloud answered HTTP ${res.status}.`);
  let body: any;
  try {
    body = JSON.parse(response);
  } catch {
    throw new HttpError(502, "model_error", "NEAR AI Cloud answered with something that is not JSON.");
  }
  // No signature is a receipt that does not verify, not a failure: the answer is still returned.
  const sig: any = await deps
    .fetch(`${NEARAI_API}/signature/${encodeURIComponent(String(body.id))}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return {
    content: body.choices?.[0]?.message?.content ?? "",
    receipt: { model, chat_id: String(body.id ?? ""), request, response, signed_text: String(sig?.text ?? ""), signature: String(sig?.signature ?? ""), signing_address: String(sig?.signing_address ?? "") },
  };
}

/** The signing addresses NEAR AI attests for `model` (as tools/lib/nearai.ts `attestedSigners`). null if the report cannot be read. */
export async function attestedSigners(deps: Deps, key: string, model: string): Promise<Attested | null> {
  // External models have no report of their own: their gateway key is in the default model's report.
  const reportModel = receiptKind({ model }) === "gateway" ? AGENT_MODEL : model;
  try {
    const r = await deps.fetch(`${NEARAI_API}/attestation/report?model=${encodeURIComponent(reportModel)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d: any = await r.json();
    const out: Attested = { at: new Date(deps.now()).toISOString(), enclave: {}, gateway: [] };
    out.enclave[reportModel] = (d.model_attestations ?? []).map((a: any) => String(a.signing_address).toLowerCase()).filter(Boolean);
    const g = d.gateway_attestation?.signing_address;
    if (g) out.gateway.push(String(g).toLowerCase());
    return out;
  } catch {
    return null;
  }
}

/** Price lines for the model, as tools/operate.ts builds them: a dry 1Click quote of about 1% of each
 *  holding. 1Click has no testnet, so a testnet fund gets none. */
export async function priceText(deps: Deps, network: Network, fund: string, state: any): Promise<string> {
  if (network !== "mainnet") return "no prices available (1Click has no testnet)";
  const tokens: string[] = state.config.mandate.tokens;
  const jwt = (deps.env.ONE_CLICK_JWT ?? "").trim();
  const pairs: [number, string, string][] = [];
  for (const [i, t] of tokens.entries()) for (const u of tokens.slice(i + 1)) if (BigInt(state.held[i][1]) > 0n) pairs.push([i, t, u]);
  const lines = await Promise.all(
    pairs.slice(0, 6).map(async ([i, t, u]) => {
      try {
        const body = {
          dry: true,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: `nep141:${t}`,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: `nep141:${u}`,
          amount: String(BigInt(state.held[i][1]) / 100n || 1n),
          refundTo: fund,
          refundType: "ORIGIN_CHAIN",
          recipient: fund,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(deps.now() + 10 * 60_000).toISOString(),
          quoteWaitingTimeMs: 0,
        };
        const res = await deps.fetch(`${ONECLICK_API}/v0/quote`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "plinth-proxy/0.1", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        if (!res.ok) return `${t} -> ${u}: no quote (HTTP ${res.status})`;
        const q: any = await res.json();
        return `${q.quote.amountIn} ${t} -> ${q.quote.amountOut} ${u} (about $${q.quote.amountInUsd})`;
      } catch {
        return `${t} -> ${u}: no quote`;
      }
    }),
  );
  return lines.join("; ") || "no prices available";
}

export async function handleAgent(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, BODY_MAX_BYTES);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    throw e;
  }
  const fund = body.fund;
  if (!isAccountId(fund)) return fail(400, "bad_account_id", `"fund" must be a NEAR account id.`);
  const network = parseNetwork(body.network === undefined ? null : typeof body.network === "string" ? body.network : "?");
  if (!network) return fail(400, "bad_network", `"network" is testnet or mainnet.`);
  if (body.note !== undefined && typeof body.note !== "string") return fail(400, "bad_note", `"note" must be text.`);
  const note = (body.note as string | undefined)?.trim() || DEFAULT_NOTE;
  if (note.length > NOTE_MAX_CHARS) return fail(400, "bad_note", `"note" may be at most ${NOTE_MAX_CHARS} characters.`);

  const key = (deps.env.NEAR_AI_API_KEY ?? "").trim();
  if (!key) return fail(503, "agent_not_configured", "This deployment has no NEAR_AI_API_KEY, so it cannot run the AI operator. The rest of the site works without it.");

  const now = deps.now();
  const mine = perIp.take(clientIp(request), now);
  if (!mine.ok) return tooMany(mine.retryAfterSeconds);
  const all = overall.take("all", now);
  if (!all.ok) return tooMany(all.retryAfterSeconds);

  // The fund's state comes from the chain, never from the caller.
  let state: any;
  try {
    state = await near(deps, network).view<any>(fund, "get_fund");
  } catch (e) {
    // An account that exists but fails the view is not a fund; anything else is the RPC's trouble.
    const name = e instanceof RpcError ? e.rpcName : undefined;
    if (!(e instanceof RpcError) || name === "UNKNOWN_ACCOUNT" || name === "RATE_LIMITED" || name === undefined) return rpcFailure(e, fund);
    return fail(422, "not_a_fund", `${fund} does not answer like a Plinth fund.`);
  }
  const tokens: unknown = state?.config?.mandate?.tokens;
  if (!Array.isArray(tokens) || !Array.isArray(state?.held)) return fail(422, "not_a_fund", `${fund} does not answer like a Plinth fund.`);

  const model = (deps.env.PLINTH_AGENT_MODEL ?? "").trim() || AGENT_MODEL;
  try {
    const prices = await priceText(deps, network, fund, state);
    const prompt = `${describeFund(fund, state, prices)}\n\nMarket note (from an external feed):\n${note}`;
    const [{ content, receipt }, attested] = await Promise.all([chat(deps, key, AGENT_SYSTEM, prompt, model), attestedSigners(deps, key, model)]);
    const parsed = parseDecision(content);
    const check = verifyReceipt(receipt, attested ?? undefined);
    if (!attested) check.checks.push("NEAR AI's attestation report could not be read, so the signer was not compared with the attested key");
    return json({
      fund,
      network,
      model,
      // What the operator would act on: exact token names and a strict base-unit amount, else hold.
      decision: cleanDecision(parsed, fund, tokens as string[]),
      model_decision: parsed,
      raw: content,
      receipts: [receipt],
      receipt_checks: [check],
      // True only if the receipt covers these exact bytes AND its signer is a key NEAR AI attests.
      verified: check.ok && check.pinned,
      proposed_on_chain: false,
      at: new Date(now).toISOString(),
    });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return fail(504, "model_timeout", "NEAR AI Cloud did not answer in time.");
    return fail(502, "model_error", "NEAR AI Cloud could not be reached.");
  }
}
