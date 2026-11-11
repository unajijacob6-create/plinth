// The one Vercel Function behind every server route of Plinth (Node.js runtime, Web-standard
// `fetch` export). vercel.json rewrites /api/<route> and /f/<id> here; the route is read from the
// path the visitor asked for, or from the `route` query the rewrite adds.
//
// Nothing here can move a fund's money: there is no NEAR key on Vercel. The only secrets are
// NEAR_AI_API_KEY (AI operator) and ONE_CLICK_JWT (1Click partner token), both optional.
import { handleAgent } from "./_lib/agent.ts";
import { handleFund, handleFunds, factoryFor } from "./_lib/funds.ts";
import { CORS, HttpError, fail, json, methodNotAllowed, realDeps, type Deps } from "./_lib/http.ts";
import { handleOg } from "./_lib/og.ts";
import { handleQuote, handleTokens } from "./_lib/quote.ts";
import { handleShare } from "./_lib/share.ts";

// Seconds. The AI operator call is the only slow route; everything else answers in a few seconds.
export const config = { maxDuration: 60 };

const ROUTES = new Set(["quote", "tokens", "agent", "funds", "fund", "og", "health"]);

/** Which route a request is for: [name, id for /f/<id>]. */
export function routeOf(url: URL): [string, string | null] {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "f" && parts.length === 2) {
    try {
      return ["f", decodeURIComponent(parts[1])];
    } catch {
      return ["f", null];
    }
  }
  if (parts[0] === "api" && parts.length === 2 && ROUTES.has(parts[1])) return [parts[1], null];
  // The rewritten form: /api?route=<name>[&id=<id>].
  const r = url.searchParams.get("route") ?? "";
  if (r === "f") return ["f", url.searchParams.get("id")];
  return [ROUTES.has(r) ? r : "", null];
}

function health(request: Request, deps: Deps): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  // Booleans only: whether a variable is set, never its value.
  return json({
    ok: true,
    env: { NEAR_AI_API_KEY: !!(deps.env.NEAR_AI_API_KEY ?? "").trim(), ONE_CLICK_JWT: !!(deps.env.ONE_CLICK_JWT ?? "").trim() },
    factories: { testnet: !!factoryFor("testnet", deps.env), mainnet: !!factoryFor("mainnet", deps.env) },
    commit: deps.env.VERCEL_GIT_COMMIT_SHA ?? null,
    node: process.version,
    time: new Date(deps.now()).toISOString(),
  });
}

export async function handle(request: Request, deps: Deps = realDeps()): Promise<Response> {
  try {
    const url = new URL(request.url);
    const [route, id] = routeOf(url);
    if (route === "f") return handleShare(request, deps, id);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    switch (route) {
      case "quote":
        return await handleQuote(request, deps);
      case "tokens":
        return await handleTokens(request, deps);
      case "agent":
        return await handleAgent(request, deps);
      case "funds":
        return await handleFunds(request, deps);
      case "fund":
        return await handleFund(request, deps);
      case "og":
        return await handleOg(request, deps);
      case "health":
        return health(request, deps);
      default:
        return fail(404, "not_found", "No such endpoint. See docs/VERCEL.md for the list.");
    }
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    // Never echo an internal error to the caller: it could carry a request header.
    console.error("unhandled:", (e as Error)?.message);
    return fail(500, "internal_error", "Something went wrong on the server.");
  }
}

export default {
  fetch: (request: Request) => handle(request),
};
