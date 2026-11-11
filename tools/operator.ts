// npm run operator -- <command> --fund <fund> [--network mainnet] ...
//
//   status
//           The fund's version, holdings, trade in flight, last trades and last refusals.
//   quote   --sell <token> --buy <token> --amount <base units> [--slippage 50] [--live]
//           Fetch a 1Click quote for the fund (dry unless --live) and check it against the fund's
//           mandate exactly as the contract would. The quote carries the id of the trade it would
//           become (customRecipientMsg "trade:<id>"), so 1Click pushes the output to the fund.
//           Sends nothing.
//   propose --sell <token> --buy <token> --amount <base units> [--slippage 50] [--operator <account>] [--force]
//           Fetch a LIVE quote, check it, and submit it with propose_trade. Without --force a quote
//           the contract would refuse is not sent. The trade settles by itself when 1Click delivers.
//   forward-refund <fund> <token> <amount> --as <account>
//           Anyone, any network. When 1Click refunds a trade it sends the input back to the fund's
//           refund relay with a plain transfer. This asks the relay to hand <amount> (base units)
//           of <token> to the fund (relay_forward); the fund counts it and, once amount_in minus
//           the refund fee has arrived, closes the trade in flight as Refunded.
//   refund <fund> <trade id> --solver <account> [--as <account>]
//           Testnet only stand-in for a 1Click refund: the solver transfers amount_in minus the
//           refund fee to the relay, then --as (default: the solver) calls relay_forward.
//   deliver --solver <account> [--amount <base units>]
//           Testnet only (1Click has no testnet): the solver stand-in pushes the output of the trade
//           in flight (default: the quoted amount) with ft_transfer_call "trade:<id>".
//   rebalance --as <account> [--near 0.01]
//           Anyone, for a fund with a strategy: ask it for a proposal. Attaches --near for the
//           OutLayer run (at least 0.005; unused NEAR is refunded to the caller by OutLayer) and
//           300 TGas. If OutLayer refuses the request outright, the attached NEAR stays with the
//           fund: the contract cannot send NEAR back.
//
// The operator can only propose. It holds no key to the fund and cannot move funds anywhere else.
// Mainnet signing needs PLINTH_MAINNET=yes.
import { parseArgs, plainErrors, withUsage, UsageError } from "./lib/args.ts";
import { parseNear } from "./lib/config.ts";

