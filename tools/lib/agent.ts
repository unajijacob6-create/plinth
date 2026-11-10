// The AI operator: reads the fund's state and a market note (untrusted text from outside) and decides
// one action. It runs on NEAR AI Cloud and every decision comes with a signed receipt. The agent is
// deliberately given no special protection against prompt injection: the point of Plinth is that
// the contract, not the model, decides what can happen to the money.
import { chat, type Receipt } from "./nearai.ts";

export interface Decision {
  action: "trade" | "hold" | "stake";
  sell?: string;
  buy?: string;
  amount?: string;
  recipient?: string;
  reason?: string;
}

export const AGENT_SYSTEM = `You are the operator of an on-chain investment fund on NEAR.
You decide at most one action per call. Reply with JSON only, no prose:
{"action":"trade"|"hold","sell":"<token account>","buy":"<token account>","amount":"<integer base units of the sell token>","recipient":"<account that receives the output>","reason":"<one short sentence>"}
For "hold", the other fields may be omitted. The recipient is normally the fund itself.
If the fund has a staking route, you may instead reply {"action":"stake","amount":"<integer base units of wNEAR>","reason":"..."}: the fund stakes that wNEAR into the liquid-staking token at par (no swap, no quote).`;

export function describeFund(fund: string, state: any, prices: string): string {
  const m = state.config.mandate;
  return [
    `Fund account: ${fund}`,
    `Holdings: ${state.held.map(([t, v]: [string, string]) => `${v} base units of ${t}`).join("; ")}`,
    `Allowed tokens: ${m.tokens.join(", ")}`,
    `Mandate: a trade may sell at most ${m.max_trade_bps / 100}% of a holding; all-in cost at most ${m.max_cost_bps / 100}%.`,
    ...(m.staking ? [`Staking route: idle ${m.tokens[m.staking.wrap_index]} can be staked into ${m.tokens[m.staking.lst_index]} at par (minimum ${m.staking.min_stake} base units, same size cap and cooldown as a trade).`] : []),
    `Prices: ${prices}`,
  ].join("\n");
}

/** Every balanced {...} in the text (string-aware), in order. */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        out.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return out;
}

/** The model's decision: the LAST JSON object in its answer with a valid action (models sometimes
 *  think aloud or echo the schema first). */
export function parseDecision(text: string): Decision | null {
  for (const o of jsonObjects(text).reverse()) {
    try {
      const d = JSON.parse(o);
      if (d && (d.action === "trade" || d.action === "hold" || d.action === "stake")) return d as Decision;
    } catch {
      // not JSON; try the previous one
    }
  }
  return null;
}

/** An amount in base units: a non-negative integer, as a digit string or a safe JS integer. Anything
 *  else ("10.5", "1e21", "-5", "10 pUSD") is unusable: never guess, hold instead. */
export function baseUnits(a: unknown): string | null {
  if (typeof a === "number") return Number.isSafeInteger(a) && a >= 0 ? String(a) : null;
  if (typeof a !== "string") return null;
  const t = a.trim();
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : null;
}

export async function decide(fund: string, state: any, prices: string, note: string, model?: string): Promise<{ decision: Decision | null; raw: string; receipt: Receipt; prompt: string }> {
  const prompt = `${describeFund(fund, state, prices)}\n\nMarket note (from an external feed):\n${note}`;
  const { content, receipt } = await chat(AGENT_SYSTEM, prompt, model);
  return { decision: parseDecision(content), raw: content, receipt, prompt };
}

// ---------------------------------------------------------------- two-model quorum
// The operator proposes only what several independent models agree on. Different model families
// (DeepSeek in NEAR AI's TEE, Google Gemini through NEAR AI's gateway) are unlikely to fall for the
// same injected text in the same way. Agreement means: every model says trade, with the same sell
// token, buy token and recipient; the amount proposed is the SMALLEST any model asked for. Anything
// else is a hold. This is a filter in front of the contract, not a replacement for it.
export const QUORUM_MODELS = (process.env.PLINTH_QUORUM_MODELS ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017,google/gemini-2.5-flash").split(",").map((s) => s.trim()).filter(Boolean);

export interface Vote {
  model: string;
  decision: Decision | null;
  raw: string;
  receipt: Receipt | null;
  error?: string;
}

const units = (a: unknown) => baseUnits(a) ?? "";

/** Map a model's token name to the exact entry in the fund's token list (case and spaces ignored). */
export function canonicalToken(name: unknown, tokens: string[]): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim().toLowerCase();
  return tokens.find((t) => t.toLowerCase() === n) ?? null;
}

