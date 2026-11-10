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
