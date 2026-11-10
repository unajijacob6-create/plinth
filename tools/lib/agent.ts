// The AI operator: reads the fund's state and a market note (untrusted text from outside) and decides
// one action. It runs on NEAR AI Cloud and every decision comes with a signed receipt. The agent is
// deliberately given no special protection against prompt injection: the point of Plinth is that
// the contract, not the model, decides what can happen to the money.
import { chat, type Receipt } from "./nearai.ts";

export interface Decision {
  action: "trade" | "hold";
  sell?: string;
  buy?: string;
  amount?: string;
  recipient?: string;
  reason?: string;
}

export const AGENT_SYSTEM = `You are the operator of an on-chain investment fund on NEAR.
You decide at most one action per call. Reply with JSON only, no prose:
{"action":"trade"|"hold","sell":"<token account>","buy":"<token account>","amount":"<integer base units of the sell token>","recipient":"<account that receives the output>","reason":"<one short sentence>"}
For "hold", the other fields may be omitted. The recipient is normally the fund itself.`;

export function describeFund(fund: string, state: any, prices: string): string {
  const m = state.config.mandate;
  return [
    `Fund account: ${fund}`,
    `Holdings: ${state.held.map(([t, v]: [string, string]) => `${v} base units of ${t}`).join("; ")}`,
    `Allowed tokens: ${m.tokens.join(", ")}`,
    `Mandate: a trade may sell at most ${m.max_trade_bps / 100}% of a holding; all-in cost at most ${m.max_cost_bps / 100}%.`,
    `Prices: ${prices}`,
  ].join("\n");
}

export function parseDecision(text: string): Decision | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    if (d.action !== "trade" && d.action !== "hold") return null;
    return d as Decision;
  } catch {
    return null;
  }
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

const units = (a: unknown) => (typeof a === "number" && Number.isSafeInteger(a) ? String(a) : typeof a === "string" ? a.replace(/\D/g, "") : "");

export function agree(votes: Pick<Vote, "model" | "decision">[], fund: string): { decision: Decision; agreed: boolean; why: string } {
  const hold = (why: string) => ({ decision: { action: "hold" as const, reason: why }, agreed: false, why });
  if (votes.length < 2) return hold("a quorum needs at least two models");
  const bad = votes.find((v) => !v.decision);
  if (bad) return hold(`${bad.model} gave no usable answer`);
  const ds = votes.map((v) => v.decision!);
  if (ds.every((d) => d.action === "hold")) return { decision: { action: "hold", reason: "all models chose to hold" }, agreed: true, why: "all models chose to hold" };
  const holder = votes.find((v) => v.decision!.action !== "trade");
  if (holder) return hold(`${holder.model} chose to hold`);
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
  return { decision: { action: "trade", sell: d0.sell, buy: d0.buy, recipient: d0.recipient || fund, amount: min.toString(), reason: `agreed by ${votes.length} models; smallest amount taken` }, agreed: true, why: `${votes.length} models agree` };
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
  return { prompt, votes, ...agree(votes, fund) };
}
