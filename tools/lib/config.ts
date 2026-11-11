// The fund's launch configuration (`Config` in contracts/plinth/src/lib.rs), typed, with the checks
// `new()` makes repeated off-chain so a fund that would be refused is never paid for. Pure: no
// network access, so it is unit-tested (tools/test/config.test.ts).
import { ed25519KeyBytes, ONECLICK_KEY } from "./oneclick.ts";
import { UsageError, type Args } from "./args.ts";

export interface StakingRoute {
  wrap_index: number;
  lst_index: number;
  price_method: string;
  min_stake: string;
  max_price_slippage_bps: number;
}

export interface Strategy {
  outlayer: string;
  wasm_url: string;
  /** sha256 of the strategy wasm, 64 lowercase hex characters. */
  wasm_hash: string;
  max_instructions: number;
  max_execution_seconds: number;
  secrets_profile?: string | null;
  secrets_owner?: string | null;
  /** true: only the strategy proposes; the operator account only receives the fee. */
  exclusive: boolean;
}

export interface Mandate {
  tokens: string[];
  max_trade_bps: number;
  max_cost_bps: number;
  min_seconds_between_trades: number;
  max_trades_per_day: number;
  max_quote_age_seconds: number;
  min_deadline_margin_seconds: number;
  /** Unix seconds. */
  subscription_closes_at: number;
  min_subscription: string;
  max_total_subscriptions: string;
  management_fee_bps: number;
  staking: StakingRoute | null;
  open_ended: boolean;
  strategy: Strategy | null;
}

export interface Config {
  mandate: Mandate;
  operator: string;
  quote_signer: string;
  /** yoctoNEAR attached to each NEP-145 storage_deposit. */
  storage_deposit: string;
}

/** 0.00125 NEAR: the NEP-145 registration of wrap.near, Meta Pool and most NEP-141 tokens. */
export const DEFAULT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** factory `MIN_FUND_NEAR`: what a new fund must start with besides its token registrations. */
export const MIN_FUND_NEAR = 500_000_000_000_000_000_000_000n;
export const MAX_TOKENS = 4;
export const MAX_MANAGEMENT_FEE_BPS = 200;
/** lib.rs REDEEM_WAIT_SECONDS + 60. */
export const MIN_SECONDS_BETWEEN_TRADES = 660;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/** NEAR account id rules (2-64 of a-z 0-9 with single - _ . separators). */
export const isAccountId = (s: unknown): s is string => typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
const isUint = (v: unknown, max: bigint): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && BigInt(v) <= max;
const isUnits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v) && BigInt(v) <= U128_MAX;

const MANDATE_KEYS = ["tokens", "max_trade_bps", "max_cost_bps", "min_seconds_between_trades", "max_trades_per_day", "max_quote_age_seconds", "min_deadline_margin_seconds", "subscription_closes_at", "min_subscription", "max_total_subscriptions", "management_fee_bps", "staking", "open_ended", "strategy"];
const STAKING_KEYS = ["wrap_index", "lst_index", "price_method", "min_stake", "max_price_slippage_bps"];
const STRATEGY_KEYS = ["outlayer", "wasm_url", "wasm_hash", "max_instructions", "max_execution_seconds", "secrets_profile", "secrets_owner", "exclusive"];

function unknownKeys(obj: object, known: string[], where: string, out: string[]) {
  // The contract ignores fields it does not know, so a misspelt option would silently be off.
  for (const k of Object.keys(obj)) if (!known.includes(k)) out.push(`${where}.${k} is not a field the contract reads`);
}

/** Every reason `new(config)` would refuse this config (or silently differ from it). Empty = valid.
 *  `fund` is the account the fund will have, `nowS` the chain time. */
