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
const { requestQuote, preflight, preflightStake, costBps, status } = await import("./lib/oneclick.ts");
const { decide, decideQuorum, cleanDecision, QUORUM_MODELS } = await import("./lib/agent.ts");
const { verifyReceipt, attestedSigners, AGENT_MODEL } = await import("./lib/nearai.ts");

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
const dry = argv.includes("--dry");
const op = opt("--operator", state.config.operator)!;

// The record is written on every exit path, including errors, so a paid AI call or a sent
// transaction is never lost.
const record: any = { at: new Date().toISOString(), network: process.env.NEAR_NETWORK ?? "testnet", fund, note };
let saved = false;
const save = () => {
  if (saved) return;
  saved = true;
  fs.mkdirSync("data", { recursive: true });
  fs.appendFileSync(`data/operate-${record.network}.jsonl`, JSON.stringify(record) + "\n");
};
/** Exit codes: 0 = done as intended (hold, dry run, settled/refunded); 1 = refused or failed;
 *  3 = sent but not closed yet (settle again later). */
const finish = (code: number, msg: string): never => {
  record.outcome = msg;
  log(code === 0 ? "done" : code === 3 ? "pending" : "failed", msg);
  save();
  process.exit(code);
};
process.on("uncaughtException", (e) => finish(1, `error: ${(e as Error).message}`));
process.on("unhandledRejection", (e) => finish(1, `error: ${(e as Error)?.message ?? e}`));

/** Settle the trade in flight if, and only if, the contract says it can be settled now. */
async function settleIfReady(): Promise<string> {
  const f = await view<any>(fund!, "get_fund");
  if (!f.pending) {
    // Closed already (a failed send or stake closes itself): report the last trade's status.
    const last = (await view<any[]>(fund!, "get_trades", { from: Math.max(0, f.trades - 1), limit: 1 }))[0];
    return last?.status ?? "none";
  }
  if (f.pending.status !== "Sent") return f.pending.status;
  try {
    const st: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "settle", args: {}, gas: TGAS(100), waitUntil: "FINAL" } as any);
    record.settle_tx = txHash(st);
    log("settle", explorer(record.settle_tx));
    return JSON.parse(Buffer.from(st.status.SuccessValue ?? "", "base64").toString() || "null") ?? "Sent";
  } catch (e) {
    record.settle_error = (e as Error).message.slice(0, 300);
    return "Sent";
  }
}

// ---------------------------------------------------------------- decide
const attested = await attestedSigners(argv.includes("--quorum") ? QUORUM_MODELS : [AGENT_MODEL]).catch(() => undefined);
record.attested = attested;
const checkReceipt = (r: any) => (r ? verifyReceipt(r, attested) : null);
let decision: any;
if (argv.includes("--quorum")) {
  const q = await decideQuorum(fund, state, priceText, note);
  record.votes = q.votes.map((v) => ({ ...v, receipt_check: checkReceipt(v.receipt) }));
  for (const v of record.votes) log(`${v.model} said`, `${v.raw.slice(0, 200)} · receipt ${v.receipt_check ? `${v.receipt_check.kind} ${v.receipt_check.ok ? "verified" : "NOT verified"}` : `none (${v.error})`}`);
  log("quorum", `${q.decision.action}: ${q.why}`);
  decision = q.decision;
} else {
  const one = await decide(fund, state, priceText, note);
  const rv = checkReceipt(one.receipt)!;
  record.raw = one.raw;
  record.receipt = one.receipt;
  record.receipt_check = rv;
  log("operator decided", one.raw.slice(0, 300));
  log("NEAR AI receipt", `${one.receipt.chat_id} ${rv.ok ? "verified" : "NOT verified"} (${rv.checks.join("; ")})`);
  // Same cleaning as the quorum: exact token names, strict base-unit amounts, else hold.
  decision = cleanDecision(one.decision, fund, tokens);
}
record.decision = decision;

// ---------------------------------------------------------------- stake
if (decision.action === "stake") {
  const why = preflightStake(decision.amount, await view<any>(fund, "get_fund"));
  record.preflight = why;
  if (why.length) finish(1, `the contract would refuse the stake: ${why.join("; ")}`);
  if (dry) finish(0, `dry run: would stake ${decision.amount}`);
  const r: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "stake_idle", args: { amount: decision.amount }, gas: TGAS(300), waitUntil: "FINAL" } as any);
  record.tx = txHash(r);
  record.accepted = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "false");
  if (!record.accepted) finish(1, `stake refused by the contract ${explorer(record.tx)}`);
  // The whole unwrap -> price -> deposit_and_stake chain ran inside that transaction: it is now
  // either Sent (settleable) or already closed as Failed (the NEAR was wrapped back).
  record.settle_status = await settleIfReady();
  finish(record.settle_status === "Settled" ? 0 : record.settle_status === "Sent" ? 3 : 1, `stake ${record.settle_status} ${explorer(record.tx)}`);
}

// ---------------------------------------------------------------- hold
if (decision.action !== "trade") finish(0, `hold: ${decision.reason ?? "(no usable decision)"}`);

// ---------------------------------------------------------------- trade
const q = await requestQuote({ fund, sellToken: decision.sell, buyToken: decision.buy, amount: decision.amount, dry, slippageBps: 50 });
const why = dry ? preflight({ ...q, quoteRequest: { ...q.quoteRequest, dry: false } }, fund, state).filter((r) => !/signature|dry|closes too soon/.test(r)) : preflight(q, fund, await view<any>(fund, "get_fund"));
record.quote = q;
record.preflight = why;
log("quote", `${q.quote.amountIn} -> ${q.quote.amountOut}, cost ${costBps(q.quote as any)} bps; ${why.length ? `the contract would refuse: ${why.join("; ")}` : "within the mandate"}`);
if (why.length) finish(1, `the contract would refuse: ${why.join("; ")}`);
if (dry) finish(0, "dry run: within the mandate");
const r: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "propose_trade", args: { quote: JSON.stringify(q) }, gas: TGAS(200), waitUntil: "FINAL" } as any);
record.tx = txHash(r);
record.accepted = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "false");
log(record.accepted ? "proposed" : "refused by the contract", explorer(record.tx));
if (!record.accepted) finish(1, `refused by the contract ${explorer(record.tx)}`);
// propose_trade = true only means the checks passed; the deposit itself may still have failed,
// in which case the trade closed as Failed inside that transaction. Only wait for 1Click if it is Sent.
const afterSend = await view<any>(fund, "get_fund");
if (afterSend.pending?.status === "Sent") {
  const dep = (q.quote as any).depositAddress;
  for (let i = 0; i < 120; i++) {
    const st = await status(dep).catch(() => ({ status: "UNKNOWN" }));
    if (/SUCCESS|REFUNDED|FAILED/.test(st.status)) {
      record.oneclick_status = st.status;
      break;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}
record.settle_status = await settleIfReady();
const done = record.settle_status === "Settled" || record.settle_status === "Refunded";
finish(done ? 0 : record.settle_status === "Sent" ? 3 : 1, `trade ${record.settle_status} ${explorer(record.tx)}`);
