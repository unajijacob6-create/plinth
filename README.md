# Plinth

**A NEAR fund nobody can change, with an exit nobody can block.**

**No keys. No oracle. No manager.**

- **No keys.** A Plinth fund is a NEAR account with 0 access keys. Its code is a NEP-591 global
  contract pinned **by hash**, so no account can replace it. The release wasm is rebuilt from a
  recorded commit in a pinned Docker image, so anyone can check the bytes
  (`bash contracts/repro-check.sh`).
- **No oracle.** Money goes in and comes out **in kind**: one share per base unit during the
  subscription window, later a basket of every token in the fund's proportions. `redeem(shares)`
  pays the same fraction of every token the fund holds. No price feed is involved in any of it.
- **No manager** (optional). A fund can be created with a `strategy`: a program pinned by sha256
  that OutLayer runs when anyone calls `rebalance()`. Honest statement: the fund cannot verify the
  TEE on chain, so the program's answer is checked like any operator's proposal and bounded by the
  mandate and 1Click's signature, nothing more (see "What the chain proves vs what is trusted").

The manager, human or AI or program, can only **propose** a swap by handing the contract a signed
NEAR Intents 1Click quote. The contract checks the signature and the mandate, then sends the input
itself. 1Click delivers the output straight into the fund with a message the quote signed.

Built at the NEAR HACKATHON (November 2026) by Unaji Jacob. My other entry in this hackathon is
[Standing Order](https://github.com/unajijacob6-create/standing-order) (recurring DAO payroll).
Licence: MIT.

**Everything here is on NEAR testnet.** No Plinth fund is deployed on mainnet.

## The known issue, and what we did about it

Releases 0.1 and 0.2 had an accounting bug. `settle()` and `absorb()` credited the fund with
whatever `ft_balance_of` reported. A NEP-141 `ft_transfer_call` that is about to bounce back sits in
that balance for about two blocks, so anyone could make the fund count tokens it did not own.

- **Found** by review on 2026-11-10, after two earlier reviews had missed it.
- **Proved** with a sandbox proof of concept on the deployed 0.2 code (commit `0094ff0`,
  `contracts/plinth/tests/poc.rs` at that commit): a 10% holder left with 100% of a token and the
  90% holder was left unpaid; a trade in flight was marked settled with nothing delivered.
- **Fixed** in release 0.3 by never reading a balance. The fund counts a token only when the token
  contract pushes it in through `ft_on_transfer` and the fund keeps it, or when one of the fund's
  own calls returns it. There is no `settle()`, no `absorb()`, and no balance read anywhere in
  the contract (`contracts/plinth/src/lib.rs`, header comment).
- **Old funds frozen.** The four funds deployed before 0.3 (`fund-mwa9jwo8`, `open`, `open2`,
  `earn-mwad1ypv`, all `.plinthfund.testnet`) are keyless, so they cannot be fixed. They hold test
  tokens only. They are marked `known_issue` in `data/releases.json`; `npm run verify` fails them
  unless `--allow-known-issue` is given; the website tags them. Their depositors can still exit.
- **Reviewed again.** The 0.3 code went through three review rounds before deployment, with the
  findings and the accepted limits listed in [docs/SECURITY.md](docs/SECURITY.md) and summarised
  under "Security review" below.

The exploit code is kept as regression tests that must achieve nothing on 0.3
(`contracts/plinth/tests/regression.rs`).

## Try it

**Website:** https://unajijacob6-create.github.io/plinth/ (static; the browser reads the chain
itself).

- **Verify** a fund from the chain in your browser: keys, where the code comes from, its hash,
  forbidden imports, the refund relay, the mandate.
- **Join and exit** with a testnet wallet: take test pUSD from the faucet, join the open fund, exit
  in kind. `pusd.plinthfund.testnet` is a test token anyone can mint; it is not money.
- **Launch** a fund through the factory from your wallet (a form that checks the rules the way the
  contract will).
- **Live cards** for every fund the factory created, plus the old funds with their known-issue tag.

Open fund on release 0.3: `[[PENDING: open fund account from data/open-fund.json after deploy:open]]`
(subscription close date `[[PENDING: subscription_closes_at from data/open-fund.json]]`). Until then
the site lists the old `open2.plinthfund.testnet` with its known-issue tag; do not add money to it.

