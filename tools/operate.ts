// npm run operate -- --fund <fund> [--network mainnet] [--note "text" | --note-file path] [--operator <account>] [--quorum] [--dry]
//                    [--test-signer [--solver <account>] [--test-prices <file>]]
//
// --quorum: DeepSeek (NEAR AI TEE) and Gemini (NEAR AI gateway) must both say trade with the same tokens
// and recipient; the smaller amount is used (PLINTH_QUORUM_MODELS to change the models).
//
// One round of an AI-operated fund (release 0.3):
//   1. the AI operator (NEAR AI Cloud, signed receipt) reads the fund and the note and decides;
//   2. a hold ends the round; a trade is turned into a LIVE 1Click quote for the fund, bound to the
//      id the trade will get (customRecipientMsg "trade:<id>": 1Click then pushes the output to the
//      fund with ft_transfer_call). Recipient and refund address are always the fund: the tool does
//      not take those from the model;
//   3. the quote is checked off-chain exactly as the contract will check it; --dry stops here;
//   4. it is proposed; the round then waits for 1Click to deliver. The trade settles inside the
//      delivery; there is no settle step. A stake settles inside its own transaction.
// The contract is the final check either way. Mainnet signing needs PLINTH_MAINNET=yes.
//
// --test-signer (testnet only): 1Click has no testnet, so the round uses a quote signed by this
// machine's test key at the stated test prices (--test-prices, default tools/test-prices.testnet.json)
// and the solver stand-in (--solver, default the solver of data/testnet-run.json) delivers the
// output. With it one AI round completes on testnet end to end. The fund must have been created
// with the test key as its quote signer.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs, withUsage, UsageError } from "./lib/args.ts";

