// POST /api/quote and GET /api/tokens: a thin proxy in front of NEAR Intents 1Click.
//
// The fund contract verifies 1Click's signature over the quote, so the response body is passed on
// byte for byte: it is never parsed, re-serialised or trimmed here. The only thing this proxy adds
// is the partner token (ONE_CLICK_JWT), which the browser must never see.
import { CORS, HttpError, TokenBucket, clientIp, fail, methodNotAllowed, readJsonObject, tooMany, type Deps } from "./http.ts";

export const ONECLICK_API = "https://1click.chaindefuser.com";
export const QUOTE_MAX_BYTES = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Fields of 1Click's QuoteRequest this proxy forwards. Required ones first (1Click's own list),
 *  then the optional ones a Plinth trade uses or that cannot cost the token owner anything.
 *  Not forwarded on purpose: appFees, rebates, insured, confidentiality (fee and partner features
 *  that should not be reachable with someone else's partner token). */
export const QUOTE_REQUIRED = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] as const;
export const QUOTE_OPTIONAL = ["depositMode", "quoteWaitingTimeMs", "customRecipientMsg", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "connectedWallets", "sessionId"] as const;
const STRING_FIELDS = new Set(["swapType", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline", "depositMode", "customRecipientMsg", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "sessionId"]);

/** The allow-listed copy of a client's quote request, or the reason it is refused. */
export function pickQuoteRequest(body: Record<string, unknown>): { ok: true; request: Record<string, unknown> } | { ok: false; message: string } {
  const out: Record<string, unknown> = {};
  for (const k of QUOTE_REQUIRED) {
    if (body[k] === undefined || body[k] === null) return { ok: false, message: `"${k}" is required.` };
    out[k] = body[k];
  }
  for (const k of QUOTE_OPTIONAL) if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  for (const [k, v] of Object.entries(out)) {
    if (STRING_FIELDS.has(k) && typeof v !== "string") return { ok: false, message: `"${k}" must be a string.` };
  }
  if (typeof out.dry !== "boolean") return { ok: false, message: `"dry" must be true or false.` };
  if (typeof out.slippageTolerance !== "number" || !Number.isFinite(out.slippageTolerance)) return { ok: false, message: `"slippageTolerance" must be a number (basis points).` };
  if (out.quoteWaitingTimeMs !== undefined && (typeof out.quoteWaitingTimeMs !== "number" || !Number.isFinite(out.quoteWaitingTimeMs))) return { ok: false, message: `"quoteWaitingTimeMs" must be a number.` };
  if (!/^\d{1,40}$/.test(out.amount as string)) return { ok: false, message: `"amount" must be an integer in base units.` };
  if (out.connectedWallets !== undefined && !(Array.isArray(out.connectedWallets) && out.connectedWallets.length <= 10 && out.connectedWallets.every((w) => typeof w === "string"))) return { ok: false, message: `"connectedWallets" must be a short list of strings.` };
  return { ok: true, request: out };
}

function upstreamHeaders(env: Deps["env"]): { headers: Record<string, string>; jwt: "yes" | "no" } {
  const jwt = (env.ONE_CLICK_JWT ?? "").trim();
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "plinth-proxy/0.1" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return { headers, jwt: jwt ? "yes" : "no" };
}

/** An upstream failure of our own making (timeout, network): JSON, marked as coming from the proxy. */
function upstreamFailure(e: unknown, jwt: string): Response {
  const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
  return fail(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unreachable", timedOut ? "1Click did not answer within 10 s." : "1Click could not be reached.", { "x-plinth-jwt": jwt, "x-plinth-source": "proxy" });
}

// 60 quotes a minute per address, bursts of 20.
const quoteLimit = new TokenBucket(20, 1);

export async function handleQuote(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const limited = quoteLimit.take(clientIp(request), deps.now());
  if (!limited.ok) return tooMany(limited.retryAfterSeconds);
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, QUOTE_MAX_BYTES);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message, { "x-plinth-source": "proxy" });
    throw e;
  }
  const picked = pickQuoteRequest(body);
  if (!picked.ok) return fail(400, "bad_quote_request", picked.message, { "x-plinth-source": "proxy" });
  const { headers, jwt } = upstreamHeaders(deps.env);
  let upstream: Response;
  let bytes: ArrayBuffer;
  try {
    upstream = await deps.fetch(`${ONECLICK_API}/v0/quote`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(picked.request), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    bytes = await upstream.arrayBuffer();
  } catch (e) {
    return upstreamFailure(e, jwt);
  }
  // 1Click's status and body, untouched. A quote must never be cached.
  return new Response(bytes, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-plinth-jwt": jwt, "x-plinth-source": "1click", "x-content-type-options": "nosniff", ...CORS },
  });
}

export async function handleTokens(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const { headers, jwt } = upstreamHeaders(deps.env);
  let upstream: Response;
  let bytes: ArrayBuffer;
  try {
    upstream = await deps.fetch(`${ONECLICK_API}/v0/tokens`, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    bytes = await upstream.arrayBuffer();
  } catch (e) {
    return upstreamFailure(e, jwt);
  }
  return new Response(bytes, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      // Only a good answer is kept by the CDN, for a minute.
      "cache-control": upstream.ok ? "public, max-age=0, s-maxage=60, stale-while-revalidate=300" : "no-store",
      "x-plinth-jwt": jwt,
      "x-plinth-source": "1click",
      "x-content-type-options": "nosniff",
      ...CORS,
    },
  });
}