**Verify a fund from the command line** (read-only, no keys needed):

```bash
npm ci
npm run verify -- <fund-account> --network testnet
# for example, a fund the factory created:
npm run verify -- fund-mwc4ll9q.funds.plinthfund.testnet --network testnet
```

→ prints one line per check, then the mandate, operator, quote signer and holdings, and ends with
`verified: nobody can change this fund or block its exit` (exit code 0) or `NOT verified`.
`tools/verify.ts` checks, from the chain alone:

1. the account has **0 access keys**;
2. the code is a global contract **by hash** (`global_contract_hash`); a fund that follows another
   account's global contract (`global_contract_account_id`) is **rejected**, because that account
   could publish different code; the bytes are fetched and hashed;
3. the hash is a release in `data/releases.json` (`--wasm <file>` also compares a local build);
4. the wasm imports no host function that deploys code, adds or deletes keys, stakes or deletes the
   account (`contracts/check-wasm.cjs`, `contracts/wasm-reach.cjs`);
5. the fund's **refund relay** exists, has 0 keys, runs the same pinned hash, and names this fund
   (`relay_fund`);
6. the release has no known issue (0.1 and 0.2 fail here unless `--allow-known-issue`).

**Join and exit from the command line:** `npm run smoke:open` sends the same calls the website
buttons send against the open fund in `data/open-fund.json`: faucet, join (or join in kind after the
window), redeem 4,000,000 shares. `[[PENDING: smoke:open result on the 0.3 open fund]]`

## How a fund works

Code: `contracts/plinth/src/lib.rs` (fund and relay), `contracts/plinth/src/quote.rs` (1Click
signature), `contracts/factory/src/lib.rs` (factory).

**Creation.** The fund code is published once as a global contract by hash
(`npm run publish:code`). The factory (`funds.plinthfund.testnet`, 0 keys) creates two accounts in
one `create_fund` call, each in a single receipt with CreateAccount, Transfer,
UseGlobalContract(hash) and an init call, and no AddKey: the fund `<name>.<factory>` and its refund
relay `<name>-r.<factory>`. The relay runs the same code in relay mode and can only hand tokens to
its fund. If either account cannot be created the NEAR comes back. The factory keeps no power over
funds; it lists them (`get_funds`). The factory sandbox test asserts a new fund runs the published
hash, not its own copy, and uses under 5,000 bytes of storage (`contracts/factory/tests/factory.rs`).

**Subscribing.** During the subscription window, `ft_transfer_call` of the base token mints one
share per base unit. Then trading starts. The mandate (tokens, at most 4; `max_trade_bps`;
`max_cost_bps`; cooldown; trades per day; quote age; deadline margin; window; min and max
subscriptions; fee; staking; strategy) is fixed in `new()` and has no setter.