export function validateConfig(c: unknown, fund: string, nowS: number): string[] {
  const why: string[] = [];
  const cfg = c as Config;
  if (!cfg || typeof cfg !== "object" || !cfg.mandate || typeof cfg.mandate !== "object") return ["config must be {mandate, operator, quote_signer, storage_deposit}"];
  unknownKeys(cfg, ["mandate", "operator", "quote_signer", "storage_deposit"], "config", why);
  const m = cfg.mandate;
  unknownKeys(m, MANDATE_KEYS, "mandate", why);

  if (!Array.isArray(m.tokens) || m.tokens.length < 1 || m.tokens.length > MAX_TOKENS) why.push(`tokens: 1 to ${MAX_TOKENS} token accounts`);
  else {
    m.tokens.forEach((t, i) => {
      if (!isAccountId(t)) why.push(`tokens[${i}] ${JSON.stringify(t)} is not a NEAR account id`);
      if (m.tokens.indexOf(t) !== i) why.push(`duplicate token ${t}`);
      if (t === fund) why.push("the fund cannot list itself");
    });
  }
  const n = Array.isArray(m.tokens) ? m.tokens.length : 0;
  if (!isUint(m.max_trade_bps, 10_000n) || m.max_trade_bps < 1) why.push("max_trade_bps must be 1..=10000");
  if (!isUint(m.max_cost_bps, 10_000n)) why.push("max_cost_bps must be 0..=10000");
  if (!isUint(m.max_quote_age_seconds, U64_MAX) || m.max_quote_age_seconds < 1) why.push("max_quote_age_seconds must be > 0");
  if (!isUint(m.min_seconds_between_trades, U64_MAX) || m.min_seconds_between_trades < MIN_SECONDS_BETWEEN_TRADES) why.push(`min_seconds_between_trades must be at least ${MIN_SECONDS_BETWEEN_TRADES}`);
  if (!isUint(m.max_trades_per_day, 0xffff_ffffn) || m.max_trades_per_day < 1) why.push("max_trades_per_day must be > 0");
  if (!isUint(m.min_deadline_margin_seconds, U64_MAX)) why.push("min_deadline_margin_seconds must be a whole number of seconds");
  if (!isUint(m.subscription_closes_at, U64_MAX)) why.push("subscription_closes_at must be Unix seconds");
  else if (m.subscription_closes_at <= nowS) why.push("subscription must close in the future");
  if (!isUnits(m.min_subscription) || !isUnits(m.max_total_subscriptions)) why.push("min_subscription and max_total_subscriptions must be base-unit digit strings");
  else if (BigInt(m.min_subscription) === 0n || BigInt(m.min_subscription) > BigInt(m.max_total_subscriptions)) why.push("bad subscription limits: 0 < min_subscription <= max_total_subscriptions");
  if (!isUint(m.management_fee_bps, BigInt(MAX_MANAGEMENT_FEE_BPS))) why.push(`management_fee_bps must be 0..=${MAX_MANAGEMENT_FEE_BPS}`);
  if (typeof m.open_ended !== "boolean") why.push("open_ended must be true or false");

  if (m.staking !== null && m.staking !== undefined) {
    const r = m.staking;
    if (typeof r !== "object") why.push("staking must be an object or null");
    else {
      unknownKeys(r, STAKING_KEYS, "staking", why);
      if (!isUint(r.wrap_index, 255n) || !isUint(r.lst_index, 255n) || r.wrap_index >= n || r.lst_index >= n || r.wrap_index === r.lst_index) why.push("bad staking token indices: two different positions in tokens");
      if (typeof r.price_method !== "string" || r.price_method.length < 1 || r.price_method.length > 64) why.push("staking.price_method must be 1 to 64 characters");
      if (!isUnits(r.min_stake)) why.push("staking.min_stake must be a base-unit digit string");
      if (!isUint(r.max_price_slippage_bps, 500n) || r.max_price_slippage_bps < 1) why.push("staking.max_price_slippage_bps must be 1..=500");
    }
  }
  if (m.strategy !== null && m.strategy !== undefined) {
    const s = m.strategy;
    if (typeof s !== "object") why.push("strategy must be an object or null");
    else {
      unknownKeys(s, STRATEGY_KEYS, "strategy", why);
      if (!isAccountId(s.outlayer)) why.push("strategy.outlayer is not a NEAR account id");
      else if (s.outlayer === fund) why.push("strategy.outlayer cannot be the fund");
      if (typeof s.wasm_url !== "string" || !s.wasm_url.startsWith("https://") || Buffer.byteLength(s.wasm_url) > 512) why.push("strategy.wasm_url must be https and at most 512 bytes");
      if (typeof s.wasm_hash !== "string" || !/^[0-9a-f]{64}$/.test(s.wasm_hash)) why.push("strategy.wasm_hash must be 64 lowercase hex characters (sha256 of the strategy wasm)");
      if (!isUint(s.max_instructions, U64_MAX) || s.max_instructions < 1) why.push("strategy.max_instructions must be a whole number > 0 (below 2^53 in JSON)");
      if (!isUint(s.max_execution_seconds, 120n) || s.max_execution_seconds < 1) why.push("strategy.max_execution_seconds must be 1..=120");
      const profile = s.secrets_profile ?? null, owner = s.secrets_owner ?? null;
      if ((profile === null) !== (owner === null)) why.push("strategy secrets need both a profile and an owner");
      if (profile !== null && typeof profile !== "string") why.push("strategy.secrets_profile must be text");
      if (owner !== null && !isAccountId(owner)) why.push("strategy.secrets_owner is not a NEAR account id");
      if (typeof s.exclusive !== "boolean") why.push("strategy.exclusive must be true or false");
    }
  }
  if (!isAccountId(cfg.operator)) why.push(`operator ${JSON.stringify(cfg.operator)} is not a NEAR account id`);
  else if (cfg.operator === fund) why.push("the fund cannot be its own operator");
  if (!ed25519KeyBytes(cfg.quote_signer)) why.push("quote_signer is not an ed25519 key (base58, 32 bytes)");
  if (!isUnits(cfg.storage_deposit)) why.push("storage_deposit must be a yoctoNEAR digit string");
  return why;
}