plainErrors();
const USAGE = "usage: npm run operator -- status|quote|propose|deliver|rebalance --fund <fund> [--network testnet|mainnet] ...\n       npm run operator -- forward-refund <fund> <token> <amount> --as <account> [--network testnet|mainnet]\n       npm run operator -- refund <fund> <trade id> --solver <account> [--as <account>]\n(see the top of tools/operator.ts)";
const COMMANDS: Record<string, { values: string[]; switches: string[]; args: number }> = {
  status: { values: [], switches: [], args: 0 },
  quote: { values: ["--sell", "--buy", "--amount", "--slippage"], switches: ["--live"], args: 0 },
  propose: { values: ["--sell", "--buy", "--amount", "--slippage", "--operator"], switches: ["--force"], args: 0 },
  "forward-refund": { values: ["--as"], switches: [], args: 3 },
  refund: { values: ["--solver", "--as"], switches: [], args: 2 },
  deliver: { values: ["--solver", "--amount"], switches: [], args: 0 },
  rebalance: { values: ["--as", "--near"], switches: [], args: 0 },
};
const { cmd, a, fund, deposit } = withUsage(USAGE, () => {
  const cmd = process.argv[2];
  const spec = COMMANDS[cmd];
  if (!spec) throw new UsageError(cmd ? `unknown command ${cmd}` : "no command");
  const a = parseArgs(process.argv.slice(3), { values: ["--fund", "--network", ...spec.values], switches: spec.switches });
  if (a.positionals.length !== spec.args) throw new UsageError(spec.args ? `${cmd} takes ${spec.args} arguments` : `unexpected argument ${a.positionals[0]}`);
  // forward-refund and refund name the fund first; the other commands take --fund.
  const fund = spec.args ? (a.values["--fund"] ? undefined : a.positionals[0]) : a.values["--fund"];
  if (!fund) throw new UsageError(spec.args ? `${cmd} names the fund as its first argument, not with --fund` : "--fund is required");
  if (a.values["--network"] && !["testnet", "mainnet"].includes(a.values["--network"])) throw new UsageError("--network is testnet or mainnet");
  if (cmd === "quote" || cmd === "propose") {
    for (const f of ["--sell", "--buy", "--amount"]) if (!a.values[f]) throw new UsageError(`${cmd} needs ${f}`);
    if (!/^\d+$/.test(a.values["--amount"])) throw new UsageError("--amount is in base units, digits only");
    if (a.values["--slippage"] && !/^\d+$/.test(a.values["--slippage"])) throw new UsageError("--slippage is in basis points");
  }
  if (cmd === "forward-refund" && !/^[1-9]\d*$/.test(a.positionals[2])) throw new UsageError("forward-refund <fund> <token> <amount>: the amount is in base units, digits only");
  if (cmd === "forward-refund" && !a.values["--as"]) throw new UsageError("forward-refund needs --as <account> (anyone; it pays the gas)");
  if (cmd === "refund" && !/^\d+$/.test(a.positionals[1])) throw new UsageError("refund <fund> <trade id>: the trade id is a number");
  if (cmd === "refund" && !a.values["--solver"]) throw new UsageError("refund needs --solver <account> (it pays the refund)");
  if (cmd === "deliver" && !a.values["--solver"]) throw new UsageError("deliver needs --solver <account>");
  if (cmd === "deliver" && a.values["--amount"] && !/^\d+$/.test(a.values["--amount"])) throw new UsageError("--amount is in base units, digits only");
  if (cmd === "rebalance" && !a.values["--as"]) throw new UsageError("rebalance needs --as <account> (it pays for the strategy run)");
  const deposit = cmd === "rebalance" ? parseNear(a.values["--near"] ?? "0.01") : 0n;
  if (cmd === "rebalance" && deposit < 5n * 10n ** 21n) throw new UsageError("--near must be at least 0.005: the contract refuses a strategy run with less attached");
  return { cmd, a, fund, deposit };
});
if (a.values["--network"]) process.env.NEAR_NETWORK = a.values["--network"];
const { NETWORK, call, callLong, view, returned, explorer, txHash, log, formatNear } = await import("./lib/near.ts");
const { requestQuote, preflight, costBps } = await import("./lib/oneclick.ts");
const { fundState, requireRelease03, relayOf, plinthEvents } = await import("./lib/fund.ts");

const state = await fundState(fund);
requireRelease03(state, fund);
const tokens = state.config.mandate.tokens;