**Trades.** The operator (or the strategy's answer) hands in a 1Click quote. `check_trade` accepts it
only if, among other things:

- the quote is live and its ed25519 signature verifies over
  `base58(sha256(stable JSON of the signed fields))`, which include the deposit address;
- `recipient` is the fund, `refundTo` is the fund's relay, `refundType` is `ORIGIN_CHAIN`;
- `customRecipientMsg` is exactly `trade:<next id>`, so 1Click must deliver with
  `ft_transfer_call`;
- both tokens are in the mandate and differ; the amount is at most `max_trade_bps` of the holding;
- the all-in cost from 1Click's signed USD marks is at most `max_cost_bps`;
- the quote is fresh, its deposit address stays open long enough (but not more than 14 days) and
  was never used before; the refund fee is below the amount;
- the cooldown has passed, the day's trades are not used up, no trade is in flight.

A refusal is recorded on chain with its reason (`get_rejections`). An accepted trade registers the
deposit address on the token and transfers to it in one receipt.

**Delivery.** The output arrives by `ft_transfer_call` with `msg = "trade:<id>"`; the trade settles
inside `ft_on_transfer` once `min_out` is in. **Refunds.** 1Click refunds with a plain transfer, so
`refundTo` is the relay; anyone calls `relay_forward(token, amount)` and the relay pushes the amount
to the fund with `msg = "refund"`, which closes the trade as refunded. **Plain transfers to a fund
are never counted** (see Limits).

**Joining later** (`open_ended` funds): `open_basket`, push every token with `msg = "basket"`,
`join_in_kind(min_shares)`. The fund takes the same fraction of each holding and mints that fraction
of the shares; the rest is returned by `withdraw_basket`. Rounding favours existing holders.

**Exit.** `redeem(shares)` burns shares and pays the same fraction of every token. While a trade is
in flight the call waits up to 10 minutes; after that a redeemer leaves without their share of that
one trade. A failed payout (for example, not registered on a token) stays owed; `claim()` retries.

**Staking** (optional route): `stake_idle(amount)` unwraps wNEAR, reads the liquid-staking price,
calls `deposit_and_stake` and counts what that call returns, capped by the price read. **Fee**
(optional, at most 2%/yr): newly minted shares to the operator, accrued per second after the window,
rounded in depositors' favour; never paid in tokens.

## What the chain proves vs what is trusted

| | |
|---|---|
| **Proved by the chain** | 0 access keys on the fund, its relay and the factory (`view_access_key_list`). The code hash, pinned by NEP-591 global contract by hash. The wasm imports no code- or key-changing host function. The mandate, with no method to change it. Every refusal and trade, with its reason. In-kind exit needs no third party. |
| **Reproducible** | The 0.3 wasm rebuilds from commit `aecddbb358b7afe73aa6b0bdf52493b48bfd4fb6` in `sourcescan/cargo-near:0.23.0-rust-1.99.1` (digest in `data/releases.json`) to 311,122 bytes with hash `3j5tSNim99x5caDaQF618gJL1QdcZQTJT7yk9G4PJn23`. CI runs `contracts/repro-check.sh`. |
| **Trusted: 1Click** | To deliver with `ft_transfer_call` and the signed message, or to refund to the relay. The contract checks the signed quote; it cannot force delivery. The cost cap uses 1Click's own USD marks. If 1Click rotates its key, the fund can no longer trade; exit still works. |
| **Trusted: OutLayer** (strategy funds only) | The fund cannot verify the TEE on chain. OutLayer's contract and worker accounts have full-access keys. A forged answer can do what an operator could do and no more. |
| **Trusted: testnet stand-ins** | 1Click has no testnet. Testnet quotes are signed by a test key in 1Click's format and verified by the same code; a `solver` account pushes the output as 1Click would. `verify` labels the test signer. A mainnet fund would use 1Click's key `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`. |

## Release 0.3 on testnet

| item | value | evidence |
|---|---|---|
| fund code hash | `3j5tSNim99x5caDaQF618gJL1QdcZQTJT7yk9G4PJn23` | `data/releases.json` |
| published as a global contract by hash | [3Mpr34HR…](https://testnet.nearblocks.io/txns/3Mpr34HR8nkoMVxesjHje6qPRgkx1C5PZz9G9gBYsNwY) by `plinthfund.testnet`, 2026-11-11; one `DeployGlobalContract` action; about 31.11 NEAR burnt once (RPC `EXPERIMENTAL_tx_status`) | `data/releases.json` |
| factory | [`funds.plinthfund.testnet`](https://testnet.nearblocks.io/address/funds.plinthfund.testnet): 0 keys, `get_code_hash` returns the hash above (RPC, 2026-11-11); created in [4a4TcdVq…](https://testnet.nearblocks.io/txns/4a4TcdVq12bHhWkJe6tS86BaRL5EdumL3tQxtCVNwAvQ) with CreateAccount, Transfer, DeployContract, FunctionCall `new`, no AddKey | `data/releases.json`, RPC |
| factory code | `5w3ozPKyriikxStn8roDb4DHmHT9fbNFgvSXpe17rsPE`, 160,882 bytes | `data/releases.json`, RPC `view_account` |

## Recorded runs

Every run below is a script in `tools/` that writes a JSON file in `data/` with every transaction
hash. The runs on release 0.3 are being recorded now; placeholders mark what is not yet in the
repository.

### `npm run demo:testnet` → `data/testnet-run.json`

The whole story on one fund created by the factory: two subscriptions; three refused quotes (output
to the operator; 30% of the fund in one trade; no delivery message); one accepted trade; an attacker
who bounces tokens off the fund and calls `settle` / `absorb` (the 0.1/0.2 entry points) and off the
relay during `relay_forward`, with holdings unchanged and the attacker's balance never growing; the
delivery push that settles the trade; an in-kind join and exit; a refunded trade through the relay;
an in-kind exit. Takes about 15 minutes (2 for the window, 11 for the cooldown).

Fund: `[[PENDING: fund from data/testnet-run.json; the factory lists fund-mwc4ll9q.funds.plinthfund.testnet as created on 2026-11-11, which is the run in progress]]`

| step | result | tx |
|---|---|---|
| fund and relay created by the factory, no AddKey | `[[PENDING: access_keys_after_create]]` | `[[PENDING: tx.create_fund]]` |
| Alice and Bob subscribe | `[[PENDING: shares]]` | `[[PENDING]]` |
| quote paying the operator | refused | `[[PENDING: tx.refused_wrong_recipient]]` |
| 30% of the fund in one trade | refused | `[[PENDING: tx.refused_too_large]]` |
| quote without `customRecipientMsg` | refused | `[[PENDING: tx.refused_no_delivery_msg]]` |
| trade within the mandate | sent | `[[PENDING: tx.propose_trade]]` |
| attacker bounces and calls `settle` / `absorb` | holdings unchanged | `[[PENDING: attack txs]]` |
| solver pushes the output with `trade:<id>` | Settled inside the transfer | `[[PENDING: tx.solver_delivers]]` |
| Carol joins in kind, then exits | `[[PENDING: carol_received]]` | `[[PENDING]]` |
| second trade refunded through the relay | Refunded | `[[PENDING: refund txs]]` |
| Bob redeems | `[[PENDING: bob_received]]` | `[[PENDING: tx.bob_redeem]]` |

### `npm run deploy:open` → `data/open-fund.json`

The public open fund: joins until the close date, in-kind joins after, staking route, 1%/yr fee.
`[[PENDING: fund account, created_tx, subscription_closes_at]]`

### `npm run demo:earn` → `data/earn-run.json`

Earning against the real `wrap.testnet` and Meta Pool `meta-v2.pool.testnet`: a factory fund with
a staking route and a 1%/yr fee; a buy of wNEAR settled by the push; `stake_idle` after the
cooldown, counting what `deposit_and_stake` returns; the fee accruing; Alice exiting part in kind,
stNEAR included. Testnet staking rewards are not meaningful; the run shows the mechanics.
`[[PENDING: table from data/earn-run.json: create, buy, stake (price read, stNEAR minted), fee shares, exit amounts, txs]]`

### `npm run demo:agent` → `data/agent-run.json` (AI operator)

The operator can be an AI agent (`tools/lib/agent.ts`): a model on NEAR AI Cloud reads the fund
and a market note and decides one action. Every answer is kept with its exact request and response
bytes and NEAR AI's signature over `model:sha256(request):sha256(response)`; `verifyReceipt` and
the website check the hashes and recover the signing key. The agent gets no special protection
against prompt injection on purpose: the contract decides. Four cases: a note with a hidden
instruction to send the whole fund to an attacker; the same note to the model's safety-removed
variant (`-abliterated`, served by NEAR AI Cloud); a hijacked operator with no model that submits
the attacker's quote directly; an ordinary note.
`[[PENDING: table from data/agent-run.json on the 0.3 fund: decision, contract verdict, tx, receipt verified, per case]]`

### `npm run demo:quorum` → `data/quorum-run.json` (two models must agree)

`agree()` in `tools/lib/agent.ts` asks two model families through NEAR AI Cloud, DeepSeek and
Google Gemini (`google/gemini-2.5-flash`), and proposes only if both say trade with the same tokens
and recipient, at the smaller amount. The two receipts are not equal: DeepSeek answers are signed by
the model's enclave key; Gemini answers by a NEAR AI gateway key (`0xb98a…e779` in
`data/quorum-run.json`), and NEAR AI's attestation endpoint does not cover external providers
(`tools/lib/nearai.ts`). A Gemini receipt proves which bytes NEAR AI relayed, not where the model
ran, and Google sees the prompt.
`[[PENDING: table from data/quorum-run.json on the 0.3 fund: both votes, quorum result, tx, per case]]`

### `npm run demo:auto` → `data/auto-run.json` (no manager)

A fund created with the strategy in `data/strategy-testnet.json` (wasm sha256
`d7bf6ba8c5ff9231dba1649e7caff23ff862097dd962a624c9b8d34be584b1d1`, run by `outlayer.testnet`,
`exclusive: true`). The operator tries to propose and is refused; anyone calls `rebalance`; OutLayer
runs the program; the answer goes through the same checks as an operator's proposal; the solver
stand-in delivers. `[[PENDING: table from data/auto-run.json: fund, operator refusal, rebalance tx, decision, trade, delivery]]`

The program (`strategy/`) keeps a two-token fund near 50/50 by USD value, using 1Click's token list
for the NEAR price. Testnet stand-in: it signs its own quote with a key compiled into the wasm; that
key is public and is committed on purpose (`.keys/strategy-signer.seed`) so the build reproduces.
`strategy/evidence/` holds three live OutLayer runs on a spike fund
(`proxy.plinth-ol-spike-mwb6xcaj.testnet`) with their transactions
([4iJWpTLi…](https://testnet.nearblocks.io/txns/4iJWpTLim4G8BgLXE1x7UpPV3NuY5M5mxje5qWB6Q1oL),
[FL48pwWp…](https://testnet.nearblocks.io/txns/FL48pwWpNZXntP6oVYfuu2243Mu6NTz9ZLseWaxwj8LS),
[CsDDd62r…](https://testnet.nearblocks.io/txns/CsDDd62rgeXJqhWngrFZry1oXdtchUMhyUffaGWdAWj4)); the
host test `live_outlayer_decisions_verify` checks those decisions with the contract's own verifier.

### History on the old releases (known issue; do not add money)

Recorded on 2026-11-10 on release 0.1/0.2 funds. The trades and exits happened as recorded, but
those contracts count bounced transfers as holdings, so nothing here is evidence of safety.

- `fund-mwa9jwo8.plinthfund.testnet` (0.1, `data/testnet-run.json`, to be overwritten): created
  keyless in [CX84bz2E…](https://testnet.nearblocks.io/txns/CX84bz2E2CwsMDr4TDsRRPBYd88FETiL3tBioujhtxAL);
  two refusals; one trade; Bob redeemed 40% and received 36 pUSD and 0.008 wNEAR
  ([Gh9pA3AB…](https://testnet.nearblocks.io/txns/Gh9pA3ABYXC95CSjwiaz5PBLpSGPvd7gyEo6xxjd79ee)).
- Same fund, AI operator (`data/agent-run.json`): DeepSeek held on the injected note, its
  `-abliterated` variant held too, the hijacked operator's quote was refused by the contract
  ([6aJRb8ND…](https://testnet.nearblocks.io/txns/6aJRb8NDd1UkRTmjuTCtoWXyajYZS9XQNG5RnoCbJoDA)),
  the ordinary note led to an accepted trade. All receipts verified.
- Same fund, quorum (`data/quorum-run.json`): Gemini followed the injected instruction in both
  injected cases (trade all 34 pUSD to `attacker-wallet.testnet`); DeepSeek held; the quorum held.
  On the ordinary note DeepSeek said 8 and Gemini 5 pUSD; 5 was proposed and accepted
  ([9ga5sLjM…](https://testnet.nearblocks.io/txns/9ga5sLjML4W3zBbdLXw9QXtVgNLC5vKW5PgwY6qWHa6G)).
  Two runs are an observation, not a benchmark.
- `earn-mwad1ypv.plinthfund.testnet` (0.2, `data/earn-run.json`): `stake_idle` read a Meta Pool
  price of 3.198752 NEAR per stNEAR and 0.343884 stNEAR were minted
  ([BiYaenKf…](https://testnet.nearblocks.io/txns/BiYaenKfQ56b6jZFAVZbe6bmp98bmw6itqVBQ3vVShFP));
  Alice exited half in kind (22.499995 pUSD, 1.699999 wNEAR, 0.171942 stNEAR).

## Security review

Full text: [docs/SECURITY.md](docs/SECURITY.md). In short:

- **Releases 0.1 and 0.2.** Two earlier reviews led to fixes that are kept as `audit_*` and
  `audit2_*` tests (`contracts/plinth/src/tests.rs`, `contracts/plinth/tests/sandbox.rs`). Neither
  review found the balance bug above.
- **0.3, round one** (independent, attacker-style, own sandbox exploits): one exploitable weakness
  in an earlier draft, a refund balance read, removed before deployment; the refund relay replaced
  it. Also measured: a delivery settles with 1.3 TGas given to the fund; the manager-less path fits
  in 300 TGas. Tried and found sound: quote replay and tampering, share and rounding maths,
  settlement by third parties, callback ordering, the factory's accounting.
- **0.3, rounds two and three** (a second engineer writing the unit tests): five bugs in the new
  code, each fixed with a unit test that failed before the fix: a trade id above 2^32 in a check
  since removed; the stuck-stake check thrown off by stranded NEAR or storage growth; in-kind
  joiners buying a share of value not yet counted; fee maths overflowing above about 1.7e36 shares;
  a late callback applied twice after a stuck trade was recovered.
- **Accepted limits** from the reviews: anyone can pay a trade's refund amount to the relay and
  close that trade as refunded (the fund keeps both amounts, the payer loses); nothing on chain
  checks that a relay's fund names it back (the factory sets both, the verifier checks both
  directions); a failed payout needs a little NEAR for storage; many small subscriptions can use
  the fund's NEAR down to its reserve; the factory lists funds whatever quote signer their creator
  chose, and the verifier says which signer it is; a re-wrap callback over an hour late could
  briefly let a joiner in early.

No review is called an audit here, and none covers mainnet token contracts.

## Limits

- **Testnet only.** No mainnet fund. 1Click quotes on testnet are signed by a test key and
  delivered by a solver account. The only mainnet evidence is a recorded real 1Click quote the
  signature check is tested against.
- **`customRecipientMsg` is untested on mainnet.** From docs/SECURITY.md: "NEAR Intents documents
  it as the message passed to `ft_transfer_call` when withdrawing to NEAR, and marks it
  experimental. The Verifier's documentation says a withdrawal with a message 'will use
  `ft_transfer_call` with no refund'. No Plinth fund has received a real 1Click delivery this way.
  If 1Click gave `ft_on_transfer` too little gas, the delivery would bounce back to 1Click and the
  fund would not get it."
- **The cost of reading no balance.** Tokens sent to a fund with a plain `ft_transfer` are never
  counted and stay there. A refund 1Click sent anywhere but the relay is lost to the fund. A
  transfer to a deposit address whose callback was lost cannot be counted back.
- **No fixes.** A keyless contract cannot be upgraded; a bug is permanent. This README exists
  partly because one already was.
- **Real token contracts.** The sandbox uses `contracts/mock-ft`. No test runs mainnet `wrap.near`
  or `meta-pool.near` code.
- **App fees.** 1Click does not sign `appFees`, so an operator can take a fee inside a trade,
  bounded by `max_cost_bps × max_trade_bps × max_trades_per_day` (the `max_daily_cost_bps` view).
- **At most 4 tokens**, so one redemption pays every token in one transaction.
- **Closed-end window, then in kind.** Subscriptions in the base token happen before trading;
  later joins are baskets.
- **The strategy's answer is trusted as an operator's would be**, and on testnet its quote signer
  is a public key anyone can extract from the program.

## Run the tests

| command | what it runs | expected |
|---|---|---|
| `npm ci && npm test` | 121 tools and API tests: 1Click client against real quote fixtures, release 0.3 tool rules, verifier classification, basket maths, API routes without network | `# pass 121` (ran here on 2026-11-11: 121 pass, 0 fail) |
| `bash contracts/test.sh` | builds fund, mock token and factory with cargo-near; `check-wasm.cjs` proves no export reaches a code- or key-changing host call; 158 unit tests (152 in `src/tests.rs`, 6 in `quote.rs`); 4 end-to-end sandbox tests (`tests/sandbox.rs`); 6 regression and invariant tests (`tests/regression.rs`); 1 factory sandbox test | `plinth: all checks passed` |
| `bash contracts/repro-check.sh` | rebuilds each reproducible release from its commit in the pinned image and compares the hash with `data/releases.json` (needs docker, cargo-near 0.23, git history) | `release 0.3: rebuilt bytes hash to 3j5tSNim…, as recorded` |
| `npm run typecheck` | tools, API and site | no output |
| `npm run web:build && npm run web:preview &` then `npm run test:web` | Playwright smoke test of the site at phone and desktop width: no console errors, fund cards from testnet RPC, known-issue tags, deep links, launch form validation, receipts (`web/tests/smoke.mjs`; CI runs it) | exits 0 |
| `cd strategy/host-test && cargo test` | 10 tests: the strategy's decisions verified with the contract's own quote code, including the three live OutLayer runs in `strategy/evidence/` | `10 passed` (ran here on 2026-11-11) |
| `npm run verify -- <fund> --network testnet` | the read-only verifier above | `verified: …` |

The regression tests (`contracts/plinth/tests/regression.rs`): `regression_bounced_transfer_cannot_inflate_holdings`,
`regression_bounced_transfer_cannot_settle_a_trade`, `refund_arrives_through_the_relay`,
`bouncing_off_the_relay_can_only_cost_the_bouncer`,
`regression_a_basket_cannot_be_drained_through_a_faked_refund`, `randomized_steps_keep_the_books_exact`.
After every step they check, for every token,
`ft_balance_of(fund) >= held + owed + payouts in flight + baskets`.

## Repository map

```
contracts/plinth/src/lib.rs      the fund contract and its relay mode (Rust, near-sdk 5.30)
contracts/plinth/src/quote.rs    1Click quote signature check
contracts/plinth/src/tests.rs    unit tests
contracts/plinth/tests/          sandbox.rs (end to end), regression.rs (the bug as tests), fixtures/
contracts/factory/               the fund factory and its sandbox test
contracts/mock-ft/               NEP-141 test token for the sandbox (enforces storage registration)
contracts/check-wasm.cjs, wasm-reach.cjs   immutability check on the compiled wasm
contracts/test.sh, repro-check.sh          build and test; reproducible-build check
data/releases.json               release hashes, known issues, reproducible-build record, factory
data/*-run.json, open-fund.json  recorded testnet runs
data/strategy-testnet.json       the manager-less fund's strategy (wasm hash, OutLayer, signer)
docs/SECURITY.md                 what is relied on, what was broken, what is still unproven
docs/VERCEL.md                   the optional server routes and how to deploy them
tools/                           verify, deploy, publish, factory, operator, operate, the demos, faucet
tools/lib/                       1Click client, NEAR AI client with receipts, agent and quorum, solver stand-in
tools/test/                      the tools' tests (npm test)
web/                             the site (Vite): verifier, fund cards, wallet actions, launch form
web/tests/smoke.mjs              site smoke test
api/index.ts, api/_lib/, api/_test/   the Vercel function, its code and tests
strategy/                        the WASI strategy program; evidence/ (live OutLayer runs); host-test/
.github/workflows/               ci (contracts, repro check, tools and site), pages
```

## Vercel / API layer (not deployed yet)

`api/index.ts` is one Vercel Function behind `/api/<route>` and `/f/<fund>`: a 1Click quote proxy,
the 1Click token list, a fund list and fund summary from the factory, a share page with a preview
picture drawn from the chain, and an AI operator demo that proposes nothing on chain. It holds no
NEAR key and cannot move a fund's money. Verification stays in the browser and in `npm run verify`.
The configuration was built locally with `vercel build` but **has not been deployed**; the site on
GitHub Pages uses none of it. Owner setup, variables and limits: [docs/VERCEL.md](docs/VERCEL.md).
Tests: `npm run test:api`.

## Credits and licence

Reused, disclosed: the 1Click quote verifier is adapted from
[Standing Order](https://github.com/unajijacob6-create/standing-order) (same author, same hackathon),
and `contracts/wasm-reach.cjs` is the same author's earlier code from this hackathon window.
Dependencies: near-sdk,
near-workspaces, near-api-js, @hot-labs/near-connect, @noble/curves, @noble/hashes, bs58, Vite,
Playwright, Manrope and JetBrains Mono fonts. Services: NEAR Intents 1Click (quotes), NEAR AI Cloud
(the AI operator), OutLayer (the strategy runs), public NEAR RPC. Written with Claude Code.

MIT. Copyright (c) 2026 Unaji Jacob.
