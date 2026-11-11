// GET /f/:id: the link people paste into chats. Crawlers read the Open Graph tags; browsers are sent
// straight to the site with the fund selected. No chain access here, so the page makes no claim
// about the fund: the picture (/api/og) and the site show what the chain says. Not kept by the CDN:
// the absolute URLs in it depend on the host the request came to.
import { escapeHtml, publicOrigin, scriptJson, type Deps } from "./http.ts";
import { isAccountId, parseNetwork, type Network } from "./near.ts";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" };

export function sharePage(origin: string, id: string, network: Network): string {
  const net = network === "mainnet" ? "&network=mainnet" : "";
  const target = `${origin}/?fund=${encodeURIComponent(id)}${net}`;
  const canonical = `${origin}/f/${encodeURIComponent(id)}${network === "mainnet" ? "?network=mainnet" : ""}`;
  const image = `${origin}/api/og?fund=${encodeURIComponent(id)}&network=${network}`;
  const title = `${id} · Plinth fund`;
  const description = `Check this fund on NEAR ${network} from the chain: its access keys, the code it runs, what it holds, its trades and the trades the contract refused.`;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="canonical" href="${e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Plinth">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${e(`Plinth fund ${id}: access keys, release, holdings, trades and refusals`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="twitter:image" content="${e(image)}">
<meta http-equiv="refresh" content="0; url=${e(target)}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05080f;color:#e6edf7;font:16px/1.6 system-ui,sans-serif}a{color:#22d3ee}</style>
</head>
<body>
<p>Opening <a href="${e(target)}">${e(id)}</a> on Plinth…</p>
<script>location.replace(${scriptJson(target)});</script>
</body>
</html>
`;
}

const plainPage = (title: string, text: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05080f;color:#e6edf7;font:16px/1.6 system-ui,sans-serif}a{color:#22d3ee}</style></head>
<body><p>${escapeHtml(text)} <a href="/">Go to Plinth</a></p></body></html>
`;

export function handleShare(request: Request, deps: Deps, id: string | null): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(plainPage("Plinth", "Use GET."), { status: 405, headers: { ...HTML_HEADERS, allow: "GET" } });
  const network = parseNetwork(new URL(request.url).searchParams.get("network"));
  if (!isAccountId(id) || !network) return new Response(plainPage("Not a fund link", "This is not a valid fund link."), { status: 400, headers: { ...HTML_HEADERS, "cache-control": "no-store" } });
  return new Response(sharePage(publicOrigin(request, deps.env), id, network), { status: 200, headers: { ...HTML_HEADERS, "cache-control": "public, max-age=0, must-revalidate" } });
}