if (cmd === "status") {
  console.log(JSON.stringify({ version: state.version, refund_relay: state.config.refund_relay, held: state.held, total_shares: state.total_shares, pending: state.pending, trades: state.trades, refusals: state.rejections, owed_total: state.owed_total, basket_total: state.basket_total, near_free: state.near_free, strategy_started: state.strategy_started }, null, 1));
  if (state.trades) console.log("last trades", JSON.stringify(await view(fund, "get_trades", { from: Math.max(0, state.trades - 3), limit: 3 }), null, 1));
  if (state.rejections) console.log("last refusals", JSON.stringify(await view(fund, "get_rejections", { from: Math.max(0, state.rejections - 5), limit: 5 }), null, 1));
} else if (cmd === "quote" || cmd === "propose") {
  const live = cmd === "propose" || a.switches.has("--live");
  // The quote is bound to the id the next trade gets; 1Click signs it as customRecipientMsg.
  const q = await requestQuote({ fund, sellToken: a.values["--sell"], buyToken: a.values["--buy"], amount: a.values["--amount"], tradeId: state.trades, refundRelay: relayOf(state, fund), dry: !live, slippageBps: Number(a.values["--slippage"] ?? "50") });
  // A dry quote has no deposit address or deadline and is checked as if it were live, without those.
  const reasons = live ? preflight(q, fund, state) : preflight({ ...q, quoteRequest: { ...q.quoteRequest, dry: false } }, fund, state).filter((r) => !/signature|dry|closes too soon/.test(r));
  console.log(`quote for trade ${state.trades}: ${q.quote.amountIn} -> ${q.quote.amountOut} (min ${q.quote.minAmountOut}), $${q.quote.amountInUsd} -> $${q.quote.amountOutUsd}, all-in cost ${costBps(q.quote as any)} bps, delivery msg ${JSON.stringify(q.quoteRequest.customRecipientMsg)}${live ? `, deposit ${q.quote.depositAddress}` : " (dry)"}`);
  console.log(reasons.length ? `the contract would refuse: ${reasons.join("; ")}` : "the contract would accept this quote");
  if (cmd === "propose") {
    if (reasons.length && !a.switches.has("--force")) process.exit(1);
    const op = a.values["--operator"] ?? state.config.operator;
    const r = await call(op, fund, "propose_trade", { quote: JSON.stringify(q) }, { gas: 200 });
    const accepted = returned<boolean>(r) === true;
    log(accepted ? `trade ${state.trades} sent; it settles when 1Click delivers (a refund goes to the relay ${relayOf(state, fund)}: forward-refund)` : "trade refused", explorer(txHash(r)));
    if (!accepted) process.exit(1);
  }
} else if (cmd === "forward-refund") {
  const relay = relayOf(state, fund);
  const token = a.positionals[1], amount = BigInt(a.positionals[2]);
  if (!tokens.includes(token)) throw new Error(`${token} is not one of the fund's tokens (${tokens.join(", ")})`);
  const held = BigInt(await view<string>(token, "ft_balance_of", { account_id: relay }));
  if (held < amount) throw new Error(`the relay ${relay} holds ${held} of ${token}; nothing to forward for ${amount}`);
  const { forwardRefund } = await import("./lib/solver.ts");
  const r = await forwardRefund({ from: a.values["--as"], relay, token, amount });
  const after = await fundState(fund);
  log(`relay ${relay} handed ${returned<string>(r)} of ${token} to the fund; ${after.pending ? `trade ${after.pending.id} is still ${after.pending.status}` : "no trade in flight"}`, explorer(txHash(r)));
} else if (cmd === "refund") {
  const { refundViaRelay } = await import("./lib/solver.ts");
  await refundViaRelay({ solver: a.values["--solver"], forwarder: a.values["--as"] ?? a.values["--solver"], fund, tradeId: Number(a.positionals[1]) });
} else if (cmd === "deliver") {
  const p = state.pending;
  if (!p) throw new Error("no trade in flight");
  if (p.stake) throw new Error("the trade in flight is a stake; it settles by itself");
  if (p.status !== "Sent") throw new Error(`trade ${p.id} is ${p.status}; only a trade whose input was sent can be delivered`);
  const { deliver } = await import("./lib/solver.ts");
  await deliver({ solver: a.values["--solver"], fund, token: tokens[p.buy], amount: BigInt(a.values["--amount"] ?? p.quoted_out), tradeId: p.id });
} else if (cmd === "rebalance") {
  if (!state.config.mandate.strategy) throw new Error(`${fund} has no strategy; its operator ${state.config.operator} proposes trades`);
  // The transaction finishes only when OutLayer has answered and the fund has acted on the answer.
  const r = await callLong(a.values["--as"], fund, "rebalance", {}, { deposit, gas: 300 });
  for (const e of plinthEvents(r)) console.log(`event ${e.event}: ${JSON.stringify(e.data)}`);
  log(`rebalance (${formatNear(deposit)} NEAR attached) -> ${returned<string>(r)}`, explorer(txHash(r)));
  const after = await fundState(fund);
  if (after.pending) console.log(`trade ${after.pending.id} in flight (${after.pending.status})${NETWORK === "testnet" ? `; on testnet deliver it with: npm run operator -- deliver --fund ${fund} --solver <account>` : ""}`);
}
