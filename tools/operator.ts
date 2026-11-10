// npm run operator -- <command> --fund <fund> [--network mainnet] ...
//
//   quote   --sell <token> --buy <token> --amount <base units> [--live]
//           Fetch a 1Click quote for the fund (dry unless --live) and check it against the fund's
//           mandate exactly as the contract would. Sends nothing.
//   propose --sell <token> --buy <token> --amount <base units> [--operator <account>] [--force]
//           Fetch a LIVE quote, check it, and submit it with propose_trade. Without --force a quote
//           the contract would refuse is not sent. Mainnet needs PLINTH_MAINNET=yes.
//   settle  [--as <account>] [--wait 600]
//           Poll 1Click's status for the trade in flight, then call settle (anyone may).
//   status  Show the fund's holdings, trade in flight and last refusals.
//
// The operator can only propose. It holds no key to the fund and cannot move funds anywhere else.
const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (opt("--network")) process.env.NEAR_NETWORK = opt("--network");
const { signer, view, TGAS, explorer, txHash, log } = await import("./lib/near.ts");
const { requestQuote, preflight, costBps, status } = await import("./lib/oneclick.ts");

const cmd = argv[0];
const fund = opt("--fund");
if (!fund || !cmd) {
  console.error("usage: npm run operator -- quote|propose|settle|status --fund <fund> ...");
  process.exit(2);
}
const state = await view<any>(fund, "get_fund");

if (cmd === "status") {
  console.log(JSON.stringify({ held: state.held, total_shares: state.total_shares, pending: state.pending, trades: state.trades, refusals: state.rejections }, null, 1));
  if (state.rejections) console.log(await view(fund, "get_rejections", { from: Math.max(0, state.rejections - 5), limit: 5 }));
} else if (cmd === "quote" || cmd === "propose") {
  const live = cmd === "propose" || argv.includes("--live");
  const q = await requestQuote({ fund, sellToken: opt("--sell")!, buyToken: opt("--buy")!, amount: opt("--amount")!, dry: !live, slippageBps: Number(opt("--slippage", "50")) });
  const reasons = live ? preflight(q, fund, state) : preflight({ ...q, quoteRequest: { ...q.quoteRequest, dry: false } }, fund, state).filter((r) => !/signature|dry|closes too soon/.test(r));
  console.log(`quote: ${q.quote.amountIn} -> ${q.quote.amountOut} (min ${q.quote.minAmountOut}), $${q.quote.amountInUsd} -> $${q.quote.amountOutUsd}, all-in cost ${costBps(q.quote as any)} bps${live ? `, deposit ${q.quote.depositAddress}` : " (dry)"}`);
  console.log(reasons.length ? `the contract would refuse: ${reasons.join("; ")}` : "the contract would accept this quote");
  if (cmd === "propose") {
    if (reasons.length && !argv.includes("--force")) process.exit(1);
    const op = opt("--operator", state.config.operator)!;
    const r: any = await signer(op).callFunctionRaw({ contractId: fund, methodName: "propose_trade", args: { quote: JSON.stringify(q) }, gas: TGAS(200), waitUntil: "FINAL" } as any);
    const accepted = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "false");
    log(accepted ? "trade sent" : "trade refused", explorer(txHash(r)));
  }
} else if (cmd === "settle") {
  if (!state.pending) {
    console.log("no trade in flight");
    process.exit(0);
  }
  const until = Date.now() + Number(opt("--wait", "600")) * 1000;
  for (;;) {
    let s = "UNKNOWN";
    try {
      s = (await status(state.pending.deposit_address)).status;
    } catch (e) {
      s = `status error: ${(e as Error).message}`;
    }
    log("1Click status", s);
    if (/SUCCESS|REFUNDED|FAILED/.test(s) || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const as = opt("--as", state.config.operator)!;
  const r: any = await signer(as).callFunctionRaw({ contractId: fund, methodName: "settle", args: {}, gas: TGAS(100), waitUntil: "FINAL" } as any);
  log(`settle -> ${Buffer.from(r.status.SuccessValue ?? "", "base64").toString()}`, explorer(txHash(r)));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
