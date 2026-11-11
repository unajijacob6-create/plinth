# Plinth: security notes for release 0.3

This file states what the contract relies on, what was broken in earlier releases, how 0.3 fixes
it, and what is still not proven. Every claim points at code or a test in this repository.

## The bug in releases 0.1 and 0.2

`settle()` and `absorb()` credited the fund with whatever `ft_balance_of` reported above what it
already accounted for.

A NEP-141 `ft_transfer_call` credits the receiver first, then calls the receiver's
`ft_on_transfer`, then refunds what the receiver did not keep. So a transfer that is about to be
refunded sits in the receiver's balance for about two blocks. Anyone could send the fund tokens it
would return, and call `settle()` or `absorb()` in the same blocks. The fund then counted tokens it
did not own.

Proved on the 0.2 build before any fix (commit `0094ff0`, `contracts/plinth/tests/poc.rs`):

- a holder of 10% of the shares left with 100% of a token, and the 90% holder was left with a
  claim that could never be paid;
- a trade in flight was marked `Settled` with nothing delivered.

All four funds deployed before 0.3 have this bug. They are keyless, so they cannot be fixed. They
hold test tokens only.

Two earlier reviews did not find it.

## The rule in 0.3

**The fund counts a token as its own only when it sees the token arrive and keeps it, or when one
of its own calls returns it.** It never credits trade output from a balance it reads.

| what arrives | how it is counted |
|---|---|
| subscription | `ft_on_transfer` during the window (kept, returns 0) |
| trade output | `ft_on_transfer` with `msg = "trade:<id>"`. The quote's signed `customRecipientMsg` must be exactly that, so 1Click delivers with `ft_transfer_call`. The trade settles inside that call. |
| donation | `ft_on_transfer` with `msg = "donate"` |
| in-kind join | `ft_on_transfer` with `msg = "basket"`, held apart from the fund until `join_in_kind` |
| stake output | the amount `deposit_and_stake` returns, capped by the price the fund read |
| failed stake | the fund's own `near_deposit` succeeding |
| refund of a failed trade | `ft_on_transfer` with `msg = "refund"` from the fund's relay (see "Refunds: the relay") |

There is no `settle()`, no `absorb()` and no balance read of any kind. A plain `ft_transfer` to a
fund is never counted.

Tests (`contracts/plinth/tests/regression.rs`, run by `contracts/test.sh`):

- `regression_bounced_transfer_cannot_inflate_holdings`: the first exploit, replayed. Holdings do
  not move; both holders redeem exactly their share.
- `regression_bounced_transfer_cannot_settle_a_trade`: the second exploit, replayed. The trade stays
  in flight until the real delivery.
- `randomized_steps_keep_the_books_exact`: random subscriptions, donations, bounces, in-kind joins,
  redemptions, delivered trades and trades refunded through the relay. After every step the invariant below holds,
  shares add up, each redemption pays exactly `floor(held × shares / total)` of every token, and an
  in-kind join never lowers what one share holds.

The invariant, checked after every step of those tests:

```
ft_balance_of(fund) >= held + owed + payouts in flight + baskets      (for every token)
```

## Refunds: the relay

1Click refunds a failed trade with a plain transfer, which the receiver cannot see arrive. An
earlier draft of 0.3 counted refunds by reading the fund's balance, with limits. An independent
review broke it before anything was deployed: a holder who dominated a fund bounced the sold token
to fake a refund, redeemed, and was paid out of another person's waiting deposit. The repair it
proposed for late deliveries did not undo that. So the read is gone.

Now every quote must name the fund's **refund relay** as `refundTo`. The relay is a second
keyless account, created with the fund, that runs the same published code in relay mode. It has
two calls and a view:

- `relay_init` runs once when the account is created. It records the fund and registers the relay
  on the fund's tokens.
- `relay_forward(token, amount)` can be called by anyone. It makes the relay send that amount to
  the fund with `ft_transfer_call` and the message `refund`. If the relay does not hold the
  amount, the call fails and nothing moves.
- `relay_fund` reports the fund it serves.

The fund counts a refund when the relay hands it over, like every other arrival. If it covers
`amount_in - refund_fee` of the trade in flight, the trade closes as refunded.

Why bouncing no longer helps: the relay holds nothing but refunds for its one fund. Someone who
bounces tokens off the relay while calling `relay_forward` either gets a failed call, or has their
own tokens passed on to the fund for good. `bouncing_off_the_relay_can_only_cost_the_bouncer`
checks after each attempt that the fund counts exactly what it holds and that the bouncer's
balance never grows. `regression_a_basket_cannot_be_drained_through_a_faked_refund` replays the
reviewer's exploit.

**No balance is read anywhere in the fund's code.** The cost of that rule:

- Tokens sent straight to a fund with a plain transfer are never counted. They stay in its balance
  for good.
- If 1Click sent a refund anywhere other than the relay, it would be lost to the fund.
- If a transfer to a 1Click deposit address was never confirmed (a lost callback) and in fact did
  not leave, the fund cannot count those tokens back.

## What has not been tested on mainnet

