//! Regression, invariant and randomized tests for the accounting bug of releases 0.1 and 0.2.
//!
//! The bug: `settle()` and `absorb()` credited whatever `ft_balance_of` reported. A
//! `ft_transfer_call` that is about to bounce sits in that balance for about two blocks, so anyone
//! could make the fund count tokens it did not own (drain other holders; mark a trade settled
//! with nothing delivered). The exploit code below is the original proof of concept, unchanged in
//! what the attacker does; on release 0.3 it must achieve nothing.
//!
//! The invariant checked after every step: for each token,
//!   ft_balance_of(fund) >= held + owed + payouts in flight + baskets.
//! Build first: `bash contracts/test.sh`.

use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const PLINTH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/plinth/plinth.wasm");
const MOCK_FT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/mock_ft/mock_ft.wasm");
const STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

fn sk() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A live 1Click-shaped quote signed with the test key, using the contract's own message rule.
fn quote(sell: &AccountId, buy: &AccountId, amount: u128, out: u128, min_out: u128, recipient: &AccountId, deposit: &str, issued: u64, trade_id: u64) -> String {
    let req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": format!("nep141:{sell}"), "depositType": "ORIGIN_CHAIN", "destinationAsset": format!("nep141:{buy}"),
        "amount": amount.to_string(), "refundTo": recipient, "refundType": "ORIGIN_CHAIN", "recipient": recipient,
        "recipientType": "DESTINATION_CHAIN", "deadline": iso(issued + 600), "quoteWaitingTimeMs": 0,
        "customRecipientMsg": format!("trade:{trade_id}"),
    });
    let q = json!({
        "amountIn": amount.to_string(), "amountInFormatted": "10.0", "amountInUsd": "10.000000", "minAmountIn": amount.to_string(),
        "amountOut": out.to_string(), "amountOutFormatted": "2.7", "amountOutUsd": "9.990000", "minAmountOut": min_out.to_string(),
        "timeEstimate": 22, "refundFee": "4500", "deadline": iso(issued + 3 * 86_400), "timeWhenInactive": iso(issued + 3 * 86_400), "depositAddress": deposit,
    });
    let ts = iso(issued);
    let msg = plinth::quote::signed_message(&near_sdk::serde_json::from_value(req.clone()).unwrap(), &near_sdk::serde_json::from_value(q.clone()).unwrap(), &ts).unwrap();
    let sig = sk().sign(msg.as_bytes());
    json!({"quote": q, "quoteRequest": req, "timestamp": ts, "signature": format!("ed25519:{}", bs58::encode(sig.to_bytes()).into_string())}).to_string()
}

