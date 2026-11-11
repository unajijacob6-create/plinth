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
| refund of a failed trade | see below: the one balance read left |

There is no `settle()` and no `absorb()`. A plain `ft_transfer` to a fund is never counted.

Tests (`contracts/plinth/tests/regression.rs`, run by `contracts/test.sh`):

- `regression_bounced_transfer_cannot_inflate_holdings`: the first exploit, replayed. Holdings do
  not move; both holders redeem exactly their share.
- `regression_bounced_transfer_cannot_settle_a_trade`: the second exploit, replayed. The trade stays
  in flight until the real delivery.
- `randomized_steps_keep_the_books_exact`: random subscriptions, donations, bounces, in-kind joins,
  redemptions, delivered trades and refunded trades. After every step the invariant below holds,
  shares add up, each redemption pays exactly `floor(held × shares / total)` of every token, and an
  in-kind join never lowers what one share holds.

The invariant, checked after every step of those tests:

```
ft_balance_of(fund) >= held + owed + payouts in flight + baskets      (for every token)
```

## What is still a balance read: refunds

1Click refunds a failed trade with a plain transfer, which the fund cannot see arrive. So
`settle_refund(trade_id)` reads the balance of the token sold. It is bounded four ways:

1. It only runs an hour after the trade was sent with no output (`REFUND_WAIT_SECONDS`).
2. It credits exactly `amount_in - refund_fee`, whatever the balance shows, and only if the balance
   shows at least that.
3. It runs once per trade.
4. If the trade's output arrives within a day of the quote's deadline, the credit is taken back
   (`refund_undone`) and the trade becomes `Settled`.
5. It closes 14 days after the quote's deadline (`REFUND_CLOSES_SECONDS`), so an old unresolved
   trade does not stay open to it forever.
6. Any transfer of the token that reaches the fund between the read and its result, kept or
   returned, cancels the check (`flux`). That stops the ordinary bounce. It does not stop a bounce
   whose `ft_on_transfer` never runs because the sender starved it of gas: that one leaves no trace.

**What an attacker can still do.** On a trade that has had no output for an hour, an attacker can
bounce the sold token (starved of gas) while calling `settle_refund`, and make the fund count a refund that has not
arrived. `faked_refund_is_bounded_and_undone_when_output_arrives` does exactly this and shows the
two outcomes that follow:

- 1Click then delivers: the credit is undone and the books are exact again.
- 1Click then refunds: the books are exact (the credit was the refund).

The case that is not repaired: 1Click **neither delivers nor refunds, ever**. That money is lost
either way. Without the attack every holder shares the loss. With it, the fund's books overstate
the sold token by `amount_in - refund_fee`, so holders who exit early are paid in full and the last
holders to exit are short by that amount. One trade is at most `max_trade_bps` of one token's
holding. `claim` accepts partial amounts so a holder is never stuck behind an amount the fund
cannot pay in full.

This is a real limit, not a formality. A sound fix needs the refund to arrive as a call too. One
route is to have 1Click refund into the fund's balance inside `intents.near` and let the fund
withdraw it with a message, which makes the refund a push like the output. That cannot be tested on
testnet (there is no `intents.testnet`), so it is not in this release.

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

Two review passes of the 0.3 code (by a second engineer writing the unit tests) found bugs in the
new code itself. All are fixed, each with a unit test that failed before the fix:

- a trade id above 2^32 passed to `settle_refund` could close a trade without clearing the "in
  flight" marker, which would have blocked trading for good;
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