/** Fund names the factory accepts: 2 to 32 of a-z, 0-9 and -, not starting or ending with -. */
export function validateFundName(name: string, factory: string): string[] {
  const why: string[] = [];
  if (!/^[a-z0-9-]{2,32}$/.test(name) || name.startsWith("-") || name.endsWith("-")) why.push("name: 2 to 32 of a-z, 0-9 and -, not starting or ending with -");
  else if (!isAccountId(`${name}.${factory}`)) why.push(`${name}.${factory} is not a valid account id (64 characters at most, no "--")`);
  return why;
}

/** `--closes`: an ISO date or date-time (UTC if no zone is given), or `+<seconds>` from now. */
export function parseCloses(v: string, nowS: number): number {
  if (/^\+\d+$/.test(v)) return nowS + Number(v.slice(1));
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v) ? `${v}Z` : v;
  const ms = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(iso) ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) throw new UsageError(`--closes ${v}: use an ISO date (2026-12-01 or 2026-12-01T12:00:00Z) or +<seconds>`);
  return Math.floor(ms / 1000);
}

/** NEAR written as a decimal ("1", "0.75") to yoctoNEAR, exactly. */
export function parseNear(v: string, flag = "--near"): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(v);
  if (!m) throw new UsageError(`${flag} ${v}: a decimal amount of NEAR, e.g. 1 or 0.75`);
  return BigInt(m[1]) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** What `factory.create_fund` needs attached: `near` for the fund plus one registration per token. */
export function creationDeposit(c: Config, near: bigint): { registrations: bigint; total: bigint } {
  if (near < MIN_FUND_NEAR) throw new UsageError("the factory needs at least 0.5 NEAR for the fund (besides its token registrations)");
  const registrations = BigInt(c.storage_deposit) * BigInt(c.mandate.tokens.length);
  return { registrations, total: near + registrations };
}

const intFlag = (a: Args, flag: string, dflt?: number): number => {
  const v = a.values[flag];
  if (v === undefined) {
    if (dflt === undefined) throw new UsageError(`${flag} is required`);
    return dflt;
  }
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new UsageError(`${flag} ${v}: a whole number`);
  return Number(v);
};
const need = (a: Args, flag: string): string => {
  const v = a.values[flag];
  if (v === undefined) throw new UsageError(`${flag} is required`);
  return v;
};

/** The flags `configFromFlags` reads, for parseArgs. */
export const CONFIG_VALUE_FLAGS = ["--tokens", "--operator", "--closes", "--fee-bps", "--staking", "--strategy-json", "--min-subscription", "--max-subscriptions", "--max-trade-bps", "--max-cost-bps", "--cooldown", "--trades-per-day", "--quote-age", "--deadline-margin", "--quote-signer", "--storage-deposit"];
export const CONFIG_SWITCH_FLAGS = ["--open-ended"];

export const CONFIG_FLAGS_HELP = `  --tokens <a,b,..>          1 to 4 NEP-141 token accounts; the first is the base token people subscribe in
  --operator <account>       the only account that may propose trades (and receives the fee)
  --closes <when>            end of the subscription window: ISO date/time (UTC) or +<seconds>
  --min-subscription <units> smallest subscription, base-token units
  --max-subscriptions <units> largest total subscriptions, base-token units
  --open-ended               allow in-kind joins after the window closes
  --fee-bps <n>              yearly management fee in basis points, 0..200 (default 0)
  --staking <W:L | json>     staking route: token positions of wNEAR and the liquid-staking token with
                             Meta Pool's settings (get_st_near_price, 1 NEAR minimum, 50 bps), or the full
                             route as JSON text or a path to a JSON file
  --strategy-json <file>     a Strategy object (outlayer, wasm_url, wasm_hash, max_instructions,
                             max_execution_seconds, exclusive[, secrets_profile, secrets_owner])
  --quote-signer <key>       oneclick (default on mainnet), test (this machine's test key; default on
                             testnet) or an ed25519 public key
  --max-trade-bps <n>        largest trade, bps of the holding sold (default 2500)
  --max-cost-bps <n>         largest all-in cost of a trade, bps (default 150)
  --cooldown <s>             seconds between trades, at least 660 (default 660)
  --trades-per-day <n>       (default 6)
  --quote-age <s>            oldest quote accepted, seconds (default 300)
  --deadline-margin <s>      the deposit address must stay open this long, seconds (default 600)
  --storage-deposit <yocto>  NEAR per token registration (default 1250000000000000000000 = 0.00125 NEAR)`;