async fn now_s(worker: &Worker<near_workspaces::network::Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

async fn token(worker: &Worker<near_workspaces::network::Sandbox>, root: &Account, name: &str) -> anyhow::Result<Contract> {
    let acc = root.create_subaccount(name).initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let c = acc.deploy(&std::fs::read(MOCK_FT)?).await?.into_result()?;
    c.call("new").transact().await?.into_result()?;
    let _ = worker;
    Ok(c)
}

async fn register(who: &Account, t: &Contract) -> anyhow::Result<()> {
    who.call(t.id(), "storage_deposit").args_json(json!({})).deposit(STORAGE).transact().await?.into_result()?;
    Ok(())
}

async fn balance(t: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(t.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json::<String>()?.parse()?)
}

async fn fund_view(worker: &Worker<near_workspaces::network::Sandbox>, fund: &AccountId) -> anyhow::Result<Value> {
    Ok(worker.view(fund, "get_fund").await?.json()?)
}

fn cfg(tokens: Vec<String>, op: &AccountId, close: u64) -> Value {
    json!({
        "mandate": {
            "tokens": tokens, "max_trade_bps": 2500, "max_cost_bps": 100,
            "min_seconds_between_trades": 660, "max_trades_per_day": 50, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000000", "open_ended": true,
        },
        "operator": op,
        "quote_signer": format!("ed25519:{}", bs58::encode(sk().verifying_key().to_bytes()).into_string()),
        "storage_deposit": STORAGE.as_yoctonear().to_string(),
    })
}

type Sb = Worker<near_workspaces::network::Sandbox>;

fn num_u64(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

fn num(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

/// The invariant: the fund's real balance of every token covers everything it accounts for.
async fn invariant(worker: &Sb, fund: &AccountId, tokens: &[&Contract], at: &str) -> anyhow::Result<()> {
    let v = fund_view(worker, fund).await?;
    for (i, t) in tokens.iter().enumerate() {
        let accounted = num(&v["held"][i][1]) + num(&v["owed_total"][i]) + num(&v["in_flight_payouts"][i]) + num(&v["basket_total"][i]);
        let bal = balance(t, fund).await?;
        assert!(bal >= accounted, "invariant broken {at}: token {i} balance {bal} < accounted {accounted} ({v})");
    }
    Ok(())
}

async fn push(who: &Account, t: &Contract, fund: &AccountId, amount: u128, msg: &str) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who.call(t.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund, "amount": amount.to_string(), "msg": msg}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?)
}

async fn mint(root: &Account, t: &Contract, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    root.call(t.id(), "mint").args_json(json!({"account_id": to, "amount": amount.to_string()})).transact().await?.into_result()?;
    Ok(())
}

async fn create(worker: &Sb, root: &Account, fund_id: &AccountId, tokens: Vec<String>, op: &AccountId, close: u64) -> anyhow::Result<()> {
    let r = root.batch(fund_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": cfg(tokens, op, close)})).deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(200)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(worker.view_access_keys(fund_id).await?.is_empty(), "keyless");
    Ok(())
}

async fn wait_until(worker: &Sb, t: u64) -> anyhow::Result<()> {
    while now_s(worker).await? < t {
        worker.fast_forward(200).await?;
    }
    Ok(())
}

/// Release 0.1/0.2 exploit 1 (phantom absorb): a 10% holder bounced tokens off the fund while
/// `absorb` read the balance, and left with 100% of the token. On 0.3 there is no `absorb`, a
/// bounce changes nothing, and both holders get exactly their share.
#[tokio::test]
async fn regression_bounced_transfer_cannot_inflate_holdings() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let t2 = token(&worker, &root, "ttwo").await?;
    let mk = |n: &'static str| root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact();
    let alice = mk("alice").await?.into_result()?;
    let mallory = mk("mallory").await?.into_result()?;
    let eve = mk("eve").await?.into_result()?;
    for a in [&alice, &mallory] { register(a, &usdc).await?; register(a, &t2).await?; }
    mint(&root, &usdc, alice.id(), 90_000_000).await?;
    mint(&root, &usdc, mallory.id(), 10_000_000).await?;
    mint(&root, &t2, mallory.id(), 1_000_000_000).await?;
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 3600;
    create(&worker, &root, &fund_id, vec![usdc.id().to_string(), t2.id().to_string()], root.id(), close).await?;
    let toks = [&usdc, &t2];
    for (who, amt) in [(&alice, 90_000_000u128), (&mallory, 10_000_000)] {
        push(who, &usdc, &fund_id, amt, "").await?.into_result()?;
    }
    // A real 100,000,000 of t2 reaches the fund and is counted: pushed, so the fund sees it arrive.
    push(&mallory, &t2, &fund_id, 100_000_000, "donate").await?.into_result()?;
    let v = fund_view(&worker, &fund_id).await?;
    assert_eq!(num(&v["held"][1][1]), 100_000_000);
    // A plain transfer is NOT counted (the fund cannot see it arrive), and nothing can make it count.
    mallory.call(t2.id(), "ft_transfer").args_json(json!({"receiver_id": fund_id, "amount": "7"})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    // The attack, as in the proof of concept: bounce 900,000,000 t2 off the fund while someone
    // tries every balance-reading entry point in the same blocks.
    for attempt in 0..6 {
        let bounce = push(&mallory, &t2, &fund_id, 800_000_000, "");
        let absorb = eve.call(&fund_id, "absorb").args_json(json!({"token_index": 1})).gas(Gas::from_tgas(50)).transact();
        let settle = eve.call(&fund_id, "settle").gas(Gas::from_tgas(100)).transact();
        let refund = eve.call(&fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact();
        let (a, b, c, d) = tokio::join!(bounce, absorb, settle, refund);
        assert!(a?.is_success(), "the bounce itself is an ordinary transfer");
        assert!(b?.is_failure() && c?.is_failure() && d?.is_failure(), "no balance-reading method exists or applies");
        let v = fund_view(&worker, &fund_id).await?;
        assert_eq!(num(&v["held"][1][1]), 100_000_000, "attempt {attempt}: holdings unchanged");
        invariant(&worker, &fund_id, &toks, "after a bounce").await?;
    }
    assert_eq!(balance(&t2, mallory.id()).await?, 900_000_000 - 7, "every bounced token went back");
    // Both redeem: exactly pro rata.
    mallory.call(&fund_id, "redeem").args_json(json!({"shares": "10000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    assert_eq!(balance(&t2, mallory.id()).await?, 900_000_000 - 7 + 10_000_000, "10% of the shares, 10% of the token");
    alice.call(&fund_id, "redeem").args_json(json!({"shares": "90000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    assert_eq!(balance(&t2, alice.id()).await?, 90_000_000, "90% of the shares, 90% of the token");
    let owed: Vec<String> = worker.view(&fund_id, "get_owed").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert!(owed.is_empty(), "nothing left unpaid");
    invariant(&worker, &fund_id, &toks, "at the end").await?;
    Ok(())
}

struct TradeSetup {
    worker: Sb,
    root: Account,
    usdc: Contract,
    wnear: Contract,
    alice: Account,
    mallory: Account,
    operator: Account,
    eve: Account,
    solver: Account,
    fund_id: AccountId,
}

const AMOUNT_IN: u128 = 10_000_000;
const MIN_OUT: u128 = 2_690_000_000_000_000_000_000_000;
const REFUND: u128 = AMOUNT_IN - 4500;

/// A fund with 100 USDC from Alice and one trade (10 USDC -> wNEAR) in flight.
async fn trade_in_flight() -> anyhow::Result<TradeSetup> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let wnear = token(&worker, &root, "wnear").await?;
    let mk = |n: &'static str| root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact();
    let alice = mk("alice").await?.into_result()?;
    let mallory = mk("mallory").await?.into_result()?;
    let operator = mk("operator").await?.into_result()?;
    let eve = mk("eve").await?.into_result()?;
    let solver = mk("solver").await?.into_result()?;
    for a in [&alice, &mallory, &solver] { register(a, &usdc).await?; register(a, &wnear).await?; }
    mint(&root, &usdc, alice.id(), 100_000_000).await?;
    mint(&root, &usdc, mallory.id(), 50_000_000).await?;
    mint(&root, &usdc, solver.id(), 50_000_000).await?;
    mint(&root, &wnear, mallory.id(), 5_000_000_000_000_000_000_000_000).await?;
    mint(&root, &wnear, solver.id(), 5_000_000_000_000_000_000_000_000).await?;
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 12;
    create(&worker, &root, &fund_id, vec![usdc.id().to_string(), wnear.id().to_string()], operator.id(), close).await?;
    push(&alice, &usdc, &fund_id, 100_000_000, "").await?.into_result()?;
    wait_until(&worker, close).await?;
    let now = now_s(&worker).await?;
    let good = quote(usdc.id(), wnear.id(), AMOUNT_IN, 2_700_000_000_000_000_000_000_000, MIN_OUT, &fund_id, &"d".repeat(64), now, 0);
    let ok: bool = operator.call(&fund_id, "propose_trade").args_json(json!({"quote": good})).gas(Gas::from_tgas(200)).transact().await?.json()?;
    assert!(ok);
    Ok(TradeSetup { worker, root, usdc, wnear, alice, mallory, operator, eve, solver, fund_id })
}

/// Release 0.1/0.2 exploit 2 (phantom settle): anyone closed a trade in flight as Settled by
/// bouncing the output token while `settle` read the balance. On 0.3 a bounce cannot settle
/// anything; only a delivery the fund keeps does.
#[tokio::test]
async fn regression_bounced_transfer_cannot_settle_a_trade() -> anyhow::Result<()> {
    let s = trade_in_flight().await?;
    let toks = [&s.usdc, &s.wnear];
    for attempt in 0..6 {
        let bounce = push(&s.mallory, &s.wnear, &s.fund_id, MIN_OUT, "");
        let settle = s.eve.call(&s.fund_id, "settle").gas(Gas::from_tgas(100)).transact();
        let refund = s.eve.call(&s.fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact();
        let (a, b, c) = tokio::join!(bounce, settle, refund);
        assert!(a?.is_success());
        assert!(b?.is_failure(), "there is no settle()");
        assert!(c?.is_failure(), "a refund check is not allowed this early");
        let v = fund_view(&s.worker, &s.fund_id).await?;
        assert_eq!(v["pending"]["status"], "Sent", "attempt {attempt}: still in flight");
        assert_eq!(num(&v["held"][1][1]), 0, "attempt {attempt}: no wNEAR counted");
        invariant(&s.worker, &s.fund_id, &toks, "after a bounce").await?;
    }
    assert_eq!(balance(&s.wnear, &s.fund_id).await?, 0);
    // The real delivery settles it.
    push(&s.solver, &s.wnear, &s.fund_id, MIN_OUT, "trade:0").await?.into_result()?;
    let v = fund_view(&s.worker, &s.fund_id).await?;
    assert!(v["pending"].is_null());
    assert_eq!(num(&v["held"][1][1]), MIN_OUT);
    assert_eq!(balance(&s.wnear, &s.fund_id).await?, MIN_OUT);
    invariant(&s.worker, &s.fund_id, &toks, "after settlement").await?;
    let _ = (&s.root, &s.alice, &s.operator);
    Ok(())
}

/// An honest refund (a plain transfer back from 1Click) is counted once, an hour after the trade
/// was sent, for exactly amount_in - refund_fee.
#[tokio::test]
async fn refund_is_counted_once_and_exactly() -> anyhow::Result<()> {
    let s = trade_in_flight().await?;
    let toks = [&s.usdc, &s.wnear];
    let sent = now_s(&s.worker).await?;
    // 1Click refunds a little more than the floor (it charged less than the stated refund fee).
    s.solver.call(s.usdc.id(), "ft_transfer").args_json(json!({"receiver_id": s.fund_id, "amount": (REFUND + 100).to_string()})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let r = s.eve.call(&s.fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.is_failure(), "too early");
    wait_until(&s.worker, sent + 3700).await?;
    let st: Value = s.eve.call(&s.fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact().await?.json()?;
    assert_eq!(st, "Refunded");
    let v = fund_view(&s.worker, &s.fund_id).await?;
    assert!(v["pending"].is_null());
    assert_eq!(num(&v["held"][0][1]), 90_000_000 + REFUND, "exactly amount_in - refund_fee, not the 100 extra");
    let r = s.eve.call(&s.fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.is_failure(), "only once");
    invariant(&s.worker, &s.fund_id, &toks, "after the refund").await?;
    Ok(())
}

/// The one place a balance is still read is the refund check, and it is bounded: only an hour
/// after a trade got no output, only amount_in - refund_fee, only once, and it is taken back when
/// the output arrives after all. This test plays the worst case: an attacker bounces the sold
/// token to fake a refund on a trade 1Click is late on, then 1Click delivers.
#[tokio::test]
async fn faked_refund_is_bounded_and_undone_when_output_arrives() -> anyhow::Result<()> {
    let s = trade_in_flight().await?;
    let toks = [&s.usdc, &s.wnear];
    let sent = now_s(&s.worker).await?;
    wait_until(&s.worker, sent + 3700).await?;
    let mut faked = false;
    for _ in 0..6 {
        let bounce = push(&s.mallory, &s.usdc, &s.fund_id, 40_000_000, "");
        let refund = s.eve.call(&s.fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact();
        let (a, b) = tokio::join!(bounce, refund);
        a?.into_result()?;
        let st: Value = b?.json().unwrap_or(Value::Null);
        if st == "Refunded" { faked = true; break; }
    }
    let v = fund_view(&s.worker, &s.fund_id).await?;
    println!("faked refund landed: {faked}; held USDC {} / real {}", v["held"][0][1], balance(&s.usdc, &s.fund_id).await?);
    if faked {
        assert_eq!(num(&v["held"][0][1]), 90_000_000 + REFUND, "at most amount_in - refund_fee, whatever was bounced");
    }
    // 1Click delivers late. The trade becomes Settled and the faked refund is taken back.
    push(&s.solver, &s.wnear, &s.fund_id, MIN_OUT, "trade:0").await?.into_result()?;
    let v = fund_view(&s.worker, &s.fund_id).await?;
    let trades: Value = s.worker.view(&s.fund_id, "get_trades").args_json(json!({"from": 0, "limit": 5})).await?.json()?;
    assert_eq!(trades[0]["status"], "Settled", "{trades}");
    assert_eq!(num(&v["held"][0][1]), 90_000_000);
    assert_eq!(num(&v["held"][1][1]), MIN_OUT);
    assert!(v["pending"].is_null());
    invariant(&s.worker, &s.fund_id, &toks, "after the late delivery").await?;
    Ok(())
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

async fn shares_of(worker: &Sb, fund: &AccountId, who: &AccountId) -> anyhow::Result<u128> {
    Ok(worker.view(fund, "get_shares").args_json(json!({"account_id": who})).await?.json::<String>()?.parse()?)
}

/// Random subscribe / donate / bounce / join in kind / redeem / trade-and-settle / trade-and-refund
/// steps. After every step: the invariant holds, the holders' shares add up to the total, every
/// redemption pays exactly floor(held x shares / total) of each token, and an in-kind join never
/// lowers what one share holds.
#[tokio::test]
async fn randomized_steps_keep_the_books_exact() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let wnear = token(&worker, &root, "wnear").await?;
    let toks = [&usdc, &wnear];
    let mut people = vec![];
    for n in ["alice", "bob", "carol", "mallory", "solver"] {
        let a = root.create_subaccount(n).initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
        for t in toks { register(&a, t).await?; }
        mint(&root, &usdc, a.id(), 1_000_000_000_000).await?;
        mint(&root, &wnear, a.id(), 1_000_000_000_000_000_000_000_000_000).await?;
        people.push(a);
    }
    let operator = root.create_subaccount("operator").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let (holders, mallory, solver) = (&people[..3], &people[3], &people[4]);
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 25;
    create(&worker, &root, &fund_id, vec![usdc.id().to_string(), wnear.id().to_string()], operator.id(), close).await?;
    let seed: u64 = std::env::var("PLINTH_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0x9E3779B97F4A7C15);
    let steps: u64 = std::env::var("PLINTH_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(24);
    let mut rng = Rng(seed);
    for h in holders {
        push(h, &usdc, &fund_id, 20_000_000 + rng.below(80_000_000) as u128, "").await?.into_result()?;
    }
    wait_until(&worker, close).await?;
    push(solver, &wnear, &fund_id, 7_000_000_000_000_000_000_000_000 + rng.below(1_000_000_000) as u128, "donate").await?.into_result()?;
    let mut last_trade = 0u64;
    let mut next_trade_id = 0u64;
    // A refunded trade waits an hour of chain time, which is slow on a local node: at most two per run.
    let mut refunds_done = 0u32;
    for step in 0..steps {
        let op = rng.below(6);
        let v = fund_view(&worker, &fund_id).await?;
        let held = [num(&v["held"][0][1]), num(&v["held"][1][1])];
        let total = num(&v["total_shares"]);
        let label = match op {
            0 => {
                let i = rng.below(2) as usize;
                let amt = 1 + rng.below(5_000_000) as u128 * if i == 1 { 1_000_000_000_000 } else { 1 };
                push(&people[rng.below(5) as usize], toks[i], &fund_id, amt, "donate").await?.into_result()?;
                let v2 = fund_view(&worker, &fund_id).await?;
                assert_eq!(num(&v2["held"][i][1]), held[i] + amt);
                "donate"
            }
            1 => {
                let i = rng.below(2) as usize;
                let before = balance(toks[i], mallory.id()).await?;
                let bounce = push(mallory, toks[i], &fund_id, 500_000_000_000, "");
                let refund = people[0].call(&fund_id, "settle_refund").args_json(json!({"trade_id": next_trade_id.saturating_sub(1)})).gas(Gas::from_tgas(100)).transact();
                let (a, b) = tokio::join!(bounce, refund);
                a?.into_result()?;
                let _ = b?;
                assert_eq!(balance(toks[i], mallory.id()).await?, before, "a bounce returns everything");
                let v2 = fund_view(&worker, &fund_id).await?;
                assert_eq!([num(&v2["held"][0][1]), num(&v2["held"][1][1])], held, "a bounce changes no holding");
                "bounce"
            }
            2 => {
                let h = &holders[rng.below(3) as usize];
                let mine = shares_of(&worker, &fund_id, h.id()).await?;
                if mine == 0 { "redeem (no shares)" } else {
                    let burn = (1 + rng.below(1000) as u128 * mine / 1000).min(mine);
                    let before = [balance(&usdc, h.id()).await?, balance(&wnear, h.id()).await?];
                    h.call(&fund_id, "redeem").args_json(json!({"shares": burn.to_string()})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
                    for i in 0..2 {
                        let want = (num256(held[i], burn, total)) as u128;
                        assert_eq!(balance(toks[i], h.id()).await? - before[i], want, "step {step}: redeem pays exactly pro rata of token {i}");
                    }
                    "redeem"
                }
            }
            3 => {
                if total == 0 { "join (no shares to price against)" } else {
                    let j = &people[rng.below(4) as usize];
                    let want = 1 + rng.below(50) as u128 * total / 1000;
                    j.call(&fund_id, "open_basket").deposit(NearToken::from_millinear(5)).transact().await?.into_result()?;
                    let before = [balance(&usdc, j.id()).await?, balance(&wnear, j.id()).await?];
                    for i in 0..2 {
                        if held[i] > 0 {
                            let need = ceil256(want, held[i], total) + rng.below(3) as u128 * rng.below(1000) as u128;
                            push(j, toks[i], &fund_id, need, "basket").await?.into_result()?;
                        }
                    }
                    let s0 = shares_of(&worker, &fund_id, j.id()).await?;
                    let got: String = j.call(&fund_id, "join_in_kind").args_json(json!({"min_shares": want.to_string()})).gas(Gas::from_tgas(100)).transact().await?.json()?;
                    let got: u128 = got.parse()?;
                    assert!(got >= want);
                    assert_eq!(shares_of(&worker, &fund_id, j.id()).await?, s0 + got);
                    let v2 = fund_view(&worker, &fund_id).await?;
                    let total2 = num(&v2["total_shares"]);
                    assert_eq!(total2, total + got);
                    let mut paid = [0u128; 2];
                    for i in 0..2 {
                        let h2 = num(&v2["held"][i][1]);
                        // per-share holdings never fall: h2 / total2 >= held / total
                        assert!(ge256(h2, total, held[i], total2), "step {step}: join diluted token {i}");
                        paid[i] = h2 - held[i];
                    }
                    j.call(&fund_id, "withdraw_basket").gas(Gas::from_tgas(150)).transact().await?.into_result()?;
                    for i in 0..2 {
                        assert_eq!(before[i] - balance(toks[i], j.id()).await?, paid[i], "step {step}: the joiner paid exactly what the fund took of token {i}");
                    }
                    "join in kind"
                }
            }
            _ => {
                let (sell, buy) = if rng.below(2) == 0 { (0usize, 1usize) } else { (1, 0) };
                let amount = held[sell] * (1 + rng.below(20) as u128) / 100;
                if amount == 0 { "trade (nothing to sell)" } else {
                    wait_until(&worker, last_trade + 700).await?;
                    let now = now_s(&worker).await?;
                    let out = if buy == 1 { 2_000_000_000_000_000_000_000_000 + rng.below(1_000_000) as u128 } else { 3_000_000 + rng.below(1_000_000) as u128 };
                    let q = quote(toks[sell].id(), toks[buy].id(), amount, out, out, &fund_id, &format!("{:064x}", step + 1), now, next_trade_id);
                    let ok: bool = operator.call(&fund_id, "propose_trade").args_json(json!({"quote": q})).gas(Gas::from_tgas(200)).transact().await?.json()?;
                    if !ok {
                        // The only refusal an in-mandate trade can meet here is the daily cap.
                        let n = num_u64(&fund_view(&worker, &fund_id).await?["rejections"]);
                        let rej: Value = worker.view(&fund_id, "get_rejections").args_json(json!({"from": n - 1, "limit": 1})).await?.json()?;
                        assert!(rej[0]["reason"].as_str().unwrap().contains("trades for today"), "step {step}: unexpected refusal {rej}");
                        last_trade = now;
                    }
                    let id = next_trade_id;
                    if !ok { "trade (daily cap reached)" } else if op == 4 || refunds_done >= 2 {
                        last_trade = now_s(&worker).await?;
                        next_trade_id += 1;
                        push(solver, toks[buy], &fund_id, out, &format!("trade:{id}")).await?.into_result()?;
                        let v2 = fund_view(&worker, &fund_id).await?;
                        assert!(v2["pending"].is_null());
                        assert_eq!(num(&v2["held"][buy][1]), held[buy] + out);
                        assert_eq!(num(&v2["held"][sell][1]), held[sell] - amount);
                        "trade, delivered"
                    } else {
                        last_trade = now_s(&worker).await?;
                        next_trade_id += 1;
                        refunds_done += 1;
                        // 1Click refunds instead: a plain transfer, counted an hour later.
                        let refund = amount.saturating_sub(4500);
                        solver.call(toks[sell].id(), "ft_transfer").args_json(json!({"receiver_id": fund_id, "amount": refund.to_string()})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
                        wait_until(&worker, last_trade + 3700).await?;
                        let r = people[1].call(&fund_id, "settle_refund").args_json(json!({"trade_id": id})).gas(Gas::from_tgas(100)).transact().await?;
                        let v2 = fund_view(&worker, &fund_id).await?;
                        if refund > 0 {
                            assert_eq!(r.json::<Value>()?, "Refunded");
                            assert_eq!(num(&v2["held"][sell][1]), held[sell] - amount + refund);
                        } else {
                            // Too small to refund anything: it stays in flight; write the books as they are.
                            assert_eq!(v2["pending"]["status"], "Sent");
                            // Deliver so the run can go on.
                            push(solver, toks[buy], &fund_id, out, &format!("trade:{id}")).await?.into_result()?;
                        }
                        "trade, refunded"
                    }
                }
            }
        };
        invariant(&worker, &fund_id, &toks, &format!("after step {step} ({label})")).await?;
        let v = fund_view(&worker, &fund_id).await?;
        let mut sum = shares_of(&worker, &fund_id, operator.id()).await?;
        for p in &people { sum += shares_of(&worker, &fund_id, p.id()).await?; }
        assert_eq!(sum, num(&v["total_shares"]), "step {step}: shares add up");
        println!("step {step:>2}: {label:<28} held {} / {}  shares {}", v["held"][0][1], v["held"][1][1], v["total_shares"]);
    }
    // Everyone leaves; the fund ends with nothing owed and the books still covered.
    wait_until(&worker, last_trade + 700).await?;
    for p in &people {
        let mine = shares_of(&worker, &fund_id, p.id()).await?;
        if mine > 0 {
            p.call(&fund_id, "redeem").args_json(json!({"shares": mine.to_string()})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
        }
    }
    let v = fund_view(&worker, &fund_id).await?;
    assert_eq!(num(&v["total_shares"]), 0);
    assert_eq!([num(&v["held"][0][1]), num(&v["held"][1][1])], [0, 0], "the last holder takes the last unit");
    invariant(&worker, &fund_id, &toks, "after everyone left").await?;
    Ok(())
}

// 256-bit helpers for the checks (amounts go up to 1e27 and shares to 1e9+).
fn wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    (p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64), (p00 & M) | ((mid & M) << 64))
}
/// floor(a * b / d)
fn num256(a: u128, b: u128, d: u128) -> u128 {
    plinth::mul_div(a, b, d).unwrap()
}
/// ceil(a * b / d)
fn ceil256(a: u128, b: u128, d: u128) -> u128 {
    plinth::mul_div_ceil(a, b, d).unwrap()
}
/// a * b >= c * d
fn ge256(a: u128, b: u128, c: u128, d: u128) -> bool {
    wide(a, b) >= wide(c, d)
}