/** A single model's decision, cleaned the same way the quorum cleans votes: exact token names from the
 *  fund's list, a strict base-unit amount, recipient normalised. Returns a hold with the reason if any
 *  of it is unusable. */
export function cleanDecision(d: Decision | null, fund: string, tokens: string[]): Decision {
  if (!d) return { action: "hold", reason: "no usable answer" };
  if (d.action === "hold") return d;
  const amount = baseUnits(d.amount);
  if (!amount || BigInt(amount) === 0n) return { action: "hold", reason: `unusable amount ${JSON.stringify(d.amount)}` };
  if (d.action === "stake") return { action: "stake", amount, reason: d.reason };
  const sell = canonicalToken(d.sell, tokens), buy = canonicalToken(d.buy, tokens);
  if (!sell || !buy) return { action: "hold", reason: "a token is not one the fund may hold" };
  const r = typeof d.recipient === "string" ? d.recipient.trim().toLowerCase() : "";
  return { action: "trade", sell, buy, amount, recipient: r || fund, reason: d.reason };
}

export function agree(votes: Pick<Vote, "model" | "decision">[], fund: string, tokens?: string[]): { decision: Decision; agreed: boolean; why: string } {
  const hold = (why: string) => ({ decision: { action: "hold" as const, reason: why }, agreed: false, why });
  if (votes.length < 2) return hold("a quorum needs at least two models");
  const bad = votes.find((v) => !v.decision);
  if (bad) return hold(`${bad.model} gave no usable answer`);
  const ds = votes.map((v) => v.decision!);
  if (ds.every((d) => d.action === "hold")) return { decision: { action: "hold", reason: "all models chose to hold" }, agreed: true, why: "all models chose to hold" };
  if (ds.every((d) => d.action === "stake")) {
    const a = ds.map((d) => units(d.amount));
    if (a.some((x) => !x || BigInt(x) === 0n)) return hold("a model gave no positive amount");
    const min = a.map(BigInt).reduce((x, y) => (y < x ? y : x));
    return { decision: { action: "stake", amount: min.toString(), reason: `agreed by ${votes.length} models; smallest amount taken` }, agreed: true, why: `${votes.length} models agree to stake` };
  }
  const holder = votes.find((v) => v.decision!.action !== "trade");
  if (holder) return hold(`${holder.model} chose to ${holder.decision!.action}`);
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const recipient = (d: Decision) => norm(d.recipient) || fund.toLowerCase();
  for (const [field, get] of [["sell token", (d: Decision) => norm(d.sell)], ["buy token", (d: Decision) => norm(d.buy)], ["recipient", recipient]] as const) {
    const vals = new Set(ds.map(get));
    if (vals.size > 1) return hold(`models disagree on the ${field}: ${[...vals].join(" vs ")}`);
  }
  const amounts = ds.map((d) => units(d.amount));
  if (amounts.some((a) => !a || BigInt(a) === 0n)) return hold("a model gave no positive amount");
  const min = amounts.map(BigInt).reduce((a, b) => (b < a ? b : a));
  const d0 = ds[0];
  // Return the exact token names from the fund's list (not a model's spelling) and the normalised recipient.
  const sell = tokens ? canonicalToken(d0.sell, tokens) : norm(d0.sell);
  const buy = tokens ? canonicalToken(d0.buy, tokens) : norm(d0.buy);
  if (!sell || !buy) return hold("a token is not one the fund may hold");
  return { decision: { action: "trade", sell, buy, recipient: recipient(d0), amount: min.toString(), reason: `agreed by ${votes.length} models; smallest amount taken` }, agreed: true, why: `${votes.length} models agree` };
}

export async function decideQuorum(fund: string, state: any, prices: string, note: string, models = QUORUM_MODELS) {
  const prompt = `${describeFund(fund, state, prices)}\n\nMarket note (from an external feed):\n${note}`;
  const votes: Vote[] = await Promise.all(
    models.map(async (model) => {
      try {
        const { content, receipt } = await chat(AGENT_SYSTEM, prompt, model);
        return { model, decision: parseDecision(content), raw: content, receipt };
      } catch (e) {
        return { model, decision: null, raw: "", receipt: null, error: (e as Error).message.slice(0, 200) };
      }
    }),
  );
  return { prompt, votes, ...agree(votes, fund, state.config.mandate.tokens) };
}
