// npm run operate -- --fund <fund> [--network mainnet] [--note "text" | --note-file path] [--operator <account>] [--quorum] [--dry]
//
// --quorum: DeepSeek (NEAR AI TEE) and Gemini (NEAR AI gateway) must both say trade with the same tokens
// and recipient; the smaller amount is used (PLINTH_QUORUM_MODELS to change the models).
//
// One round of an AI-operated fund on mainnet (or any network with NEAR Intents 1Click):
//   1. the AI operator (NEAR AI Cloud, signed receipt) reads the fund and the note and decides;
//   2. a hold ends the round; a trade is turned into a LIVE 1Click quote for the fund
//      (recipient and refund address are always the fund: the tool does not take those from the model);
//   3. the quote is checked off-chain exactly as the contract will check it; --dry stops here;
//   4. it is proposed; the round then waits for 1Click and settles.
// The contract is the final check either way. Mainnet signing needs PLINTH_MAINNET=yes.
import fs from "node:fs";
const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (opt("--network")) process.env.NEAR_NETWORK = opt("--network");
const { signer, view, TGAS, explorer, txHash, log } = await import("./lib/near.ts");
const { requestQuote, preflight, costBps, status } = await import("./lib/oneclick.ts");
const { decide, decideQuorum } = await import("./lib/agent.ts");
const { verifyReceipt } = await import("./lib/nearai.ts");

const fund = opt("--fund");
if (!fund) {
  console.error("usage: npm run operate -- --fund <fund> [--network mainnet] [--note text | --note-file path] [--dry]");
  process.exit(2);
}
const note = opt("--note") ?? (opt("--note-file") ? fs.readFileSync(opt("--note-file")!, "utf8") : "No news. Keep the fund within its mandate.");
const state = await view<any>(fund, "get_fund");
const tokens: string[] = state.config.mandate.tokens;

// Prices for the model: a dry 1Click quote of 1 unit-ish of each pair, so the agent sees real rates.
const prices: string[] = [];
for (const [i, t] of tokens.entries()) {
  for (const u of tokens.slice(i + 1)) {
    const held = BigInt(state.held[i][1]);
    if (held === 0n) continue;
    try {
      const q = await requestQuote({ fund, sellToken: t, buyToken: u, amount: String(held / 100n || 1n), dry: true });
      prices.push(`${q.quote.amountIn} ${t} -> ${q.quote.amountOut} ${u} (about $${q.quote.amountInUsd})`);
    } catch (e) {
      prices.push(`${t} -> ${u}: no quote (${(e as Error).message.slice(0, 60)})`);
    }
  }
}
const priceText = prices.join("; ") || "no prices available";
let d: { decision: any; raw: string; receipt?: any; votes?: any[] };
if (argv.includes("--quorum")) {
  const q = await decideQuorum(fund, state, priceText, note);
  for (const v of q.votes) {
    const rv = v.receipt ? verifyReceipt(v.receipt) : null;
    log(`${v.model} said`, `${v.raw.slice(0, 200)} · receipt ${rv ? `${rv.kind} ${rv.ok ? "verified" : "NOT verified"}` : `none (${v.error})`}`);
  }
  log("quorum", `${q.decision.action}: ${q.why}`);
  d = { decision: q.decision, raw: JSON.stringify(q.decision), votes: q.votes };
} else {
  const one = await decide(fund, state, priceText, note);
  const rv = verifyReceipt(one.receipt);
  log("operator decided", one.raw.slice(0, 300));
  log("NEAR AI receipt", `${one.receipt.chat_id} ${rv.ok ? "verified" : "NOT verified"} (${rv.checks.join("; ")})`);
  d = one;
}
const record: any = { at: new Date().toISOString(), fund, note, decision: d.decision, raw: d.raw, receipt: d.receipt, votes: d.votes };
const save = () => {
  fs.mkdirSync("data", { recursive: true });
  fs.appendFileSync(`data/operate-${process.env.NEAR_NETWORK ?? "testnet"}.jsonl`, JSON.stringify(record) + "\n");
};
if (d.decision?.action !== "trade" || !d.decision.sell || !d.decision.buy || !d.decision.amount) {
  log("hold", d.decision?.reason ?? "(no usable decision)");
  save();
  process.exit(0);
}
const q = await requestQuote({ fund, sellToken: d.decision.sell, buyToken: d.decision.buy, amount: String(d.decision.amount).replace(/\D/g, ""), dry: argv.includes("--dry"), slippageBps: 50 });
const why = argv.includes("--dry") ? preflight({ ...q, quoteRequest: { ...q.quoteRequest, dry: false } }, fund, state).filter((r) => !/signature|dry|closes too soon/.test(r)) : preflight(q, fund, state);
log("quote", `${q.quote.amountIn} -> ${q.quote.amountOut}, cost ${costBps(q.quote as any)} bps; ${why.length ? `the contract would refuse: ${why.join("; ")}` : "within the mandate"}`);
record.quote = q;
record.preflight = why;
if (argv.includes("--dry") || why.length) {
  save();
  process.exit(why.length ? 1 : 0);
}
const op = opt("--operator", state.config.operator)!;
const r: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "propose_trade", args: { quote: JSON.stringify(q) }, gas: TGAS(200), waitUntil: "FINAL" } as any);
record.tx = txHash(r);
record.accepted = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "false");
log(record.accepted ? "proposed and sent" : "refused by the contract", explorer(record.tx));
if (record.accepted) {
  const dep = (q.quote as any).depositAddress;
  for (let i = 0; i < 120; i++) {
    const s = await status(dep).catch(() => ({ status: "UNKNOWN" }));
    if (/SUCCESS|REFUNDED|FAILED/.test(s.status)) {
      record.oneclick_status = s.status;
      break;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  const st: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "settle", args: {}, gas: TGAS(100), waitUntil: "FINAL" } as any);
  record.settle_tx = txHash(st);
  record.settle_status = JSON.parse(Buffer.from(st.status.SuccessValue ?? "", "base64").toString() || "null");
  log(`settled: ${record.settle_status}`, explorer(record.settle_tx));
}
save();