const USAGE = "usage: npm run operate -- --fund <fund> [--network testnet|mainnet] [--note text | --note-file path] [--operator <account>] [--quorum] [--dry] [--test-signer [--solver <account>] [--test-prices <file>]]";
const a = withUsage(USAGE, () => {
  const p = parseArgs(process.argv.slice(2), { values: ["--fund", "--network", "--note", "--note-file", "--operator", "--solver", "--test-prices"], switches: ["--quorum", "--dry", "--test-signer"] });
  if (!p.values["--fund"]) throw new UsageError("--fund is required");
  if (p.positionals.length) throw new UsageError(`unexpected argument ${p.positionals[0]}`);
  if (p.values["--network"] && !["testnet", "mainnet"].includes(p.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  if (p.values["--note"] && p.values["--note-file"]) throw new UsageError("give --note or --note-file, not both");
  if (!p.switches.has("--test-signer") && (p.values["--solver"] || p.values["--test-prices"])) throw new UsageError("--solver and --test-prices only apply with --test-signer");
  return p;
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { NETWORK, call, returned, explorer, txHash, log } = await import("./lib/near.ts");
const { requestQuote, preflight, preflightStake, costBps, status, sameEd25519Key } = await import("./lib/oneclick.ts");
const { decide, decideQuorum, cleanDecision, QUORUM_MODELS } = await import("./lib/agent.ts");
const { verifyReceipt, attestedSigners, AGENT_MODEL } = await import("./lib/nearai.ts");
const { ROOT, fundState, requireRelease03, tradeById } = await import("./lib/fund.ts");
type QuoteResponse = import("./lib/oneclick.ts").QuoteResponse;

const fund = a.values["--fund"];
const quorum = a.switches.has("--quorum"), dry = a.switches.has("--dry"), testMode = a.switches.has("--test-signer");
const note = a.values["--note"] ?? (a.values["--note-file"] ? fs.readFileSync(a.values["--note-file"], "utf8") : "No news. Keep the fund within its mandate.");
const state = await fundState(fund);
requireRelease03(state, fund);
const tokens: string[] = state.config.mandate.tokens;
const op = a.values["--operator"] ?? state.config.operator;

// ---------------------------------------------------------------- test-signer mode (testnet)
let test: { prices: import("./lib/testprices.ts").TestPrices; solver: string } | null = null;
if (testMode) {
  if (NETWORK !== "testnet") throw new Error("--test-signer is for testnet; on mainnet quotes come from 1Click");
  const { testSigner } = await import("./lib/testsigner.ts");
  if (!sameEd25519Key(state.config.quote_signer, testSigner().public_key)) throw new Error(`${fund} was not created with this machine's test quote signer (${testSigner().public_key}); its signer is ${state.config.quote_signer}`);
  const file = a.values["--test-prices"] ?? path.join(ROOT, "tools/test-prices.testnet.json");
  const prices = JSON.parse(fs.readFileSync(file, "utf8"));
  const solver = a.values["--solver"] ?? JSON.parse(fs.readFileSync(path.join(ROOT, "data/testnet-run.json"), "utf8")).accounts?.solver;
  if (!solver) throw new Error("--test-signer needs --solver <account> (data/testnet-run.json names none)");
  const missing = tokens.filter((t) => !prices.tokens?.[t]);
  if (missing.length) throw new Error(`${file} has no test price for ${missing.join(", ")}`);
  test = { prices, solver };
}

// Prices for the model: on mainnet a dry 1Click quote of about 1% of each holding, so the agent sees
// real rates; in test-signer mode the stated test prices.
let priceText: string;
if (test) {
  priceText = (await import("./lib/testprices.ts")).describeTestPrices(test.prices, tokens);
} else {
  const prices: string[] = [];
  for (const [i, t] of tokens.entries()) {
    for (const u of tokens.slice(i + 1)) {
      const held = BigInt(state.held[i][1]);
      if (held === 0n) continue;
      try {
        const q = await requestQuote({ fund, sellToken: t, buyToken: u, amount: String(held / 100n || 1n), tradeId: state.trades, dry: true });
        prices.push(`${q.quote.amountIn} ${t} -> ${q.quote.amountOut} ${u} (about $${q.quote.amountInUsd})`);
      } catch (e) {
        prices.push(`${t} -> ${u}: no quote (${(e as Error).message.slice(0, 60)})`);
      }
    }
  }
  priceText = prices.join("; ") || "no prices available";
}

// The record is written on every exit path, including errors, so a paid AI call or a sent
// transaction is never lost.
const record: any = { at: new Date().toISOString(), network: NETWORK, fund, note, ...(test ? { test_signer: true, solver: test.solver } : {}) };
let saved = false;
const save = () => {
  if (saved) return;
  saved = true;
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.appendFileSync(path.join(ROOT, `data/operate-${record.network}.jsonl`), JSON.stringify(record) + "\n");
};
/** Exit codes: 0 = done as intended (hold, dry run, settled); 1 = refused or failed;
 *  3 = sent but not closed yet (1Click has not delivered; see the message). */
const finish = (code: number, msg: string): never => {
  record.outcome = msg;
  log(code === 0 ? "done" : code === 3 ? "pending" : "failed", msg);
  save();
  process.exit(code);
};
process.on("uncaughtException", (e) => finish(1, `error: ${(e as Error).message}`));
process.on("unhandledRejection", (e) => finish(1, `error: ${(e as Error)?.message ?? e}`));

// ---------------------------------------------------------------- decide
const attested = await attestedSigners(quorum ? QUORUM_MODELS : [AGENT_MODEL]).catch(() => undefined);
record.attested = attested;
const checkReceipt = (r: any) => (r ? verifyReceipt(r, attested) : null);
let decision: any;
if (quorum) {
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
  const before = await fundState(fund);
  const why = preflightStake(decision.amount, before);
  record.preflight = why;
  if (why.length) finish(1, `the contract would refuse the stake: ${why.join("; ")}`);
  if (dry) finish(0, `dry run: would stake ${decision.amount}`);
  const r = await call(op, fund, "stake_idle", { amount: decision.amount }, { gas: 300 });
  record.tx = txHash(r);
  record.accepted = returned<boolean>(r) === true;
  if (!record.accepted) finish(1, `stake refused by the contract ${explorer(record.tx)}`);
  // unwrap -> price -> deposit_and_stake ran inside that transaction and closed the stake:
  // Settled (the minted amount is counted) or Failed (the NEAR was wrapped back).
  record.trade_id = before.trades;
  const t = await tradeById(fund, before.trades);
  record.settle_status = t?.status ?? "unknown";
  record.minted = t?.received_out;
  finish(t?.status === "Settled" ? 0 : t?.status === "Sending" ? 3 : 1, `stake ${record.settle_status}${t?.status === "Sending" ? " (a callback did not finish; anyone can call recover_stuck_stake after a day)" : ""} ${explorer(record.tx)}`);
}

// ---------------------------------------------------------------- hold
if (decision.action !== "trade") finish(0, `hold: ${decision.reason ?? "(no usable decision)"}`);

// ---------------------------------------------------------------- trade
// The quote is bound to the trade id: read the fund again so the id is current.
const fresh = await fundState(fund);
const tradeId = fresh.trades;
record.trade_id = tradeId;
let q: QuoteResponse;
let out = 0n;
if (test) {
  const { testQuote } = await import("./lib/testsigner.ts");
  const { testFill } = await import("./lib/testprices.ts");
  const fill = testFill(test.prices, decision.sell, decision.buy, BigInt(decision.amount));
  out = fill.out;
  q = JSON.parse(testQuote({ fund, tradeId, sell: decision.sell, buy: decision.buy, amount: BigInt(decision.amount), ...fill, deposit: randomBytes(32).toString("hex") }));
} else {
  q = await requestQuote({ fund, sellToken: decision.sell, buyToken: decision.buy, amount: decision.amount, tradeId, dry, slippageBps: 50 });
}
// A dry 1Click quote has no deposit address or deadline: check it as if live, without those.
const why = !test && dry ? preflight({ ...q, quoteRequest: { ...q.quoteRequest, dry: false } }, fund, fresh).filter((r) => !/signature|dry|closes too soon/.test(r)) : preflight(q, fund, fresh);
record.quote = q;
record.preflight = why;
log("quote", `trade ${tradeId}: ${q.quote.amountIn} -> ${q.quote.amountOut}, cost ${costBps(q.quote as any)} bps; ${why.length ? `the contract would refuse: ${why.join("; ")}` : "within the mandate"}`);
if (why.length) finish(1, `the contract would refuse: ${why.join("; ")}`);
if (dry) finish(0, "dry run: within the mandate");
const r = await call(op, fund, "propose_trade", { quote: JSON.stringify(q) }, { gas: 200 });
record.tx = txHash(r);
record.accepted = returned<boolean>(r) === true;
log(record.accepted ? "proposed" : "refused by the contract", explorer(record.tx));
if (!record.accepted) finish(1, `refused by the contract ${explorer(record.tx)}`);
// propose_trade = true only means the checks passed; the deposit itself may still have failed,
// in which case the trade closed as Failed inside that transaction.
let trade = await tradeById(fund, tradeId);
if (trade?.status === "Sent") {
  if (test) {
    const { deliver } = await import("./lib/solver.ts");
    const d = await deliver({ solver: test.solver, fund, token: tokens[trade.buy], amount: out, tradeId });
    record.deliver_tx = d.tx;
    trade = d.trade;
  } else {
    // 1Click delivers with ft_transfer_call "trade:<id>"; the fund settles the trade in that call.
    const dep = (q.quote as any).depositAddress;
    for (let i = 0; i < 120; i++) {
      trade = await tradeById(fund, tradeId);
      if (trade?.status !== "Sent") break;
      const st = await status(dep).catch(() => ({ status: "UNKNOWN" }));
      record.oneclick_status = st.status;
      if (/REFUNDED|FAILED/.test(st.status)) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}
record.settle_status = trade?.status ?? "unknown";
if (trade?.status === "Settled") finish(0, `trade ${tradeId} Settled ${explorer(record.tx)}`);
if (trade?.status === "Sent") {
  const at = new Date((trade.sent_at + 3600) * 1000).toISOString();
  finish(3, `trade ${tradeId} is sent and not delivered yet (1Click: ${record.oneclick_status ?? "unknown"}). It settles by itself when the output arrives; if 1Click refunds instead, anyone can count the refund after ${at}: npm run operator -- settle-refund ${tradeId} --fund ${fund}${NETWORK === "mainnet" ? " --network mainnet" : ""} ${explorer(record.tx)}`);
}
finish(1, `trade ${tradeId} ${record.settle_status} ${explorer(record.tx)}`);
