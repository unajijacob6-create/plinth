// Testnet only. NEAR Intents 1Click has no testnet, so a "solver" account stands in for it and
// delivers a trade's output the way 1Click does for a quote with `customRecipientMsg`:
// `ft_transfer_call(receiver_id = fund, amount, msg = "trade:<id>")`. The fund counts the output
// inside that call and the trade settles there; there is no separate settle step.
// A refund is 1Click's plain `ft_transfer` to the quote's refundTo, the fund's relay; anyone then
// calls the relay's `relay_forward`, which pushes it to the fund with msg "refund".
import { NETWORK, call, explorer, log, returned, txHash, view } from "./near.ts";
import { fundState, tradeById } from "./fund.ts";
import { tradeMsg, type TradeView } from "./oneclick.ts";

const STORAGE = 1_250_000_000_000_000_000_000n;
/** Real testnet wNEAR: the solver gets it by wrapping NEAR. Any other token is a test token with `mint`. */
const WRAP_TESTNET = "wrap.testnet";

export interface Delivery {
  tx: string;
  /** Transactions that gave the solver the token first (registration, wrap or mint), if any. */
  prepared: string[];
  /** The trade after the delivery. */
  trade: TradeView;
}

/** Push `amount` of `token` to `fund` for trade `tradeId`, wait for finality, and check that the
 *  fund kept all of it and has no trade in flight any more. */
export async function deliver(o: { solver: string; fund: string; token: string; amount: bigint; tradeId: number }): Promise<Delivery> {
  if (NETWORK !== "testnet") throw new Error("the solver stand-in is for testnet; on mainnet 1Click delivers the output itself");
  if (o.amount <= 0n) throw new Error("nothing to deliver");
  const prepared: string[] = [];
  if ((await view(o.token, "storage_balance_of", { account_id: o.solver })) === null) {
    prepared.push(txHash(await call(o.solver, o.token, "storage_deposit", { registration_only: true }, { deposit: STORAGE, gas: 30 })));
  }
  const have = BigInt(await view<string>(o.token, "ft_balance_of", { account_id: o.solver }));
  if (have < o.amount) {
    const short = o.amount - have;
    const r = o.token === WRAP_TESTNET
      ? await call(o.solver, o.token, "near_deposit", {}, { deposit: short, gas: 30 })
      : await call(o.solver, o.token, "mint", { account_id: o.solver, amount: String(short) }, { gas: 30 }).catch((e) => {
          throw new Error(`${o.solver} holds ${have} of ${o.token}, needs ${o.amount}, and the token has no test \`mint\`: ${(e as Error).message.slice(0, 200)}`);
        });
    prepared.push(txHash(r));
  }
  const r = await call(o.solver, o.token, "ft_transfer_call", { receiver_id: o.fund, amount: String(o.amount), msg: tradeMsg(o.tradeId) }, { deposit: 1n, gas: 100 });
  const tx = txHash(r);
  // ft_transfer_call returns the amount the receiver kept.
  const kept = returned<string>(r);
  if (kept !== String(o.amount)) throw new Error(`the fund kept ${kept ?? "nothing"} of the ${o.amount} delivered ${explorer(tx)}`);
  const s = await fundState(o.fund);
  const trade = await tradeById(o.fund, o.tradeId);
  if (!trade) throw new Error(`${o.fund} has no trade ${o.tradeId}`);
  if (s.pending !== null) throw new Error(`trade ${s.pending.id} is still in flight after the delivery (status ${s.pending.status}, received ${trade.received_out} of at least ${trade.min_out}) ${explorer(tx)}`);
  log("delivered", `${o.amount} ${o.token} -> ${o.fund} for trade ${o.tradeId}: ${trade.status} ${explorer(tx)}`);
  return { tx, prepared, trade };
}

/** Anyone, any network: ask the fund's relay to hand `amount` of `token` to the fund
 *  (`relay_forward`: the relay does `ft_transfer_call(fund, amount, "refund")`). Fails, moving
 *  nothing, if the relay does not hold that much. Returns the outcome. */
export async function forwardRefund(o: { from: string; relay: string; token: string; amount: bigint; allowFailure?: boolean }): Promise<any> {
  return call(o.from, o.relay, "relay_forward", { token: o.token, amount: String(o.amount) }, { gas: 150, allowFailure: o.allowFailure });
}

export interface Refund {
  /** The solver's plain transfer to the relay (what 1Click does when it refunds). */
  transfer_tx: string;
  /** The permissionless hand-over, relay -> fund. */
  forward_tx: string;
  amount: string;
  trade: TradeView;
}

/** Testnet stand-in for a 1Click refund of trade `tradeId`: `solver` plain-transfers
 *  `amount_in - refund_fee` of the token sold to the fund's relay, then `forwarder` (anyone) calls
 *  `relay_forward`. Checks that the trade ended `Refunded`. */
export async function refundViaRelay(o: { solver: string; forwarder: string; fund: string; tradeId: number }): Promise<Refund> {
  if (NETWORK !== "testnet") throw new Error("the solver stand-in is for testnet; on mainnet 1Click sends the refund to the relay itself (then: forward-refund)");
  const s = await fundState(o.fund);
  const t = await tradeById(o.fund, o.tradeId);
  if (!t) throw new Error(`${o.fund} has no trade ${o.tradeId}`);
  if (t.stake || t.status !== "Sent" || s.pending?.id !== t.id) throw new Error(`trade ${o.tradeId} is ${t.status}; only the swap in flight can be refunded`);
  const relay = s.config.refund_relay;
  if (!relay) throw new Error(`${o.fund} reports no refund relay`);
  const token = s.config.mandate.tokens[t.sell];
  const amount = BigInt(t.amount_in) - BigInt(t.refund_fee);
  if (amount <= 0n) throw new Error(`trade ${o.tradeId} has nothing to refund after the refund fee`);
  const have = BigInt(await view<string>(token, "ft_balance_of", { account_id: o.solver }));
  if (have < amount) throw new Error(`${o.solver} holds ${have} of ${token}; the refund is ${amount}`);
  const transfer = await call(o.solver, token, "ft_transfer", { receiver_id: relay, amount: String(amount), memo: "refund" }, { deposit: 1n, gas: 30 });
  const forward = await forwardRefund({ from: o.forwarder, relay, token, amount });
  const after = (await tradeById(o.fund, o.tradeId))!;
  if (after.status !== "Refunded") throw new Error(`trade ${o.tradeId} is ${after.status} after the refund (received ${after.received_refund} of ${amount}) ${explorer(txHash(forward))}`);
  log("refunded", `${amount} ${token}: ${o.solver} -> ${relay} -> ${o.fund}; trade ${o.tradeId} Refunded ${explorer(txHash(forward))}`);
  return { transfer_tx: txHash(transfer), forward_tx: txHash(forward), amount: String(amount), trade: after };
}
