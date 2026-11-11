// GET /api/og?fund=<id>&network=: a 1200x630 PNG drawn from chain views at request time.
// Colours and type follow web/src/style.css (dark background, Manrope).
import fs from "node:fs/promises";
import { CORS, fail, methodNotAllowed, type Deps } from "./http.ts";
import { fundDetail, factoryFor, type FundDetail } from "./funds.ts";
import { RpcError, isAccountId, near, parseNetwork, type Near, type Network } from "./near.ts";

const C = { bg: "#05080f", bg2: "#0a101c", panel: "#0c1322", line: "rgba(148,163,184,0.24)", ink: "#e6edf7", ink2: "#a6b3c7", ink3: "#6f7d93", blue: "#3d8bff", cyan: "#22d3ee", ok: "#34d399", bad: "#f87171", warn: "#fbbf24" };
export const OG_CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

// ft_metadata practically never changes: keep it for the life of the instance.
const metaCache = new Map<string, TokenMeta>();
const cleanSymbol = (s: unknown, fallback: string) => (typeof s === "string" && s.trim() ? s.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 12) || fallback : fallback);

export async function tokenMeta(n: Near, token: string, cache: Map<string, TokenMeta> = metaCache): Promise<TokenMeta> {
  const k = `${n.network}:${token}`;
  const hit = cache.get(k);
  if (hit) return hit;
  try {
    const m = await n.view<any>(token, "ft_metadata");
    const decimals = Number(m?.decimals);
    const meta = { symbol: cleanSymbol(m?.symbol, token.split(".")[0].slice(0, 12)), decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0 };
    cache.set(k, meta);
    return meta;
  } catch {
    // A token without ft_metadata. The test pUSD is one (6 decimals, as web/src/app.ts assumes);
    // for any other, base units are shown as they are. Not cached: the next request tries again.
    return token.startsWith("pusd.") ? { symbol: "pUSD", decimals: 6 } : { symbol: token.split(".")[0].slice(0, 12), decimals: 0 };
  }
}

/** Base units as a human amount: thousands separators, at most `places` decimals, never rounded up. */
export function humanAmount(units: string | bigint, decimals: number, places = 4): string {
  let v: bigint;
  try {
    v = BigInt(units);
  } catch {
    return "?";
  }
  if (v < 0n) return "?";
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  if (!frac && v > 0n && v / base === 0n) return `<0.${"0".repeat(Math.max(0, places - 1))}1`;
  return frac ? `${whole}.${frac}` : whole;
}

export type Tone = "ok" | "warn" | "bad" | "muted";
export interface OgData {
  title: string;
  network: Network;
  keys: { text: string; tone: Tone };
  release: { text: string; tone: Tone };
  holdings: { symbol: string; amount: string }[];
  trades: string;
  refusals: string;
  footer: string;
  /** False when the account does not answer like a fund. */
  isFund: boolean;
}

export const OG_FOOTER = "exit in kind, any time";

/** What the image says, from what the chain said. Pure: tested without drawing. */
export function ogData(d: FundDetail, metas: Record<string, TokenMeta>): OgData {
  const keys = d.access_keys;
  const rel = d.code.release;
  const release: OgData["release"] =
    d.code.kind === "global-by-account" || !rel
      ? { text: "unknown code", tone: "bad" }
      : rel.known_issue
        ? { text: `release ${rel.version} · known issue`, tone: "warn" }
        : { text: `release ${rel.version}`, tone: "ok" };
  const held: [string, string][] = Array.isArray(d.fund?.held) ? d.fund.held : [];
  return {
    title: d.id,
    network: d.network,
    keys: { text: `${keys} access key${keys === 1 ? "" : "s"}`, tone: keys === 0 ? "ok" : "bad" },
    release,
    holdings: held.slice(0, 4).map(([t, v]) => {
      const m = metas[t] ?? { symbol: t.split(".")[0].slice(0, 12), decimals: 0 };
      return { symbol: m.symbol, amount: humanAmount(v, m.decimals) };
    }),
    trades: d.fund ? String(Number(d.fund.trades ?? 0)) : "–",
    refusals: d.fund ? String(Number(d.fund.rejections ?? 0)) : "–",
    footer: d.fund ? OG_FOOTER : "this account does not answer like a Plinth fund",
    isFund: !!d.fund,
  };
}

// ---------------------------------------------------------------- drawing (satori: flexbox only)
type El = { type: string; props: Record<string, any> };
const h = (type: string, style: Record<string, any>, ...children: (El | string | null)[]): El => {
  const kids = children.filter((c) => c !== null);
  return { type, props: { style: type === "div" ? { display: "flex", ...style } : style, children: kids.length === 1 ? kids[0] : kids } };
};
const toneColor = (t: Tone) => (t === "ok" ? C.ok : t === "warn" ? C.warn : t === "bad" ? C.bad : C.ink2);

const badge = (text: string, tone: Tone): El =>
  h("div", { alignItems: "center", padding: "10px 22px", borderRadius: 999, border: `2px solid ${toneColor(tone)}`, color: toneColor(tone), fontSize: 28, fontWeight: 800 }, text);

const stat = (value: string, label: string): El =>
  h("div", { flexDirection: "column", alignItems: "flex-end", marginLeft: 56 }, h("div", { fontSize: 56, fontWeight: 800, color: C.ink, lineHeight: 1.1 }, value), h("div", { fontSize: 22, color: C.ink3 }, label));