- **`customRecipientMsg`.** NEAR Intents documents it as the message passed to `ft_transfer_call`
  when withdrawing to NEAR, and marks it experimental. The Verifier's documentation says a
  withdrawal with a message "will use `ft_transfer_call` with no refund". No Plinth fund has received
  a real 1Click delivery this way. If 1Click gave `ft_on_transfer` too little gas, the delivery
  would bounce back to 1Click and the fund would not get it. In the sandbox the whole delivery
  transaction, token contract included, burns the gas printed by `keyless_fund_end_to_end`.
- **Real token contracts.** The sandbox uses `mock-ft`. No test here runs mainnet `wrap.near` or
  `meta-pool.near` code.

## Staking

`on_staked` counts what `deposit_and_stake` returned (Meta Pool returns the minted amount; checked
on testnet in transaction `BiYaenKfQ56b6jZFAVZbe6bmp98bmw6itqVBQ3vVShFP`), never more than
`amount / price × (1 + max_price_slippage_bps)` from the price the fund read in the same
transaction. A staking contract that returns nothing readable gets no credit.

`recover_stuck_stake` no longer infers "the NEAR is here" from the balance alone. It compares free
NEAR with a snapshot taken when the stake started, so the fund's own NEAR is never wrapped into
holdings by mistake.

## The fund without a manager

A fund created with `strategy` lets anyone call `rebalance()`. The fund asks OutLayer to run one
program, pinned by sha256 in the mandate, and treats the answer as a proposal.

What this does and does not prove:

- The fund **cannot verify the TEE on chain**. It learns the answer because OutLayer's worker account
  resumed the call. OutLayer's contract and worker accounts have full-access keys.
- So the answer is checked exactly like an operator's proposal: a trade needs a 1Click-signed quote
  that fits the mandate; a stake needs to pass the staking checks. A forged answer can do what an
  operator could do and nothing more.
- "No manager" means no account of ours can propose (`exclusive: true` makes `propose_trade` panic
  for the operator). It does not mean no trusted party: 1Click's signature and the mandate are what
  bound the damage, as everywhere else in Plinth.
- On testnet 1Click does not exist, so the strategy program signs a stand-in quote itself with a
  key compiled into it. That key is public to anyone who downloads the program. This is a testnet
  stand-in only. A mainnet strategy would fetch a real quote from 1Click.
- Redemption never touches OutLayer.

## Code and keys

- A fund has no access keys, and its code is a NEP-591 global contract **by hash**: the chain stores
  the bytes under their sha256, and no account can change what a hash runs. The verifier rejects
  funds that use a global contract *by account*, because that account could replace the code.
- The fund's wasm imports no host function that deploys code, adds or deletes keys, stakes NEAR,
  transfers NEAR or deletes the account (`contracts/check-wasm.cjs`).
- The release wasm is built with `cargo near build reproducible-wasm` in a pinned Docker image, so
  anyone can rebuild the bytes and compare the hash.

## Found while reviewing 0.3, before any deployment

An independent attacker-style review, with its own sandbox exploits, found one exploitable
weakness: the refund balance read described above. It is removed. The same review measured that a
delivery settles with 1.3 TGas given to the fund, and that the manager-less path fits in 300 TGas.
It also listed what it tried and found sound: quote replay and tampering, share and rounding
maths, settlement by third parties, callback ordering, and the factory's accounting.

A lost callback for a re-wrap of stranded NEAR that then arrives more than an hour late, while a
second re-wrap is in flight, could briefly let a joiner in before that second re-wrap is counted.
It needs a callback over an hour late and is accepted.

Two review passes of the 0.3 code (by a second engineer writing the unit tests) found bugs in the
new code itself. All are fixed, each with a unit test that failed before the fix:

- a trade id above 2^32 passed to the refund check of that draft could close a trade without
  clearing the "in flight" marker, which would have blocked trading for good (the check itself has
  since been removed);
- the stuck-stake check could be thrown off by NEAR stranded earlier or by storage growth;
- an in-kind joiner could buy a share of value the fund had not counted yet (NEAR being wrapped
  back, or the refund of a written-off trade). Joins now wait for both;
- fee maths could overflow with a share count above about 1.7e36 and stop everyone leaving;
- a callback arriving after a stuck trade was recovered could be applied twice.

Accepted limits from the same review:

- A failed payout is recorded as owed, which costs the fund a little NEAR for storage. A fund whose
  NEAR is exhausted cannot record it. Anyone can send a fund NEAR.
- During the subscription window, many small subscriptions can use the fund's NEAR down to its
  reserve; new depositors are then returned until NEAR is added or people leave.
- The factory lists every fund created through it, whatever quote signer its creator chose. The
  code hash proves what the fund runs, not that its quotes come from 1Click. The verifier checks the
  signer and says so.

## Still true, and still limits

- A keyless contract cannot be fixed. This file exists because one bug already proved that.
- 1Click is trusted to deliver or refund. The contract checks the signed quote; it cannot force
  delivery.
- The cost cap uses 1Click's own USD marks.
- If 1Click rotates its signing key, a fund can no longer trade; redemption still works.
- 1Click does not sign its app-fee field, so an operator can take a fee inside a trade, bounded by
  `max_cost_bps × max_trade_bps × max_trades_per_day` (the `max_daily_cost_bps` view).
