// Token names, decimals and amounts. Decimals and symbols come from the token itself (ft_metadata);
// the small table below is only for tokens that do not answer it (the test dollar) and for the
// recorded runs, which render before any network read.
import { view, type Net } from "./chain.ts";

interface Meta {
  decimals: number;
  symbol: string;
}
const KNOWN: Record<string, Meta> = {
  "pusd.plinthfund.testnet": { decimals: 6, symbol: "pUSD" },
  "wrap.testnet": { decimals: 24, symbol: "wNEAR" },
  "wrap.near": { decimals: 24, symbol: "wNEAR" },
  "meta-v2.pool.testnet": { decimals: 24, symbol: "stNEAR" },
  "meta-pool.near": { decimals: 24, symbol: "stNEAR" },
};
/** Read from the chain in this session. */
const META: Record<string, Meta> = {};
const asked = new Map<string, Promise<void>>();

const shortName = (t: string) => (/^[0-9a-f]{64}$/.test(t) ? `${t.slice(0, 6)}…` : t.split(".")[0].slice(0, 12));

/** Read ft_metadata of one token; null when the account is not a token that answers it. */
export async function readMeta(net: Net, token: string): Promise<Meta | null> {
  const m = await view<any>(net, token, "ft_metadata").catch(() => null);
  if (!m || !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 36) return null;
  // Keep the names people know for the wrapped and staked NEAR tokens (the chain says STNEAR).
  const symbol = KNOWN[token]?.symbol ?? (String(m.symbol ?? "").replace(/[^\w.$-]/g, "").slice(0, 12) || shortName(token));
  return { decimals: m.decimals, symbol };
}

export function loadMeta(net: Net, tokens: string[]): Promise<void> {
  return Promise.all(
    tokens.map((t) => {
      const key = `${net}:${t}`;
      if (!asked.has(key))
        asked.set(
          key,
          readMeta(net, t).then((m) => {
            if (m) META[t] = m;
          }),
        );
      return asked.get(key)!;
    }),
  ).then(() => {});
}

/** True when the decimals of this token are known (from the chain or the table). */
export const hasMeta = (t: string) => !!(META[t] ?? KNOWN[t]);
export const symbol = (t: string) => (META[t] ?? KNOWN[t])?.symbol ?? (t.startsWith("pusd.") ? "pUSD" : shortName(t));
export const dec = (t: string) => (META[t] ?? KNOWN[t])?.decimals ?? (t.startsWith("pusd.") ? 6 : 0);

/** "1,234.5" from whole units and decimals; at most `digits` fraction digits, cut, never rounded up. */
export function units(v: string | bigint, decimals: number, digits = 4): string {
  const n = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const out = `${(n / base).toLocaleString("en")}${frac ? "." + frac : ""}`;
  // Something is there but too small to show at this precision: say so instead of "0".
  return n > 0n && out === "0" ? `under ${digits > 0 ? "0." + "0".repeat(digits - 1) + "1" : "1"}` : out;
}
export function fmt(t: string, v: string | bigint, digits = 4): string {
  return `${units(v, dec(t), digits)} ${symbol(t)}`;
}
/** The exact amount with every digit, for filling an input ("12.5", no thousands separators). */
export function plain(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / base}${frac ? "." + frac : ""}`;
}
/** "12.5" to whole units; null when it is not a plain positive number with at most `decimals` digits. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const v = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(v)) return null;
  const [w, d = ""] = v.split(".");
  if (d.length > decimals) return null;
  if (w.length > 30) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((d + "0".repeat(decimals)).slice(0, decimals) || "0");
}
/** a / b as a percent with up to two decimals, cut. */
export function pct(a: bigint, b: bigint): string {
  if (b === 0n) return "0%";
  const x = (a * 10000n) / b;
  if (a > 0n && x === 0n) return "under 0.01%";
  return `${x / 100n}${x % 100n ? "." + (x % 100n).toString().padStart(2, "0").replace(/0$/, "") : ""}%`;
}
/** Hundredths of a percent (how the contract stores its limits) as "1.5%". */
export const pctOf = (hundredths: number) => `${Number((hundredths / 100).toFixed(2))}%`;

// ---------------------------------------------------------------- indicative prices
// 1Click's public token list has USD prices for mainnet tokens. Testnet tokens are shown at the
// price of their mainnet namesake; the test dollar counts as 1. Indicative only.
const NAMESAKE: Record<string, string> = { "wrap.testnet": "wrap.near", "meta-v2.pool.testnet": "meta-pool.near", "wrap.near": "wrap.near", "meta-pool.near": "meta-pool.near" };
let prices: Record<string, number> | null = null;
let pricesAsked: Promise<Record<string, number> | null> | null = null;
const ONECLICK_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const getList = (url: string): Promise<any[]> =>
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no prices"))))
    .then((list) => (Array.isArray(list) ? list : Promise.reject(new Error("no prices"))));
export function loadPrices(): Promise<Record<string, number> | null> {
  // The optional API serves the same list from its cache; without it, or if it fails, ask 1Click.
  const api = import.meta.env.VITE_PLINTH_API as string | undefined;
  const first = typeof api === "string" ? getList(`${api.replace(/\/$/, "")}/api/tokens`).catch(() => getList(ONECLICK_TOKENS)) : getList(ONECLICK_TOKENS);
  return (pricesAsked ??= first
    .then((list: any[]) => {
      const out: Record<string, number> = {};
      for (const t of list) if (t?.blockchain === "near" && typeof t.contractAddress === "string" && Number.isFinite(t.price) && t.price > 0) out[t.contractAddress] = t.price;
      return (prices = Object.keys(out).length ? out : null);
    })
    .catch(() => null));
}
/** USD value of an amount at mainnet prices, or null when there is no price for this token. */
export function usd(t: string, v: string | bigint): number | null {
  const n = Number(BigInt(v)) / 10 ** dec(t);
  if (BigInt(v) === 0n) return 0;
  if (t.startsWith("pusd.")) return n;
  const p = prices?.[NAMESAKE[t] ?? ""];
  return p ? n * p : null;
}
export const havePrices = () => !!prices;
export const money = (x: number) => (x > 0 && x < 0.01 ? "under $0.01" : `$${x.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