const logo = (): El => ({
  type: "svg",
  props: {
    width: 44,
    height: 44,
    viewBox: "0 0 32 32",
    children: [
      { type: "rect", props: { x: 5, y: 20, width: 22, height: 6, rx: 1.5, fill: C.blue } },
      { type: "rect", props: { x: 9, y: 12, width: 14, height: 6, rx: 1.5, fill: C.cyan } },
      { type: "rect", props: { x: 13, y: 4, width: 6, height: 6, rx: 1.5, fill: C.ink } },
    ],
  },
});

export function ogElement(d: OgData): El {
  const titleSize = d.title.length > 44 ? 38 : d.title.length > 30 ? 48 : 60;
  return h(
    "div",
    { width: "100%", height: "100%", flexDirection: "column", justifyContent: "space-between", padding: "52px 64px", backgroundColor: C.bg, backgroundImage: `linear-gradient(160deg, ${C.bg2} 0%, ${C.bg} 60%)`, color: C.ink, fontFamily: "Manrope" },
    h(
      "div",
      { alignItems: "center", justifyContent: "space-between" },
      h("div", { alignItems: "center" }, logo(), h("div", { marginLeft: 14, fontSize: 34, fontWeight: 800, letterSpacing: 0.5 }, "Plinth")),
      h("div", { fontSize: 24, color: C.ink3 }, `keyless fund · NEAR ${d.network}`),
    ),
    h(
      "div",
      { flexDirection: "column" },
      h("div", { fontSize: titleSize, fontWeight: 800, lineHeight: 1.15, wordBreak: "break-all" }, d.title),
      h("div", { marginTop: 22, alignItems: "center" }, badge(d.keys.text, d.keys.tone), h("div", { width: 16 }), badge(d.release.text, d.release.tone)),
    ),
    h(
      "div",
      { alignItems: "flex-end", justifyContent: "space-between" },
      h(
        "div",
        { flexDirection: "column", maxWidth: 640 },
        h("div", { fontSize: 22, color: C.ink3, marginBottom: 6 }, d.isFund ? "holds" : ""),
        ...(d.holdings.length
          ? d.holdings.map((x) => h("div", { fontSize: 34, fontWeight: 500, alignItems: "baseline" }, h("div", { fontWeight: 800 }, x.amount), h("div", { marginLeft: 12, color: C.ink2 }, x.symbol)))
          : [h("div", { fontSize: 30, color: C.ink2 }, d.isFund ? "nothing yet" : "")]),
      ),
      h("div", { alignItems: "flex-end" }, stat(d.trades, "trades"), stat(d.refusals, "refused")),
    ),
    h("div", { alignItems: "center", justifyContent: "space-between", borderTop: `2px solid ${C.line}`, paddingTop: 20, fontSize: 26 }, h("div", { color: d.isFund ? C.cyan : C.bad, fontWeight: 800 }, d.footer), h("div", { color: C.ink3 }, "verify it yourself from the chain")),
  );
}

let fontsPromise: Promise<any[]> | null = null;
/** Manrope 500 and 800 (SIL OFL 1.1, see fonts/OFL.txt). If the files are missing, @vercel/og's own font is used. */
function fonts(): Promise<any[]> {
  fontsPromise ??= Promise.all(
    ([500, 800] as const).map(async (weight) => ({ name: "Manrope", weight, style: "normal", data: await fs.readFile(new URL(`./fonts/manrope-latin-${weight}-normal.woff`, import.meta.url)) })),
  ).catch(() => []);
  return fontsPromise;
}

/** Draw the PNG. The bytes are produced before the response is built, so a drawing error is an error
 *  response, not a broken image. */
export async function renderOg(d: OgData): Promise<Uint8Array> {
  const { ImageResponse } = await import("@vercel/og");
  const f = await fonts();
  const res = new ImageResponse(ogElement(d) as any, { width: 1200, height: 630, ...(f.length ? { fonts: f } : {}) });
  return new Uint8Array(await res.arrayBuffer());
}

export async function handleOg(request: Request, deps: Deps, draw: (d: OgData) => Promise<Uint8Array> = renderOg): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const q = new URL(request.url).searchParams;
  const network = parseNetwork(q.get("network"));
  if (!network) return fail(400, "bad_network", `"network" is testnet or mainnet.`);
  const id = q.get("fund");
  if (!isAccountId(id)) return fail(400, "bad_account_id", `"fund" must be a NEAR account id.`);
  const n = near(deps, network);
  let data: OgData;
  let status = 200;
  try {
    const d = await fundDetail(n, id, { factory: factoryFor(network, deps.env), now: deps.now(), history: false });
    const tokens: string[] = Array.isArray(d.fund?.held) ? d.fund.held.slice(0, 4).map((x: [string, string]) => x[0]).filter(isAccountId) : [];
    const metas = Object.fromEntries(await Promise.all(tokens.map(async (t) => [t, await tokenMeta(n, t)] as const)));
    data = ogData(d, metas);
  } catch (e) {
    if (!(e instanceof RpcError && e.rpcName === "UNKNOWN_ACCOUNT")) return fail(503, "rpc_unavailable", "The NEAR RPC could not be read.", { "retry-after": "5" });
    // No such account: still a picture, saying so, with a 404 so it is not mistaken for a fund.
    status = 404;
    data = { title: id, network, keys: { text: "no such account", tone: "bad" }, release: { text: "unknown code", tone: "bad" }, holdings: [], trades: "–", refusals: "–", footer: "this account does not exist on " + network, isFund: false };
  }
  try {
    const png = await draw(data);
    return new Response(png as any, { status, headers: { "content-type": "image/png", "cache-control": status === 200 ? OG_CACHE : "public, max-age=0, s-maxage=20", "x-content-type-options": "nosniff", ...CORS } });
  } catch (e) {
    console.error("og render failed:", (e as Error)?.message);
    return fail(500, "render_failed", "The image could not be drawn.");
  }
}