export interface ConfigEnv {
  network: "testnet" | "mainnet";
  nowS: number;
  /** Reads a file as text (injected so the builder stays pure in tests). */
  readFile: (path: string) => string;
  /** The machine's test quote signer public key; only asked for when it is needed. */
  testSignerKey: () => string;
}

/** A flag whose value is JSON text or the path of a JSON file. */
function jsonFlag(text: string, flag: string, env: ConfigEnv): unknown {
  try {
    return JSON.parse(text.trim().startsWith("{") ? text : env.readFile(text));
  } catch (e) {
    throw new UsageError(`${flag}: ${(e as Error).message}`);
  }
}

/** Build a Config from command-line flags. Throws UsageError on a missing or malformed flag; run
 *  `validateConfig` on the result for the contract's own rules. */
export function configFromFlags(a: Args, env: ConfigEnv): Config {
  const tokens = need(a, "--tokens").split(",").map((t) => t.trim()).filter(Boolean);
  let staking: StakingRoute | null = null;
  const st = a.values["--staking"];
  if (st !== undefined) {
    const m = /^(\d):(\d)$/.exec(st);
    staking = m
      ? { wrap_index: Number(m[1]), lst_index: Number(m[2]), price_method: "get_st_near_price", min_stake: "1000000000000000000000000", max_price_slippage_bps: 50 }
      : (jsonFlag(st, "--staking", env) as StakingRoute);
  }
  let strategy: Strategy | null = null;
  if (a.values["--strategy-json"] !== undefined) {
    try {
      strategy = JSON.parse(env.readFile(a.values["--strategy-json"])) as Strategy;
    } catch (e) {
      throw new UsageError(`--strategy-json ${a.values["--strategy-json"]}: ${(e as Error).message}`);
    }
  }
  const qs = a.values["--quote-signer"] ?? (env.network === "mainnet" ? "oneclick" : "test");
  if (qs === "test" && env.network === "mainnet") throw new UsageError("--quote-signer test is for testnet: a mainnet fund must use the 1Click key");
  const units = (flag: string) => {
    const v = need(a, flag);
    if (!/^\d+$/.test(v)) throw new UsageError(`${flag} ${v}: base units, digits only`);
    return v;
  };
  return {
    mandate: {
      tokens,
      max_trade_bps: intFlag(a, "--max-trade-bps", 2500),
      max_cost_bps: intFlag(a, "--max-cost-bps", 150),
      min_seconds_between_trades: intFlag(a, "--cooldown", MIN_SECONDS_BETWEEN_TRADES),
      max_trades_per_day: intFlag(a, "--trades-per-day", 6),
      max_quote_age_seconds: intFlag(a, "--quote-age", 300),
      min_deadline_margin_seconds: intFlag(a, "--deadline-margin", 600),
      subscription_closes_at: parseCloses(need(a, "--closes"), env.nowS),
      min_subscription: units("--min-subscription"),
      max_total_subscriptions: units("--max-subscriptions"),
      management_fee_bps: intFlag(a, "--fee-bps", 0),
      staking,
      open_ended: a.switches.has("--open-ended"),
      strategy,
    },
    operator: need(a, "--operator"),
    quote_signer: qs === "oneclick" ? ONECLICK_KEY : qs === "test" ? env.testSignerKey() : qs,
    storage_deposit: a.values["--storage-deposit"] ?? String(DEFAULT_STORAGE_DEPOSIT),
  };
}

/** A config with every optional field written out, as the contract will store it. */
export function normaliseConfig(c: Config): Config {
  return { ...c, mandate: { ...c.mandate, management_fee_bps: c.mandate.management_fee_bps ?? 0, staking: c.mandate.staking ?? null, open_ended: c.mandate.open_ended ?? false, strategy: c.mandate.strategy ?? null } };
}
