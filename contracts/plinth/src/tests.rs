//! Unit tests: every mandate rule, refusals recorded, subscribe, trade bookkeeping, push
//! settlement (release 0.3), refunds, abandon, staking, in-kind joins and in-kind redemption. Quotes are signed with a test key using exactly the
//! 1Click scheme (quote::signed_message), so verification runs for real.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const USDC: &str = "usdc.test.near";
const WNEAR: &str = "wrap.test.near";
const OTHER: &str = "other.test.near";
const FUND: &str = "fund.test.near";
const OPERATOR: &str = "operator.test.near";
const T0: u64 = 1_800_000_000; // seconds
const CLOSE: u64 = T0 + 3600;

fn sk() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

fn pk_b58() -> String {
    format!("ed25519:{}", bs58::encode(sk().verifying_key().to_bytes()).into_string())
}

fn mandate() -> Mandate {
    Mandate {
        tokens: vec![USDC.parse().unwrap(), WNEAR.parse().unwrap()],
        max_trade_bps: 2_500,
        max_cost_bps: 100,
        min_seconds_between_trades: 660,
        max_trades_per_day: 3,
        max_quote_age_seconds: 120,
        min_deadline_margin_seconds: 600,
        subscription_closes_at: CLOSE,
        min_subscription: U128(1_000_000),
        max_total_subscriptions: U128(1_000_000_000),
        management_fee_bps: 0,
        staking: None,
        open_ended: false,
        strategy: None,
    }
}

fn config() -> Config {
    Config { mandate: mandate(), operator: OPERATOR.parse().unwrap(), quote_signer: pk_b58(), storage_deposit: U128(1_250_000_000_000_000_000_000) }
}

fn ctx(predecessor: &str, now: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(FUND.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .block_timestamp(now * 1_000_000_000)
        .account_balance(NearToken::from_near(5))
        .attached_deposit(NearToken::from_near(1));
    b
}

fn set(predecessor: &str, now: u64) {
    testing_env!(ctx(predecessor, now).build());
}

fn set_with_results(now: u64, results: Vec<PromiseResult>) {
    testing_env!(ctx(FUND, now).build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

/// Start a test fund on empty storage. The mocked chain keeps its storage for the whole test
/// thread, and a dropped fund flushes its maps into it: without this a second fund built in the
/// same test would read the first one's shares, baskets and used deposit addresses.
fn deploy(c: Config) -> Plinth {
    set("deployer.test.near", T0);
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    Plinth::new(c)
}

fn fund() -> Plinth {
    let mut f = deploy(config());
    for i in 0..2 {
        set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
        f.on_registered(i);
    }
    f
}

/// A live 1Click-shaped quote, signed with the test key.
struct Q {
    sell: &'static str,
    buy: &'static str,
    amount: u128,
    out: u128,
    min_out: u128,
    in_usd: &'static str,
    out_usd: &'static str,
    issued: u64,
    deadline: u64,
    deposit: String,
    recipient: String,
    refund_to: String,
    /// customRecipientMsg. None = the one the fund wants ("trade:<next id>"); Some("") = absent.
    msg: Option<String>,
    memo: bool,
    refund_fee: u128,
}

impl Default for Q {
    fn default() -> Self {
        Q {
            sell: USDC,
            buy: WNEAR,
            amount: 10_000_000,
            out: 2_700_000_000_000_000_000_000_000,
            min_out: 2_690_000_000_000_000_000_000_000,
            in_usd: "10.000000",
            out_usd: "9.990000",
            issued: CLOSE + 10,
            deadline: CLOSE + 10 + 3 * 86_400,
            deposit: "a".repeat(64),
            recipient: FUND.into(),
            refund_to: FUND.into(),
            msg: None,
            memo: false,
            refund_fee: 4_500,
        }
    }
}

fn iso(secs: u64) -> String {
    // Inverse of quote::parse_rfc3339_seconds for the range used here.
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

fn quote_json(q: &Q, next_id: u64) -> String {
    let mut req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": format!("nep141:{}", q.sell), "depositType": "ORIGIN_CHAIN",
        "destinationAsset": format!("nep141:{}", q.buy), "amount": q.amount.to_string(),
        "refundTo": q.refund_to, "refundType": "ORIGIN_CHAIN", "recipient": q.recipient,
        "recipientType": "DESTINATION_CHAIN", "deadline": iso(q.issued + 600), "quoteWaitingTimeMs": 0,
    });
    let msg = q.msg.clone().unwrap_or_else(|| format!("trade:{next_id}"));
    if !msg.is_empty() {
        req["customRecipientMsg"] = json!(msg);
    }
    let mut quote = json!({
        "amountIn": q.amount.to_string(), "amountInFormatted": "x", "amountInUsd": q.in_usd, "minAmountIn": q.amount.to_string(),
        "amountOut": q.out.to_string(), "amountOutFormatted": "y", "amountOutUsd": q.out_usd, "minAmountOut": q.min_out.to_string(),
        "timeEstimate": 22, "refundFee": q.refund_fee.to_string(), "deadline": iso(q.deadline), "timeWhenInactive": iso(q.deadline), "depositAddress": q.deposit,
    });
    if q.memo {
        quote["depositMemo"] = json!("123");
    }
    let ts = iso(q.issued);
    let msg = quote::signed_message(&req, &quote, &ts).unwrap();
    let sig = sk().sign(msg.as_bytes());
    serde_json::to_string(&json!({
        "quote": quote, "quoteRequest": req, "timestamp": ts,
        "signature": format!("ed25519:{}", bs58::encode(sig.to_bytes()).into_string()),
    }))
    .unwrap()
}

fn subscribe(f: &mut Plinth, who: &str, amount: u128, now: u64) -> U128 {
    set(USDC, now);
    f.ft_on_transfer(who.parse().unwrap(), U128(amount), String::new())
}

fn funded() -> Plinth {
    let mut f = fund();
    assert_eq!(subscribe(&mut f, "alice.test.near", 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, "bob.test.near", 40_000_000, T0 + 20).0, 0);
    f
}

fn propose(f: &mut Plinth, q: &Q, now: u64) -> bool {
    let next = f.get_fund().trades;
    set(OPERATOR, now);
    f.propose_trade(quote_json(q, next))
}

fn last_reason(f: &Plinth) -> String {
    let n = f.get_fund().rejections;
    f.get_rejections(n - 1, 1)[0].reason.clone()
}

fn ok_sent(f: &mut Plinth, id: u64, now: u64) {
    set_with_results(now, vec![PromiseResult::Successful(vec![])]);
    f.on_trade_sent(id);
}

fn payout(f: &mut Plinth, who: &str, i: u8, amount: u128, ok: bool, now: u64) {
    set_with_results(now, vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
    f.on_payout(who.parse().unwrap(), i, U128(amount));
}

fn bal(v: u128) -> Result<U128, PromiseError> {
    Ok(U128(v))
}

// ------------------------------------------------------------------ setup

#[test]
fn new_registers_on_every_token_and_reads_back_config() {
    let f = fund();
    let v = f.get_fund();
    assert_eq!(v.config, config());
    assert!(v.subscription_open && !v.trading_open);
    assert_eq!(v.held, vec![(USDC.parse().unwrap(), U128(0)), (WNEAR.parse().unwrap(), U128(0))]);
}

#[test]
#[should_panic(expected = "duplicate token")]
fn new_refuses_duplicate_tokens() {
    set("d.test.near", T0);
    let mut c = config();
    c.mandate.tokens.push(USDC.parse().unwrap());
    Plinth::new(c);
}

#[test]
#[should_panic(expected = "subscription must close in the future")]
fn new_refuses_a_closed_window() {
    set("d.test.near", CLOSE + 1);
    Plinth::new(config());
}

// ------------------------------------------------------------------ subscribe

#[test]
fn subscriptions_mint_one_share_per_base_unit_and_respect_limits() {
    let mut f = funded();
    assert_eq!(f.get_shares("alice.test.near".parse().unwrap()).0, 60_000_000);
    assert_eq!(f.get_fund().total_shares.0, 100_000_000);
    // Too small, too large, wrong token, after close: all returned in full.
    assert_eq!(subscribe(&mut f, "carol.test.near", 999_999, T0 + 30).0, 999_999);
    assert_eq!(subscribe(&mut f, "carol.test.near", 950_000_000, T0 + 30).0, 950_000_000);
    set(WNEAR, T0 + 30);
    assert_eq!(f.ft_on_transfer("carol.test.near".parse().unwrap(), U128(5), String::new()), U128(5));
    assert_eq!(subscribe(&mut f, "carol.test.near", 5_000_000, CLOSE).0, 5_000_000);
    assert_eq!(f.get_fund().total_shares.0, 100_000_000);
}

// ------------------------------------------------------------------ propose_trade: mandate

#[test]
fn a_quote_inside_the_mandate_is_sent_and_moves_the_input_out_of_holdings() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    let v = f.get_fund();
    let t = v.pending.unwrap();
    assert_eq!((t.status, t.amount_in.0, t.cost_bps), (TradeStatus::Sending, 10_000_000, 47));
    assert_eq!(v.held[0].1 .0, 90_000_000);
    assert!(get_logs().iter().any(|l| l.contains("\"trade_sent\"")));
}

#[test]
fn every_mandate_rule_refuses_and_records_its_reason() {
    let cases: Vec<(Q, u64, &str)> = vec![
        (Q { amount: 30_000_000, ..Default::default() }, CLOSE + 20, "over 2500 bps"),
        (Q { out_usd: "9.800000", ..Default::default() }, CLOSE + 20, "all-in cost"),
        (Q { issued: CLOSE + 10, ..Default::default() }, CLOSE + 10 + 121, "s old"),
        (Q { deadline: CLOSE + 20 + 100, ..Default::default() }, CLOSE + 20, "closes too soon"),
        (Q { recipient: "thief.test.near".into(), ..Default::default() }, CLOSE + 20, "deliver to and refund to this fund"),
        (Q { refund_to: "thief.test.near".into(), ..Default::default() }, CLOSE + 20, "deliver to and refund to this fund"),
        (Q { buy: OTHER, ..Default::default() }, CLOSE + 20, "not allowed by the mandate"),
        (Q { buy: USDC, ..Default::default() }, CLOSE + 20, "itself"),
        (Q { msg: Some("hello".into()), ..Default::default() }, CLOSE + 20, "quote must set customRecipientMsg to \"trade:0\""),
        (Q { msg: Some(String::new()), ..Default::default() }, CLOSE + 20, "quote must set customRecipientMsg to \"trade:0\""),
        (Q { msg: Some("trade:1".into()), ..Default::default() }, CLOSE + 20, "quote must set customRecipientMsg to \"trade:0\""),
        (Q { msg: Some("trade:00".into()), ..Default::default() }, CLOSE + 20, "quote must set customRecipientMsg to \"trade:0\""),
        (Q { min_out: 3_000_000_000_000_000_000_000_000, ..Default::default() }, CLOSE + 20, "not usable"),
    ];
    for (q, now, why) in cases {
        let mut f = funded();
        assert!(!propose(&mut f, &q, now), "{why}");
        assert!(last_reason(&f).contains(why), "expected '{why}', got '{}'", last_reason(&f));
        assert_eq!(f.get_fund().held[0].1 .0, 100_000_000, "nothing moves on a refusal");
        assert!(f.get_fund().pending.is_none());
    }
}

#[test]
fn trading_waits_for_the_subscription_window_to_close() {
    let mut f = funded();
    assert!(!propose(&mut f, &Q { issued: CLOSE - 30, ..Default::default() }, CLOSE - 10));
    assert!(last_reason(&f).contains("subscription window closes"));
}

#[test]
fn a_forged_or_edited_quote_is_refused() {
    let mut f = funded();
    let tampered = quote_json(&Q::default(), 0).replace(&"a".repeat(64), &"b".repeat(64));
    set(OPERATOR, CLOSE + 20);
    assert!(!f.propose_trade(tampered));
    assert!(last_reason(&f).contains("does not verify"));
}

#[test]
#[should_panic(expected = "only the operator")]
fn nobody_but_the_operator_can_propose() {
    let mut f = funded();
    set("alice.test.near", CLOSE + 20);
    f.propose_trade(quote_json(&Q::default(), 0));
}

#[test]
fn one_trade_at_a_time_cooldown_and_no_reused_deposit_address() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    assert!(!propose(&mut f, &Q { deposit: "c".repeat(64), ..Default::default() }, CLOSE + 25));
    assert!(last_reason(&f).contains("already in flight"));
    // Close it as failed (nothing left), then the cooldown still applies.
    set_with_results(CLOSE + 30, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    assert_eq!(f.get_fund().held[0].1 .0, 100_000_000, "a failed send restores the input");
    assert!(!propose(&mut f, &Q { deposit: "c".repeat(64), issued: CLOSE + 100, ..Default::default() }, CLOSE + 110));
    assert!(last_reason(&f).contains("too soon"));
    // After the cooldown, the same deposit address is still refused.
    let later = CLOSE + 20 + 660;
    assert!(!propose(&mut f, &Q { issued: later, deadline: later + 86_400, ..Default::default() }, later + 5));
    assert!(last_reason(&f).contains("already used"));
    assert!(propose(&mut f, &Q { deposit: "c".repeat(64), issued: later, deadline: later + 86_400, ..Default::default() }, later + 5));
}

#[test]
fn the_real_1click_signature_is_checked_against_the_configured_key() {
    // The fixture is a genuine 1Click quote; with the test key it must not verify.
    let mut f = funded();
    set(OPERATOR, CLOSE + 20);
    assert!(!f.propose_trade(include_str!("../tests/fixtures/quote_live.json").to_string()));
    assert!(last_reason(&f).contains("does not verify"));
}

// ------------------------------------------------------------------ shared helpers (0.3)

const ALICE: &str = "alice.test.near";
const BOB: &str = "bob.test.near";
const CAROL: &str = "carol.test.near";
const ANYONE: &str = "anyone.test.near";
const SOLVER: &str = "solver.test.near";
/// Default trade (Q::default): 10 USDC in, refund fee 4500.
const AMOUNT_IN: u128 = 10_000_000;
const REFUND: u128 = AMOUNT_IN - 4_500;
const MIN_OUT: u128 = 2_690_000_000_000_000_000_000_000;
/// When the default trade (sent at CLOSE + 20) may first be checked for a refund.
const REFUND_AT: u64 = CLOSE + 20 + REFUND_WAIT_SECONDS;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A token contract calling ft_on_transfer. Returns what the fund hands back.
fn push(f: &mut Plinth, token: &str, from: &str, amount: u128, msg: &str, now: u64) -> u128 {
    set(token, now);
    f.ft_on_transfer(acct(from), U128(amount), msg.to_string()).0
}

fn held(f: &Plinth, i: usize) -> u128 {
    f.get_fund().held[i].1 .0
}

fn trade(f: &Plinth, id: u64) -> Trade {
    f.get_trades(id, 1)[0].clone()
}

/// Run something that must panic; returns the panic message.
fn panics<R>(f: impl FnOnce() -> R) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected a panic"),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    }
}

/// `settle_refund` as anyone; returns the flux the callback will be given.
fn request_refund(f: &mut Plinth, id: u64, now: u64) -> u64 {
    set(ANYONE, now);
    f.settle_refund(id);
    f.flux
}

fn refund_cb(f: &mut Plinth, id: u64, flux: u64, balance: u128, now: u64) -> TradeStatus {
    set_with_results(now, vec![]);
    f.on_settle_refund(id, flux, bal(balance))
}

/// The callback with the fund's current flux (a read that nothing has invalidated).
fn refund_now(f: &mut Plinth, id: u64, balance: u128, now: u64) -> TradeStatus {
    let flux = f.flux;
    refund_cb(f, id, flux, balance, now)
}

fn set_deposit(predecessor: &str, now: u64, yocto: u128) {
    let mut c = ctx(predecessor, now);
    c.attached_deposit(NearToken::from_yoctonear(yocto));
    testing_env!(c.build());
}

fn sent_fund() -> Plinth {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    f
}

/// The default trade written off (deposit address expired a week ago), nothing counted.
fn abandoned_fund() -> (Plinth, u64) {
    let mut f = sent_fund();
    let at = Q::default().deadline + ABANDON_AFTER_SECONDS + 1;
    set(ANYONE, at);
    f.abandon();
    (f, at)
}

// ------------------------------------------------------------------ settle / refund / abandon

#[test]
fn settle_credits_the_output_when_at_least_min_out_arrived() {
    // 0.3: the output settles the trade when it is pushed with `trade:<id>`; no balance is read.
    let mut f = sent_fund();
    assert!(f.get_fund().pending.is_some());
    let out = 2_695_000_000_000_000_000_000_000;
    assert_eq!(push(&mut f, WNEAR, SOLVER, out, "trade:0", CLOSE + 60), 0);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (90_000_000, out));
    assert_eq!((trade(&f, 0).status, trade(&f, 0).received_out.0, trade(&f, 0).closed_at), (TradeStatus::Settled, out, Some(CLOSE + 60)));
    // A second push for the same trade is a donation: holdings grow, the trade does not change.
    assert_eq!(push(&mut f, WNEAR, SOLVER, 5, "trade:0", CLOSE + 61), 0);
    assert_eq!(held(&f, 1), out + 5);
    assert_eq!(trade(&f, 0).received_out.0, out);
}

#[test]
fn a_1click_refund_closes_the_trade_as_refunded() {
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 100_000_000 - 4_500);
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn abandon_only_long_after_the_deposit_address_expired() {
    let mut f = sent_fund();
    let deadline = Q::default().deadline;
    set(ANYONE, deadline + ABANDON_AFTER_SECONDS);
    assert!(panics(|| f.abandon()).contains("too early"));
    set(ANYONE, deadline + ABANDON_AFTER_SECONDS + 1);
    f.abandon();
    assert!(f.get_fund().pending.is_none());
    assert_eq!(f.get_trades(0, 1)[0].status, TradeStatus::Abandoned);
    assert!(panics(|| f.abandon()).contains("no trade in flight"));
}

#[test]
fn abandon_refuses_a_trade_that_is_still_being_sent() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    set(ANYONE, Q::default().deadline + ABANDON_AFTER_SECONDS + 1);
    assert!(panics(|| f.abandon()).contains("still being sent"));
}

// (0.2's `absorb_counts_donations_only_with_no_trade_in_flight` is gone with `absorb`; donations
// are now pushes, see v3_donate_push_is_kept_and_counted.)

// ------------------------------------------------------------------ redeem

#[test]
fn redeem_pays_the_pro_rata_amount_of_every_token_in_kind() {
    let mut f = sent_fund();
    let out = 2_695_000_000_000_000_000_000_000u128;
    assert_eq!(push(&mut f, WNEAR, SOLVER, out, "trade:0", CLOSE + 60), 0);
    // Bob holds 40%.
    set(BOB, CLOSE + 70);
    f.redeem(U128(40_000_000));
    let v = f.get_fund();
    assert_eq!(v.held[0].1 .0, 90_000_000 - 36_000_000);
    assert_eq!(v.held[1].1 .0, out - out * 40 / 100);
    assert_eq!(v.total_shares.0, 60_000_000);
    assert_eq!(f.get_shares(acct(BOB)).0, 0);
    // In flight, the payouts are tracked per token and are not claimable.
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(36_000_000), U128(out * 40 / 100)]);
    assert!(f.get_owed(acct(BOB)).is_empty());
    payout(&mut f, BOB, 0, 36_000_000, true, CLOSE + 71);
    payout(&mut f, BOB, 1, out * 40 / 100, true, CLOSE + 71);
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(0), U128(0)]);
    assert!(f.get_owed(acct(BOB)).is_empty());
}

#[test]
fn a_failed_payout_stays_owed_and_is_not_mistaken_for_trade_output() {
    // 0.3: the only balance read is the refund check; a failed payout still sits in the fund's
    // token balance and must not be mistaken for a refund.
    let mut f = sent_fund();
    set(BOB, CLOSE + 20 + REDEEM_WAIT_SECONDS);
    f.redeem(U128(40_000_000));
    payout(&mut f, BOB, 0, 36_000_000, false, CLOSE + 20 + REDEEM_WAIT_SECONDS + 1);
    assert_eq!(f.get_owed(acct(BOB)), vec![U128(36_000_000), U128(0)]);
    assert_eq!(f.get_fund().owed_total, vec![U128(36_000_000), U128(0)]);
    // The balance is still 90 USDC (54 held + 36 owed): 36 "extra" over holdings, but not a refund.
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000, REFUND_AT + 1), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 54_000_000);
    // Claim retries it; success clears it.
    set(BOB, REFUND_AT + 2);
    f.claim(None);
    assert_eq!(f.get_fund().owed_total[0].0, 0);
    payout(&mut f, BOB, 0, 36_000_000, true, REFUND_AT + 3);
    assert!(f.get_owed(acct(BOB)).is_empty());
    assert_eq!(held(&f, 0), 54_000_000);
}

#[test]
fn redeem_waits_at_most_ten_minutes_for_a_trade_in_flight() {
    let mut f = sent_fund();
    set(ALICE, CLOSE + 21 + 60);
    assert!(panics(|| f.redeem(U128(1_000_000))).contains("a trade is in flight"));
    set(ALICE, CLOSE + 20 + REDEEM_WAIT_SECONDS);
    f.redeem(U128(60_000_000));
    // Alice leaves with 60% of what is held (the 10 USDC in flight stays with the fund).
    assert_eq!(f.get_fund().held[0].1 .0, 90_000_000 - 54_000_000);
}

#[test]
#[should_panic(expected = "not enough shares")]
fn cannot_redeem_more_than_you_hold() {
    let mut f = funded();
    set(BOB, T0 + 100);
    f.redeem(U128(40_000_001));
}

#[test]
#[should_panic(expected = "not enough shares")]
fn cannot_redeem_zero_shares() {
    let mut f = funded();
    set(BOB, T0 + 100);
    f.redeem(U128(0));
}

#[test]
fn cost_of_the_real_fixture_matches_the_operator_tool() {
    // tools/test/oneclick.test.ts asserts the same 109 bps for this quote.
    set("x.test.near", T0);
    let key = quote::decode_public_key(quote::ONE_CLICK_MANAGER_PUB_KEY).unwrap();
    let q = quote::verify_quote(include_str!("../tests/fixtures/quote_live.json"), &key).unwrap();
    assert_eq!(cost_bps(&q), Some(109));
}

#[test]
fn cost_formula_uses_the_worst_case_output() {
    let q = quote::VerifiedQuote {
        deposit_address: "x.near".parse().unwrap(),
        origin_asset: String::new(),
        destination_asset: String::new(),
        amount_in: 1,
        amount_out: 1_000,
        min_amount_out: 990,
        amount_in_usd_micros: 10_000_000,
        amount_out_usd_micros: 9_950_000,
        refund_fee: 0,
        recipient: String::new(),
        refund_to: String::new(),
        refund_type: String::new(),
        deadline_seconds: 0,
        issued_seconds: 0,
        custom_recipient_msg: None,
        unsupported_field: None,
    };
    // worst out = 9.95 * 0.99 = 9.8505 → cost = 1.495% = 149 bps
    assert_eq!(cost_bps(&q), Some(149));
    let _ = Value::Null;
    let _ = accounts(0);
}

// ------------------------------------------------------------------ audit findings (2026-11-10)

#[test]
fn audit_c1_an_in_flight_payout_cannot_be_claimed_again() {
    let mut f = funded();
    set(BOB, T0 + 100);
    f.redeem(U128(40_000_000));
    // Same receipt: claim finds nothing while the payout is in flight.
    assert!(panics(|| f.claim(None)).contains("nothing owed"));
    payout(&mut f, BOB, 0, 40_000_000, false, T0 + 101);
    set(BOB, T0 + 102);
    f.claim(None);
    // Already re-sent: a second claim before it resolves finds nothing.
    assert!(panics(|| f.claim(None)).contains("nothing owed"));
    assert_eq!(f.get_fund().in_flight_payouts[0].0, 40_000_000);
    payout(&mut f, BOB, 0, 40_000_000, true, T0 + 103);
    assert_eq!(f.get_fund().in_flight_payouts[0].0, 0);
    assert!(f.get_owed(acct(BOB)).is_empty());
    assert_eq!(f.get_fund().held[0].1 .0, 60_000_000);
}

#[test]
#[should_panic(expected = "1 to 4 tokens")]
fn audit_h1_at_most_four_tokens_so_redemption_fits_in_one_transaction() {
    set("d.test.near", T0);
    let mut c = config();
    c.mandate.tokens = (0..5).map(|i| format!("t{i}.test.near").parse().unwrap()).collect();
    Plinth::new(c);
}

#[test]
fn audit_h2_mul_div_is_exact_beyond_u128_products() {
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
    assert_eq!(mul_div(3 * 10u128.pow(28), 10u128.pow(11), 10u128.pow(11)), Some(3 * 10u128.pow(28)));
    assert_eq!(mul_div(3 * 10u128.pow(28), 4 * 10u128.pow(10), 10u128.pow(11)), Some(12 * 10u128.pow(27)));
    assert_eq!(mul_div(7, 3, 2), Some(10));
    assert_eq!(mul_div(u128::MAX, 2, 1), None);
    assert_eq!(mul_div(1, 1, 0), None);
    // 30k wNEAR held by a 100k-share fund: a full redeem no longer overflows.
    let mut f = funded();
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", 3 * 10u128.pow(28), "donate", T0 + 100), 0);
    set(ALICE, T0 + 101);
    f.redeem(U128(60_000_000));
    assert_eq!(f.get_fund().in_flight_payouts[1].0, 18 * 10u128.pow(27));
}

#[test]
#[should_panic(expected = "at least 660")]
fn audit_m1_cooldown_must_outlast_the_redemption_wait() {
    set("d.test.near", T0);
    let mut c = config();
    c.mandate.min_seconds_between_trades = 600;
    Plinth::new(c);
}

#[test]
fn audit_m2_a_settle_read_made_before_a_payout_resolved_is_ignored() {
    // 0.3: the read is the refund check and the guard is `flux`.
    let mut f = sent_fund();
    set(BOB, REFUND_AT);
    f.redeem(U128(10_000_000));
    // Balance read requested while Bob's 9 USDC payout is in flight...
    let stale = request_refund(&mut f, 0, REFUND_AT);
    // ...the payout resolves before the callback: the read (taken at an unknown point) is ignored.
    payout(&mut f, BOB, 0, 9_000_000, true, REFUND_AT + 1);
    assert_eq!(refund_cb(&mut f, 0, stale, 90_000_000 + REFUND, REFUND_AT + 2), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 81_000_000);
    assert!(get_logs().iter().any(|l| l.contains("tokens moved while the balance was read")));
    // A fresh read with nothing moving counts the refund.
    let flux = request_refund(&mut f, 0, REFUND_AT + 3);
    assert_eq!(refund_cb(&mut f, 0, flux, 81_000_000 + REFUND, REFUND_AT + 4), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 81_000_000 + REFUND);
}

#[test]
fn audit_m3_leaving_during_the_window_frees_the_subscription_cap() {
    let mut f = fund();
    for _ in 0..30 {
        assert_eq!(subscribe(&mut f, "mallory.test.near", 900_000_000, T0 + 10).0, 0);
        set("mallory.test.near", T0 + 11);
        f.redeem(U128(900_000_000));
    }
    assert_eq!(f.get_fund().total_subscribed.0, 0);
    assert_eq!(subscribe(&mut f, ALICE, 1_000_000_000, T0 + 20).0, 0);
}

#[test]
fn audit_l2_a_deposit_memo_is_refused() {
    let mut f = funded();
    assert!(!propose(&mut f, &Q { memo: true, ..Default::default() }, CLOSE + 20));
    assert!(last_reason(&f).contains("depositMemo"));
}

#[test]
fn audit_l3_a_token_the_fund_is_not_registered_on_cannot_be_traded() {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(config());
    set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
    f.on_registered(0);
    set_with_results(T0, vec![PromiseResult::Failed]);
    f.on_registered(1);
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    assert!(!propose(&mut f, &Q::default(), CLOSE + 20));
    assert!(last_reason(&f).contains("not registered"));
}

#[test]
fn audit_h3_trades_per_day_are_capped() {
    let mut f = funded();
    let mut t = CLOSE + 20;
    let mut sent = 0;
    for k in 0..4u64 {
        let q = Q { deposit: format!("{:064x}", k + 1), issued: t - 5, deadline: t + 86_400, ..Default::default() };
        if propose(&mut f, &q, t) {
            sent += 1;
            let id = f.get_fund().trades - 1;
            ok_sent(&mut f, id, t + 1);
            assert_eq!(push(&mut f, WNEAR, SOLVER, 2_695_000_000_000_000_000_000_000, &format!("trade:{id}"), t + 2), 0);
            assert!(f.get_fund().pending.is_none());
        }
        t += 700;
    }
    // CLOSE + 20 .. + 2100 s is within one UTC day only if it does not cross midnight; the mandate says 3.
    assert!(sent <= 3, "sent {sent}");
    if (CLOSE + 20) / 86_400 == (CLOSE + 20 + 2100) / 86_400 {
        assert_eq!(sent, 3);
        assert!(last_reason(&f).contains("used up"));
    }
}

// ------------------------------------------------------------------ earning: staking + fee

const LST: &str = "stnear.test.near";
const PRICE: u128 = 1_514_505_000_000_000_000_000_000; // 1.514505 NEAR per stNEAR
const FIVE: u128 = 5_000_000_000_000_000_000_000_000;

fn staking_config(fee_bps: u16) -> Config {
    let mut c = config();
    c.mandate.tokens = vec![USDC.parse().unwrap(), WNEAR.parse().unwrap(), LST.parse().unwrap()];
    c.mandate.management_fee_bps = fee_bps;
    c.mandate.staking = Some(StakingRoute { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price".into(), min_stake: U128(10u128.pow(24)), max_price_slippage_bps: 50 });
    c
}

fn staking_fund(fee_bps: u16) -> Plinth {
    let mut f = deploy(staking_config(fee_bps));
    for i in 0..3 {
        set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
        f.on_registered(i);
    }
    assert_eq!(subscribe(&mut f, ALICE, 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, BOB, 40_000_000, T0 + 20).0, 0);
    // The fund holds 20 wNEAR (a settled trade or a donation).
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", 20 * 10u128.pow(24), "donate", T0 + 30), 0);
    f
}

fn stake(f: &mut Plinth, amount: u128, now: u64) -> bool {
    set(OPERATOR, now);
    f.stake_idle(U128(amount))
}

/// near_withdraw succeeded and the price was read.
fn unwrapped(f: &mut Plinth, id: u64, now: u64) {
    set_with_results(now, vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(id);
}

/// deposit_and_stake resolved: `Some(bytes)` is what it returned, None = it failed.
fn staked(f: &mut Plinth, id: u64, returned: Option<&[u8]>, now: u64) {
    set_with_results(now, vec![returned.map_or(PromiseResult::Failed, |b| PromiseResult::Successful(b.to_vec()))]);
    f.on_staked(id);
}

fn expected_mint() -> u128 {
    mul_div(FIVE, 10u128.pow(24), PRICE).unwrap()
}

#[test]
fn stake_idle_unwraps_stakes_at_par_and_settles_against_the_price() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    assert_eq!(f.get_fund().held[1].1 .0, 15 * 10u128.pow(24));
    // Unwrap succeeded, price read: the contract computes the minimum it expects.
    unwrapped(&mut f, 0, CLOSE + 21);
    let t = f.get_fund().pending.unwrap();
    let expected = expected_mint();
    assert_eq!(t.quoted_out.0, expected);
    assert_eq!(t.min_out.0, expected * 9_950 / 10_000);
    assert_eq!(t.status, TradeStatus::Sending);
    // 0.3: the stake settles in on_staked, from the amount deposit_and_stake returned.
    staked(&mut f, 0, Some(format!("\"{expected}\"").as_bytes()), CLOSE + 22);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!(v.held[2].1 .0, expected);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Settled, expected, Some(CLOSE + 22)));
    // Redemption pays stNEAR in kind like any other token.
    set(BOB, CLOSE + 40);
    f.redeem(U128(40_000_000));
    assert_eq!(f.get_fund().in_flight_payouts[2].0, expected * 40 / 100);
}

#[test]
fn a_mint_below_the_price_minimum_is_credited_as_minted_and_logged() {
    // 0.3 changed this: there is no later settle to wait for, so a stake that minted less than
    // the price allows for is closed with exactly what was minted, and the shortfall is logged.
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    let min = f.get_fund().pending.unwrap().min_out.0;
    staked(&mut f, 0, Some(format!("\"{}\"", min - 1).as_bytes()), CLOSE + 22);
    assert!(get_logs().iter().any(|l| l.contains("below the")));
    assert_eq!(held(&f, 2), min - 1);
    assert_eq!(trade(&f, 0).status, TradeStatus::Settled);
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn a_failed_unwrap_restores_the_wnear() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed, PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(0);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!(v.held[1].1 .0, 20 * 10u128.pow(24));
    assert_eq!(f.get_trades(0, 1)[0].status, TradeStatus::Failed);
    assert_eq!(f.near_in_flight, 0);
}

#[test]
fn a_failed_stake_is_wrapped_back_or_left_recoverable() {
    // deposit_and_stake fails, re-wrap succeeds: holdings restored.
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    staked(&mut f, 0, None, CLOSE + 22);
    assert_eq!(trade(&f, 0).status, TradeStatus::Sending, "still open until the re-wrap resolves");
    assert_eq!(held(&f, 2), 0);
    set_with_results(CLOSE + 23, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(0, U128(FIVE));
    assert_eq!(f.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
    assert!(f.get_fund().pending.is_none());
    assert_eq!(trade(&f, 0).status, TradeStatus::Failed);
    // Same, but the re-wrap fails too: the NEAR is stranded, then recovered by anyone.
    let mut g = staking_fund(0);
    assert!(stake(&mut g, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    g.on_unwrapped(0); // no price: straight to re-wrap
    set_with_results(CLOSE + 23, vec![PromiseResult::Failed]);
    g.on_rewrapped(0, U128(FIVE));
    assert_eq!(g.get_fund().stranded_near.0, FIVE);
    assert!(g.get_fund().pending.is_none());
    let mut ctx = ctx(ANYONE, CLOSE + 30);
    ctx.account_balance(NearToken::from_near(20));
    testing_env!(ctx.build());
    g.rewrap_stranded();
    assert_eq!(g.get_fund().stranded_near.0, 0);
    set_with_results(CLOSE + 31, vec![PromiseResult::Successful(vec![])]);
    g.on_rewrapped(u64::MAX, U128(FIVE));
    assert_eq!(g.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
}

#[test]
fn stake_idle_obeys_size_minimum_cooldown_and_operator() {
    let mut f = staking_fund(0);
    assert!(!stake(&mut f, 6 * 10u128.pow(24), CLOSE + 20)); // 30% of 20
    assert!(last_reason(&f).contains("over 2500 bps"));
    assert!(!stake(&mut f, 10u128.pow(23), CLOSE + 20)); // 0.1 NEAR
    assert!(last_reason(&f).contains("below the minimum"));
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    assert!(!stake(&mut f, 10u128.pow(24), CLOSE + 25));
    // Refused and logged; not stored, because the stake's NEAR in transit is reserved (audit 2, H).
    assert!(get_logs().iter().any(|l| l.contains("already in flight")));
    set(ALICE, CLOSE + 30);
    assert!(panics(|| f.stake_idle(U128(10u128.pow(24)))).contains("only the operator"));
}

#[test]
#[should_panic(expected = "no staking route")]
fn a_fund_without_a_staking_route_cannot_stake() {
    let mut f = funded();
    set(OPERATOR, CLOSE + 20);
    f.stake_idle(U128(10u128.pow(24)));
}

#[test]
fn management_fee_accrues_only_after_the_window_and_is_capped() {
    let mut f = staking_fund(100); // 1% a year
    // During the window nothing accrues.
    set(ANYONE, CLOSE - 1);
    f.accrue();
    assert_eq!(f.get_fund().operator_shares.0, 0);
    // One year after the window closes the operator holds 1% of all shares.
    set(ANYONE, CLOSE + YEAR_SECONDS as u64);
    f.accrue();
    let v = f.get_fund();
    let op = v.operator_shares.0;
    // 1% of the fund, to within one part in a million (integer rounding).
    let ppm = op * 1_000_000 / v.total_shares.0;
    assert!((9_999..=10_000).contains(&ppm), "operator holds {op} of {} = {ppm} ppm", v.total_shares.0);
    // A second call in the same second mints nothing more.
    f.accrue();
    assert_eq!(f.get_fund().operator_shares.0, op);
    // Bob redeems after a year: he gets 40% of the 99% left to depositors.
    set(BOB, CLOSE + YEAR_SECONDS as u64 + 1);
    f.redeem(U128(40_000_000));
    let paid = f.get_fund().in_flight_payouts[0].0;
    assert!(paid < 40_000_000 && paid >= 39_590_000, "paid {paid}");
}

#[test]
#[should_panic(expected = "at most 200")]
fn management_fee_is_capped_at_two_percent() {
    set("d.test.near", T0);
    let mut c = config();
    c.mandate.management_fee_bps = 201;
    Plinth::new(c);
}

#[test]
fn frequent_accruals_do_not_round_the_fee_away() {
    let mut f = staking_fund(200);
    // Accrue every 5 seconds for an hour: the total must match one accrual over the hour.
    let mut t = CLOSE;
    while t < CLOSE + 3600 {
        t += 5;
        set(ANYONE, t);
        f.accrue();
    }
    let frequent = f.get_fund().operator_shares.0;
    let mut g = staking_fund(200);
    set(ANYONE, CLOSE + 3600);
    g.accrue();
    let once = g.get_fund().operator_shares.0;
    assert!(once > 0);
    // Never more than one accrual would give, and within 2% of it (each mint rounds in the
    // depositors' favour; 1 share here is 0.000001 pUSD).
    assert!(frequent <= once + 1 && frequent * 100 >= once * 98, "frequent {frequent} vs once {once}");
}

// ---------------------------------------------------------------- audit 2 regressions

fn with_balance(predecessor: &str, now: u64, near_milli: u128) {
    let mut c = ctx(predecessor, now);
    c.account_balance(NearToken::from_yoctonear(near_milli * 10u128.pow(21)));
    testing_env!(c.build());
}

#[test]
fn audit2_h_refusals_cannot_spend_a_stakes_near_in_transit() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 7_000); // 7 NEAR: ~2 NEAR really free
    assert!(f.stake_idle(U128(FIVE)));
    let stored = f.get_fund().rejections;
    // The unwrapped 5 NEAR has arrived (balance 12 NEAR) but on_unwrapped has not run yet: the
    // operator spams refused proposals. They are stored only from the ~2 NEAR that is really free,
    // never from the 5 NEAR in transit.
    for _ in 0..5 {
        with_balance(OPERATOR, CLOSE + 21, 12_000);
        assert!(!f.stake_idle(U128(10u128.pow(24))));
    }
    assert_eq!(f.get_fund().rejections, stored + 5);
    with_balance(OPERATOR, CLOSE + 21, 5_050); // what's left above the 5 NEAR in transit: ~0.05
    assert!(!f.stake_idle(U128(10u128.pow(24))));
    assert_eq!(f.get_fund().rejections, stored + 5, "not stored: only reserved NEAR is left");
    let v = f.get_fund();
    assert!(v.near_available_for_registrations.0 < 10u128.pow(23));
}

#[test]
fn audit2_m_stake_needs_the_reserve() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 30); // 0.03 NEAR above nothing: below the 0.05 reserve
    assert!(!f.stake_idle(U128(10u128.pow(24))));
    assert!(get_logs().iter().any(|l| l.contains("no NEAR left for the stake")));
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn audit2_m_operator_fee_entry_exists_from_launch() {
    let f = staking_fund(100);
    set(ANYONE, T0 + 40);
    assert_eq!(f.get_shares(OPERATOR.parse().unwrap()).0, 0);
    assert!(f.shares.get(&OPERATOR.parse::<AccountId>().unwrap()).is_some());
}

#[test]
#[should_panic(expected = "max_price_slippage_bps must be 1..=500")]
fn audit2_l_zero_slippage_is_refused_at_launch() {
    set("deployer.test.near", T0);
    let mut c = staking_config(0);
    c.mandate.staking.as_mut().unwrap().max_price_slippage_bps = 0;
    Plinth::new(c);
}

#[test]
fn audit2_l_per_second_accruals_lose_almost_nothing() {
    let mk = || {
        set("deployer.test.near", T0);
        let mut c = staking_config(200);
        c.mandate.max_total_subscriptions = U128(10u128.pow(12));
        let mut f = Plinth::new(c);
        subscribe(&mut f, ALICE, 3_000_000_000, T0 + 10);
        f
    };
    let mut a = mk();
    for t in 1..=3600u64 {
        set(ANYONE, CLOSE + t);
        a.accrue();
    }
    let mut b = mk();
    set(ANYONE, CLOSE + 3600);
    b.accrue();
    let (x, y) = (a.get_fund().operator_shares.0, b.get_fund().operator_shares.0);
    // Before the fix x was 48% of y. Now each call loses at most one share's rounding plus 1 ns.
    assert!(x <= y && x * 1000 >= y * 999, "every second: {x}; once: {y}");
}

#[test]
fn audit2_h_a_stuck_stake_can_be_recovered_after_a_day() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 7_000);
    assert!(f.stake_idle(U128(FIVE)));
    // on_unwrapped never completes (e.g. it ran out of balance or gas): the stake is stuck Sending.
    with_balance(ANYONE, CLOSE + 1000, 12_000);
    assert!(panics(|| f.recover_stuck_stake()).contains("too early"));
    with_balance(ANYONE, CLOSE + 20 + 86_401, 12_000);
    f.recover_stuck_stake();
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!(v.stranded_near.0, FIVE);
    // ...and anyone wraps it back into fund holdings.
    with_balance(ANYONE, CLOSE + 20 + 86_402, 12_000);
    f.rewrap_stranded();
    set_with_results(CLOSE + 20 + 86_403, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(FIVE));
    assert_eq!(f.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
}

#[test]
fn audit2_m_new_depositors_cannot_eat_the_reserve() {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(staking_config(0));
    with_balance(USDC, T0 + 10, 40); // 0.04 NEAR: below the reserve
    assert_eq!(f.ft_on_transfer(acct(CAROL), U128(5_000_000), String::new()).0, 5_000_000);
    assert_eq!(f.get_fund().total_shares.0, 0);
    with_balance(USDC, T0 + 11, 5_000);
    assert_eq!(f.ft_on_transfer(acct(CAROL), U128(5_000_000), String::new()).0, 0);
}

// ================================================================== release 0.3

// ------------------------------------------------------------------ v3: quote message

#[test]
fn v3_quote_must_carry_the_next_trade_id_and_refusals_do_not_consume_ids() {
    let mut f = funded();
    // A refusal does not use up id 0.
    assert!(!propose(&mut f, &Q { amount: 30_000_000, ..Default::default() }, CLOSE + 20));
    assert_eq!(f.get_fund().trades, 0);
    assert!(propose(&mut f, &Q { msg: Some("trade:0".into()), ..Default::default() }, CLOSE + 20));
    // The send fails: trade 0 is recorded as Failed, so the next quote must say trade:1.
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    let later = CLOSE + 20 + 660;
    let q = |msg: &str, dep: &str| Q { msg: Some(msg.into()), deposit: dep.repeat(64), issued: later, deadline: later + 86_400, ..Default::default() };
    assert!(!propose(&mut f, &q("trade:0", "c"), later + 5));
    assert_eq!(last_reason(&f), "quote must set customRecipientMsg to \"trade:1\"");
    assert_eq!(f.get_rejections(f.get_fund().rejections - 1, 1)[0].deposit_address, Some("c".repeat(64)));
    assert_eq!(held(&f, 0), 100_000_000);
    assert!(propose(&mut f, &q("trade:1", "c"), later + 5));
    assert_eq!(f.get_fund().pending.unwrap().id, 1);
}

#[test]
fn v3_the_message_is_covered_by_the_signature() {
    // Signed with "trade:7", edited to "trade:0" afterwards: the signature no longer verifies.
    let mut f = funded();
    let raw = quote_json(&Q { msg: Some("trade:7".into()), ..Default::default() }, 0).replace("trade:7", "trade:0");
    set(OPERATOR, CLOSE + 20);
    assert!(!f.propose_trade(raw));
    assert!(last_reason(&f).contains("does not verify"));
}

// ------------------------------------------------------------------ v3: push settles

#[test]
fn v3_push_of_exactly_min_out_settles() {
    let mut f = sent_fund();
    let flux = f.flux;
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 60), 0);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (90_000_000, MIN_OUT));
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.received_refund.0, t.closed_at), (TradeStatus::Settled, MIN_OUT, 0, Some(CLOSE + 60)));
    assert_eq!(f.flux, flux + 2, "once for the transfer arriving, once for keeping it");
    assert!(get_logs().iter().any(|l| l.contains("\"output_received\"")));
    assert!(get_logs().iter().any(|l| l.contains("\"trade_closed\"")));
}

#[test]
fn v3_pushes_below_min_out_accumulate_and_settle_on_the_second() {
    let mut f = sent_fund();
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT - 1, "trade:0", CLOSE + 60), 0);
    // Kept and counted in holdings, but one unit short: the trade stays open.
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Sent, MIN_OUT - 1, None));
    assert_eq!(held(&f, 1), MIN_OUT - 1);
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    assert_eq!(push(&mut f, WNEAR, "other-solver.test.near", 1, "trade:0", CLOSE + 61), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0), (TradeStatus::Settled, MIN_OUT));
    assert_eq!(held(&f, 1), MIN_OUT);
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn v3_pushes_that_match_no_open_swap_are_kept_as_donations() {
    let mut f = sent_fund();
    let before = trade(&f, 0);
    // Wrong token (the trade buys wNEAR, this is USDC).
    assert_eq!(push(&mut f, USDC, SOLVER, MIN_OUT, "trade:0", CLOSE + 60), 0);
    assert_eq!(held(&f, 0), 90_000_000 + MIN_OUT);
    // Unknown ids, and ids that are not numbers.
    for (k, msg) in ["trade:1", "trade:7", "trade:18446744073709551615", "trade:18446744073709551616", "trade:4294967296", "trade:", "trade:-0", "trade:0x0", "trade: 0", "trade:0 "].iter().enumerate() {
        assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, msg, CLOSE + 61), 0, "{msg}");
        assert_eq!(held(&f, 1), MIN_OUT * (k as u128 + 1), "{msg}");
        assert_eq!(trade(&f, 0), before, "{msg} must not touch trade 0");
        assert!(get_logs().iter().any(|l| l.contains("\"donated\"")), "{msg}");
    }
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    assert_eq!(f.get_fund().trades, 1);
    // Settle it, then push for it again: a donation.
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 62), 0);
    let settled = trade(&f, 0);
    assert_eq!(settled.status, TradeStatus::Settled);
    let h = held(&f, 1);
    assert_eq!(push(&mut f, WNEAR, SOLVER, 77, "trade:0", CLOSE + 63), 0);
    assert_eq!(held(&f, 1), h + 77);
    assert_eq!(trade(&f, 0), settled);
}

#[test]
fn v3_a_push_for_a_failed_trade_is_a_donation() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    let failed = trade(&f, 0);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 22), 0);
    assert_eq!(trade(&f, 0), failed);
    assert_eq!((held(&f, 0), held(&f, 1)), (100_000_000, MIN_OUT));
}

#[test]
fn v3_a_push_naming_a_stake_is_a_donation() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    let open = trade(&f, 0);
    // While the stake is in flight...
    assert_eq!(push(&mut f, LST, SOLVER, open.quoted_out.0, "trade:0", CLOSE + 22), 0);
    assert_eq!(trade(&f, 0), open);
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    assert_eq!(held(&f, 2), open.quoted_out.0);
    // ...and after it settled.
    staked(&mut f, 0, Some(format!("\"{}\"", open.quoted_out.0).as_bytes()), CLOSE + 23);
    let closed = trade(&f, 0);
    assert_eq!(push(&mut f, LST, SOLVER, 5, "trade:0", CLOSE + 24), 0);
    assert_eq!(trade(&f, 0), closed);
    assert_eq!(held(&f, 2), 2 * open.quoted_out.0 + 5);
}

#[test]
fn v3_donate_push_is_kept_and_counted() {
    let mut f = funded();
    let flux = f.flux;
    assert_eq!(push(&mut f, USDC, "donor.test.near", 123, "donate", T0 + 100), 0);
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", 456, "donate", T0 + 100), 0);
    assert_eq!((held(&f, 0), held(&f, 1)), (100_000_123, 456));
    assert_eq!(f.flux, flux + 4);
    // No shares are minted for a donation.
    assert_eq!(f.get_fund().total_shares.0, 100_000_000);
    assert_eq!(f.get_shares(acct("donor.test.near")).0, 0);
    // Donations during a trade in flight are fine too (0.2's absorb refused them).
    let mut g = sent_fund();
    assert_eq!(push(&mut g, USDC, "donor.test.near", 5, "donate", CLOSE + 30), 0);
    assert_eq!(held(&g, 0), 90_000_005);
    assert_eq!(trade(&g, 0).status, TradeStatus::Sent);
}

#[test]
fn v3_pushes_from_other_tokens_and_empty_or_overflowing_pushes_are_returned() {
    let mut f = sent_fund();
    for msg in ["trade:0", "donate", "basket", ""] {
        // A token the mandate does not list.
        assert_eq!(push(&mut f, OTHER, SOLVER, 1_000, msg, CLOSE + 60), 1_000, "{msg}");
        // Zero.
        assert_eq!(push(&mut f, WNEAR, SOLVER, 0, msg, CLOSE + 60), 0, "{msg}");
    }
    // Would overflow the holding.
    assert_eq!(push(&mut f, USDC, SOLVER, u128::MAX, "donate", CLOSE + 60), u128::MAX);
    assert_eq!(push(&mut f, USDC, SOLVER, u128::MAX - 90_000_000 + 1, "trade:0", CLOSE + 60), u128::MAX - 90_000_000 + 1);
    // A non-base token with no instruction, and the base token after the window.
    assert_eq!(push(&mut f, WNEAR, SOLVER, 9, "hello", CLOSE + 60), 9);
    assert_eq!(push(&mut f, USDC, SOLVER, 5_000_000, "trade", CLOSE + 60), 5_000_000);
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, 0));
    assert_eq!(trade(&f, 0).status, TradeStatus::Sent);
    // A returned transfer of a fund token still counts as a movement (it sat in the balance for a
    // moment); a token outside the mandate does not.
    let flux = f.flux;
    assert_eq!(push(&mut f, OTHER, SOLVER, 1_000, "", CLOSE + 61), 1_000);
    assert_eq!(f.flux, flux);
    assert_eq!(push(&mut f, WNEAR, SOLVER, 9, "hello", CLOSE + 61), 9);
    assert_eq!(push(&mut f, USDC, SOLVER, 0, "donate", CLOSE + 61), 0);
    assert_eq!(push(&mut f, USDC, SOLVER, u128::MAX, "donate", CLOSE + 61), u128::MAX);
    assert_eq!(f.flux, flux + 3);
}

// ------------------------------------------------------------------ v3: output while Sending

#[test]
fn v3_output_pushed_while_sending_is_kept_and_settles_when_the_send_confirms() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT + 5, "trade:0", CLOSE + 20), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Sending, MIN_OUT + 5, None));
    assert_eq!(held(&f, 1), MIN_OUT + 5);
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    ok_sent(&mut f, 0, CLOSE + 21);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Settled, MIN_OUT + 5, Some(CLOSE + 21)));
    assert!(f.get_fund().pending.is_none());
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT + 5));
}

#[test]
fn v3_partial_output_while_sending_does_not_settle_on_confirmation() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT - 1, "trade:0", CLOSE + 20), 0);
    ok_sent(&mut f, 0, CLOSE + 21);
    assert_eq!(trade(&f, 0).status, TradeStatus::Sent);
    assert_eq!(push(&mut f, WNEAR, SOLVER, 1, "trade:0", CLOSE + 22), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Settled);
}

#[test]
fn v3_a_failed_send_after_an_output_push_restores_the_input_and_keeps_the_push() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 20), 0);
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.closed_at), (TradeStatus::Failed, Some(CLOSE + 21)));
    assert!(f.get_fund().pending.is_none());
    assert_eq!((held(&f, 0), held(&f, 1)), (100_000_000, MIN_OUT));
    // Nothing can re-open it.
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 22), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Failed);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
}

// ------------------------------------------------------------------ v3: no balance read settles

/// Compile-time: `settle`, `absorb` and their callbacks do not exist on Plinth. If an inherent
/// method with one of these names came back, the calls below would resolve to it (inherent
/// methods win over trait methods) and stop compiling (wrong arity / return type).
#[test]
fn v3_there_is_no_settle_or_absorb_method() {
    struct Absent;
    trait Removed {
        fn settle(&mut self) -> Absent {
            Absent
        }
        fn absorb(&mut self) -> Absent {
            Absent
        }
        fn on_settle(&mut self) -> Absent {
            Absent
        }
        fn on_absorb(&mut self) -> Absent {
            Absent
        }
    }
    impl Removed for Plinth {}
    let mut f = funded();
    let _: [Absent; 4] = [f.settle(), f.absorb(), f.on_settle(), f.on_absorb()];
}

#[test]
fn v3_settle_refund_only_an_hour_after_the_trade_was_sent() {
    let mut f = sent_fund();
    set(ANYONE, REFUND_AT - 1);
    assert!(panics(|| f.settle_refund(0)).contains("an hour after the trade was sent"));
    // The callback obeys the same rule, whatever balance it is shown.
    assert_eq!(refund_now(&mut f, 0, 1_000_000_000, REFUND_AT - 1), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 90_000_000);
    set(ANYONE, REFUND_AT);
    f.settle_refund(0);
    // It reads the fund's balance of the token sold.
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(receipts.iter().any(|r| r.receiver_id.as_str() == USDC), "ft_balance_of on the sold token");
    assert!(!receipts.iter().any(|r| r.receiver_id.as_str() == WNEAR), "the bought token's balance is never read");
    assert!(panics(|| f.settle_refund(1)).contains("no such trade"));
}

#[test]
fn v3_settle_refund_refuses_a_trade_still_being_sent() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    set(ANYONE, REFUND_AT + 10);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    assert_eq!(refund_now(&mut f, 0, 1_000_000_000, REFUND_AT + 10), TradeStatus::Sending);
    assert_eq!(held(&f, 0), 90_000_000);
}

#[test]
fn v3_settle_refund_refuses_settled_trades() {
    let mut f = sent_fund();
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 60), 0);
    set(ANYONE, REFUND_AT);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    // Even a callback from a read requested earlier cannot credit a settled trade.
    assert_eq!(refund_now(&mut f, 0, 90_000_000 + REFUND, REFUND_AT), TradeStatus::Settled);
    assert_eq!(held(&f, 0), 90_000_000);
}

#[test]
fn v3_settle_refund_refuses_stakes() {
    // A settled stake.
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    // In flight (Sending).
    set(ANYONE, REFUND_AT);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    unwrapped(&mut f, 0, REFUND_AT);
    staked(&mut f, 0, Some(format!("\"{}\"", expected_mint()).as_bytes()), REFUND_AT);
    set(ANYONE, REFUND_AT + 1);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    assert_eq!(refund_now(&mut f, 0, 100 * FIVE, REFUND_AT + 1), TradeStatus::Settled);
    assert_eq!(held(&f, 1), 15 * 10u128.pow(24));
    // A failed stake.
    let mut g = staking_fund(0);
    assert!(stake(&mut g, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed, PromiseResult::Failed]);
    g.on_unwrapped(0);
    set(ANYONE, REFUND_AT);
    assert!(panics(|| g.settle_refund(0)).contains("not waiting for a refund"));
    assert_eq!(refund_now(&mut g, 0, 100 * FIVE, REFUND_AT + 1), TradeStatus::Failed);
    assert_eq!(held(&g, 1), 20 * 10u128.pow(24));
}

#[test]
fn v3_a_refund_is_counted_once_per_trade() {
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
    assert_eq!(trade(&f, 0).received_refund.0, REFUND);
    // A second request is refused...
    set(ANYONE, REFUND_AT + 2);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    // ...and a second callback (two requests were in the air at once) credits nothing, even with
    // the current flux and a balance that shows yet another refund's worth.
    assert_eq!(refund_now(&mut f, 0, 90_000_000 + 3 * REFUND, REFUND_AT + 3), TradeStatus::Refunded);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + 3 * REFUND, REFUND_AT + 3), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
}

#[test]
fn v3_settle_refund_waits_while_another_trade_is_being_sent() {
    let (mut f, at) = abandoned_fund();
    // Read requested, then a new trade goes out before the callback.
    let stale = request_refund(&mut f, 0, at);
    let q = Q { deposit: "c".repeat(64), issued: at + 5, deadline: at + 86_400, ..Default::default() };
    assert!(propose(&mut f, &q, at + 10));
    assert_eq!(trade(&f, 1).status, TradeStatus::Sending);
    set(ANYONE, at + 11);
    assert!(panics(|| f.settle_refund(0)).contains("another trade is being sent"));
    // The stale callback sees a balance that still holds trade 1's input: ignored.
    assert_eq!(refund_cb(&mut f, 0, stale, 90_000_000, at + 11), TradeStatus::Abandoned);
    assert_eq!(refund_now(&mut f, 0, 90_000_000, at + 11), TradeStatus::Abandoned);
    assert_eq!(held(&f, 0), 80_000_000);
    // Once trade 1's input has left, the check runs again.
    ok_sent(&mut f, 1, at + 12);
    let flux = request_refund(&mut f, 0, at + 13);
    assert_eq!(refund_cb(&mut f, 0, flux, 80_000_000 + REFUND, at + 14), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 80_000_000 + REFUND);
    // Trade 1 is still the pending one.
    assert_eq!(f.get_fund().pending.unwrap().id, 1);
}

#[test]
fn v3_settle_refund_waits_while_a_stakes_near_is_in_flight() {
    let mut f = staking_fund(0);
    // Swap wNEAR -> USDC, sent and written off.
    let q = Q { sell: WNEAR, buy: USDC, amount: FIVE, out: 10_000_000, min_out: 9_990_000, ..Default::default() };
    assert!(propose(&mut f, &q, CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    let at = q.deadline + ABANDON_AFTER_SECONDS + 1;
    set(ANYONE, at);
    f.abandon();
    assert!(stake(&mut f, 3 * 10u128.pow(24), at + 1));
    assert_eq!(f.near_in_flight, 3 * 10u128.pow(24));
    set(ANYONE, at + 2);
    assert!(panics(|| f.settle_refund(0)).contains("another trade is being sent"));
    assert_eq!(refund_now(&mut f, 0, 100 * FIVE, at + 2), TradeStatus::Abandoned);
    unwrapped(&mut f, 1, at + 3);
    assert!(panics(|| f.settle_refund(0)).contains("another trade is being sent"));
    staked(&mut f, 1, Some(b"\"1\""), at + 4);
    // 12 wNEAR held (20 - 5 - 3); the refund is 5 wNEAR minus the 4500 fee.
    let flux = request_refund(&mut f, 0, at + 5);
    assert_eq!(refund_cb(&mut f, 0, flux, 12 * 10u128.pow(24) + FIVE - 4_500, at + 6), TradeStatus::Refunded);
    assert_eq!(held(&f, 1), 12 * 10u128.pow(24) + FIVE - 4_500);
}

// ------------------------------------------------------------------ v3: refund amounts

#[test]
fn v3_settle_refund_credits_exactly_amount_in_minus_refund_fee_even_when_the_balance_shows_more() {
    for extra in [0u128, 1, 4_500, 10_000_000, 10u128.pow(30)] {
        let mut f = sent_fund();
        let flux = request_refund(&mut f, 0, REFUND_AT);
        assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND + extra, REFUND_AT + 1), TradeStatus::Refunded, "extra {extra}");
        assert_eq!(held(&f, 0), 90_000_000 + REFUND, "extra {extra}");
        let t = trade(&f, 0);
        assert_eq!((t.status, t.received_refund.0, t.received_out.0, t.closed_at), (TradeStatus::Refunded, REFUND, 0, Some(REFUND_AT + 1)));
        assert!(f.get_fund().pending.is_none());
        assert_eq!(held(&f, 1), 0);
    }
}

#[test]
fn v3_settle_refund_is_ignored_when_tokens_moved_between_the_read_and_the_callback() {
    let mut f = sent_fund();
    let stale = request_refund(&mut f, 0, REFUND_AT);
    // Someone pushes a donation of exactly a refund's worth while the read is in the air: the
    // balance the read saw may or may not include it, so the read is thrown away.
    assert_eq!(push(&mut f, USDC, "donor.test.near", REFUND, "donate", REFUND_AT), 0);
    assert_eq!(refund_cb(&mut f, 0, stale, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND, "only the donation is counted");
    assert_eq!(trade(&f, 0).received_refund.0, 0);
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    // A fresh read: the donation is accounted for, so the same balance shows no refund...
    let flux = request_refund(&mut f, 0, REFUND_AT + 2);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 3), TradeStatus::Sent);
    // ...until the refund really is there.
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + 2 * REFUND, REFUND_AT + 3), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + 2 * REFUND);
}

#[test]
fn v3_every_kind_of_token_movement_invalidates_a_refund_read() {
    // Each closure moves tokens (or may have); a read requested before it must be ignored after.
    let moves: Vec<(&str, Box<dyn Fn(&mut Plinth)>)> = vec![
        ("donation", Box::new(|f| assert_eq!(push(f, USDC, "d.test.near", 1, "donate", REFUND_AT), 0))),
        ("unmatched trade push", Box::new(|f| assert_eq!(push(f, USDC, "d.test.near", 1, "trade:9", REFUND_AT), 0))),
        ("partial output", Box::new(|f| assert_eq!(push(f, WNEAR, SOLVER, 1, "trade:0", REFUND_AT), 0))),
        (
            "redeem",
            Box::new(|f| {
                set(BOB, REFUND_AT);
                f.redeem(U128(1_000_000));
            }),
        ),
    ];
    for (what, mv) in moves {
        let mut f = sent_fund();
        let stale = request_refund(&mut f, 0, REFUND_AT);
        mv(&mut f);
        assert_ne!(f.flux, stale, "{what}");
        assert_eq!(refund_cb(&mut f, 0, stale, 10u128.pow(12), REFUND_AT + 1), TradeStatus::Sent, "{what}");
        assert_eq!(trade(&f, 0).received_refund.0, 0, "{what}");
    }
    // A payout resolving (either way) and a failed-payout claim.
    let mut f = sent_fund();
    set(BOB, REFUND_AT);
    f.redeem(U128(40_000_000));
    let stale = request_refund(&mut f, 0, REFUND_AT);
    payout(&mut f, BOB, 0, 36_000_000, false, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, stale, 10u128.pow(12), REFUND_AT + 1), TradeStatus::Sent);
    let stale = request_refund(&mut f, 0, REFUND_AT + 1);
    set(BOB, REFUND_AT + 1);
    f.claim(None);
    assert_eq!(refund_cb(&mut f, 0, stale, 10u128.pow(12), REFUND_AT + 2), TradeStatus::Sent);
    let stale = request_refund(&mut f, 0, REFUND_AT + 2);
    payout(&mut f, BOB, 0, 36_000_000, true, REFUND_AT + 2);
    assert_eq!(refund_cb(&mut f, 0, stale, 10u128.pow(12), REFUND_AT + 3), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 54_000_000);
}

#[test]
fn v3_settle_refund_is_ignored_when_the_balance_is_below_the_refund() {
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, REFUND_AT);
    for b in [0u128, 89_000_000, 90_000_000, 90_000_000 + REFUND - 1] {
        assert_eq!(refund_cb(&mut f, 0, flux, b, REFUND_AT + 1), TradeStatus::Sent, "balance {b}");
        assert_eq!(held(&f, 0), 90_000_000);
        assert_eq!(f.flux, flux, "an ignored read moves nothing");
    }
    assert!(get_logs().iter().any(|l| l.contains("a refund would be 9995500")));
    // The read itself failing changes nothing either.
    set_with_results(REFUND_AT + 1, vec![]);
    assert_eq!(f.on_settle_refund(0, flux, Err(PromiseError::Failed)), TradeStatus::Sent);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0, t.closed_at), (TradeStatus::Sent, 0, None));
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    // One unit more is enough.
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
}

#[test]
fn v3_a_refund_fee_of_the_whole_amount_can_never_be_counted() {
    let mut f = funded();
    assert!(propose(&mut f, &Q { refund_fee: AMOUNT_IN, ..Default::default() }, CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 10u128.pow(12), REFUND_AT + 1), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 90_000_000);
}

#[test]
fn v3_partial_output_does_not_block_a_refund() {
    // Some output was pushed (kept), then 1Click refunded: both stay with the fund.
    let mut f = sent_fund();
    assert_eq!(push(&mut f, WNEAR, SOLVER, 1_000, "trade:0", CLOSE + 60), 0);
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000 + REFUND, 1_000));
}

// ------------------------------------------------------------------ v3: refund, then late output

fn refunded_fund() -> Plinth {
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
    f
}

#[test]
fn v3_output_after_a_counted_refund_settles_the_trade_and_takes_the_refund_back() {
    let mut f = refunded_fund();
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    // Below min_out: kept, the refund stands.
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT - 10, "trade:0", REFUND_AT + 100), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0, t.received_out.0), (TradeStatus::Refunded, REFUND, MIN_OUT - 10));
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000 + REFUND, MIN_OUT - 10));
    // The rest arrives.
    assert_eq!(push(&mut f, WNEAR, SOLVER, 10, "trade:0", REFUND_AT + 200), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0, t.received_out.0, t.closed_at), (TradeStatus::Settled, 0, MIN_OUT, Some(REFUND_AT + 200)));
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT));
    assert!(get_logs().iter().any(|l| l.contains("\"refund_undone\"") && l.contains("\"9995500\"")));
    // The refund cannot be counted a second time now.
    set(ANYONE, REFUND_AT + 300);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
}

#[test]
fn v3_refund_undone_after_redemptions_exact_path() {
    let mut f = refunded_fund();
    // Bob (40%) leaves with his share of the counted refund.
    set(BOB, REFUND_AT + 10);
    f.redeem(U128(40_000_000));
    let bob_usdc = (90_000_000 + REFUND) * 40 / 100;
    assert_eq!(f.get_fund().in_flight_payouts[0].0, bob_usdc);
    payout(&mut f, BOB, 0, bob_usdc, true, REFUND_AT + 11);
    let left = 90_000_000 + REFUND - bob_usdc;
    assert_eq!(held(&f, 0), left);
    assert!(left >= REFUND);
    // The output arrives after all: the whole credit comes off what is left.
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", REFUND_AT + 20), 0);
    assert_eq!((held(&f, 0), held(&f, 1)), (left - REFUND, MIN_OUT));
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0), (TradeStatus::Settled, 0));
    assert_eq!(f.get_fund().total_shares.0, 60_000_000);
}

#[test]
fn v3_refund_undone_after_redemptions_saturating_path() {
    let mut f = refunded_fund();
    set(ALICE, REFUND_AT + 10);
    f.redeem(U128(60_000_000));
    set(BOB, REFUND_AT + 11);
    f.redeem(U128(39_999_999));
    // One share and one unit of USDC are left: far less than the 9.9955 USDC credit.
    assert_eq!((f.get_fund().total_shares.0, held(&f, 0)), (1, 1));
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", REFUND_AT + 20), 0);
    assert_eq!((held(&f, 0), held(&f, 1)), (0, MIN_OUT), "saturates at zero, no panic");
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0), (TradeStatus::Settled, 0));
    assert!(get_logs().iter().any(|l| l.contains("\"refund_undone\"") && l.contains("\"amount\":\"1\"")));
    // The last share still redeems (all of the output).
    set(BOB, REFUND_AT + 30);
    f.redeem(U128(1));
    assert_eq!(f.get_fund().in_flight_payouts[1].0, MIN_OUT);
    assert_eq!((held(&f, 0), held(&f, 1), f.get_fund().total_shares.0), (0, 0, 0));
}

#[test]
fn v3_refund_undone_does_not_touch_a_later_trade_in_flight() {
    let mut f = refunded_fund();
    let at = REFUND_AT + 700;
    let q = Q { deposit: "c".repeat(64), issued: at - 5, deadline: at + 86_400, ..Default::default() };
    assert!(propose(&mut f, &q, at));
    ok_sent(&mut f, 1, at + 1);
    let h = held(&f, 0);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", at + 2), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Settled);
    assert_eq!(held(&f, 0), h - REFUND);
    assert_eq!(f.get_fund().pending.unwrap().id, 1, "trade 1 is still in flight");
    assert_eq!(trade(&f, 1).status, TradeStatus::Sent);
}

// ------------------------------------------------------------------ v3: abandon

#[test]
fn v3_an_abandoned_trade_can_still_be_refunded() {
    let (mut f, at) = abandoned_fund();
    assert!(f.get_fund().pending.is_none());
    let flux = request_refund(&mut f, 0, at + 100);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND - 1, at + 101), TradeStatus::Abandoned);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, at + 101), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0, t.closed_at), (TradeStatus::Refunded, REFUND, Some(at + 101)));
    set(ANYONE, at + 102);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
}

#[test]
fn v3_late_output_settles_an_abandoned_trade() {
    let (mut f, at) = abandoned_fund();
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", at + 100), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Settled, MIN_OUT, Some(at + 100)));
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT));
    set(ANYONE, at + 101);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
}

#[test]
fn v3_a_refund_is_only_undone_within_a_day_of_the_deposit_deadline() {
    // The last moment 1Click could still be delivering: a day after the deposit address closed.
    let limit = Q::default().deadline + REFUND_UNDO_SECONDS;
    // At the limit: the push is the trade's output, the refund is taken back.
    let mut f = refunded_fund();
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", limit), 0);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_refund.0, t.received_out.0, t.closed_at), (TradeStatus::Settled, 0, MIN_OUT, Some(limit)));
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT));
    assert!(get_logs().iter().any(|l| l.contains("\"refund_undone\"")));
    // One second later: a gift. It is kept, the trade stays Refunded and the refund stands.
    let mut g = refunded_fund();
    let before = trade(&g, 0);
    assert_eq!(push(&mut g, WNEAR, SOLVER, MIN_OUT, "trade:0", limit + 1), 0);
    let t = trade(&g, 0);
    assert_eq!((t.status, t.received_refund.0, t.closed_at), (TradeStatus::Refunded, REFUND, before.closed_at));
    assert_eq!(t.received_out.0, MIN_OUT, "still recorded against the trade");
    assert_eq!((held(&g, 0), held(&g, 1)), (90_000_000 + REFUND, MIN_OUT));
    assert!(!get_logs().iter().any(|l| l.contains("\"refund_undone\"") || l.contains("\"trade_closed\"")));
    // More of it changes nothing either, and the refund cannot be counted again.
    assert_eq!(push(&mut g, WNEAR, SOLVER, 10 * MIN_OUT, "trade:0", limit + 2), 0);
    assert_eq!((trade(&g, 0).status, held(&g, 0), held(&g, 1)), (TradeStatus::Refunded, 90_000_000 + REFUND, 11 * MIN_OUT));
    set(ANYONE, limit + 3);
    assert!(panics(|| g.settle_refund(0)).contains("not waiting for a refund"));
    // Output pushed in parts across the limit: what decides is when min_out is reached.
    let mut h = refunded_fund();
    assert_eq!(push(&mut h, WNEAR, SOLVER, MIN_OUT - 1, "trade:0", limit), 0);
    assert_eq!(trade(&h, 0).status, TradeStatus::Refunded);
    assert_eq!(push(&mut h, WNEAR, SOLVER, 1, "trade:0", limit + 1), 0);
    assert_eq!((trade(&h, 0).status, held(&h, 0), held(&h, 1)), (TradeStatus::Refunded, 90_000_000 + REFUND, MIN_OUT));
}

#[test]
fn v3_abandoned_then_refunded_then_late_output() {
    // Abandoning takes a week past the deposit deadline, so a refund counted after that can no
    // longer be undone: the late push is kept as a gift and the refund stands.
    let (mut f, at) = abandoned_fund();
    let flux = request_refund(&mut f, 0, at + 100);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, at + 101), TradeStatus::Refunded);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", at + 200), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Refunded);
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000 + REFUND, MIN_OUT));
    // Without a counted refund, late output still settles an abandoned trade
    // (v3_late_output_settles_an_abandoned_trade).
}

// ------------------------------------------------------------------ v3: stakes

#[test]
fn v3_on_staked_credits_the_amount_deposit_and_stake_returned() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    let flux = f.flux;
    let minted = expected_mint() - 12_345; // inside the slippage band
    staked(&mut f, 0, Some(format!("\"{minted}\"").as_bytes()), CLOSE + 22);
    let t = trade(&f, 0);
    assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Settled, minted, Some(CLOSE + 22)));
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.held[1].1 .0, v.held[2].1 .0), (15 * 10u128.pow(24), minted));
    assert_eq!((f.near_in_flight, f.flux), (0, flux + 1));
    assert!(get_logs().iter().any(|l| l.contains("\"trade_closed\"")));
    assert!(!get_logs().iter().any(|l| l.contains("below the")));
}

#[test]
fn v3_on_staked_never_credits_more_than_the_price_allows() {
    let ceiling = mul_div(expected_mint(), 10_050, 10_000).unwrap();
    for returned in [ceiling, ceiling + 1, expected_mint() * 2, u128::MAX] {
        let mut f = staking_fund(0);
        assert!(stake(&mut f, FIVE, CLOSE + 20));
        unwrapped(&mut f, 0, CLOSE + 21);
        staked(&mut f, 0, Some(format!("\"{returned}\"").as_bytes()), CLOSE + 22);
        assert_eq!(held(&f, 2), ceiling, "returned {returned}");
        let t = trade(&f, 0);
        assert_eq!((t.status, t.received_out.0), (TradeStatus::Settled, ceiling));
    }
    // One below the ceiling is credited in full.
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    staked(&mut f, 0, Some(format!("\"{}\"", ceiling - 1).as_bytes()), CLOSE + 22);
    assert_eq!(held(&f, 2), ceiling - 1);
}

#[test]
fn v3_on_staked_with_an_unreadable_return_credits_nothing_but_closes() {
    for garbage in [&b""[..], b"null", b"{}", b"12345", b"\"abc\"", b"\"-1\"", b"true", b"[\"5\"]"] {
        let mut f = staking_fund(0);
        assert!(stake(&mut f, FIVE, CLOSE + 20));
        unwrapped(&mut f, 0, CLOSE + 21);
        staked(&mut f, 0, Some(garbage), CLOSE + 22);
        let t = trade(&f, 0);
        assert_eq!((t.status, t.received_out.0, t.closed_at), (TradeStatus::Settled, 0, Some(CLOSE + 22)), "{:?}", String::from_utf8_lossy(garbage));
        let v = f.get_fund();
        assert!(v.pending.is_none());
        assert_eq!((v.held[1].1 .0, v.held[2].1 .0), (15 * 10u128.pow(24), 0));
        assert_eq!(f.near_in_flight, 0);
        assert!(get_logs().iter().any(|l| l.contains("minted 0, below the")));
    }
}

#[test]
fn v3_a_failed_deposit_and_stake_takes_the_rewrap_path() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    unwrapped(&mut f, 0, CLOSE + 21);
    staked(&mut f, 0, None, CLOSE + 22);
    // Nothing credited; a near_deposit to the wNEAR contract was created; the stake stays open.
    assert_eq!((held(&f, 1), held(&f, 2)), (15 * 10u128.pow(24), 0));
    assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == WNEAR));
    assert_eq!(f.get_fund().pending.unwrap().status, TradeStatus::Sending);
    assert_eq!(f.near_in_flight, 0);
    set_with_results(CLOSE + 23, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(0, U128(FIVE));
    assert_eq!((held(&f, 1), held(&f, 2)), (20 * 10u128.pow(24), 0));
    assert_eq!(trade(&f, 0).status, TradeStatus::Failed);
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn v3_a_stake_counts_as_a_trade_for_cooldown_and_blocks_swaps_while_in_flight() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    assert!(!propose(&mut f, &Q::default(), CLOSE + 25));
    unwrapped(&mut f, 0, CLOSE + 26);
    staked(&mut f, 0, Some(b"\"1\""), CLOSE + 27);
    assert!(!propose(&mut f, &Q { msg: Some("trade:1".into()), issued: CLOSE + 100, ..Default::default() }, CLOSE + 110));
    assert!(last_reason(&f).contains("too soon"));
    // The swap after a stake is trade 1.
    let later = CLOSE + 20 + 660;
    assert!(propose(&mut f, &Q { issued: later, deadline: later + 86_400, ..Default::default() }, later));
    assert_eq!(f.get_fund().pending.unwrap().id, 1);
}

// ------------------------------------------------------------------ v3: recover_stuck_stake

const DAY_AFTER_STAKE: u64 = CLOSE + 20 + 86_401;

#[test]
fn v3_stuck_stake_with_large_free_near_and_no_growth_is_not_stranded() {
    // 0.2 (M1): any free NEAR above the stake amount was taken for the stake's NEAR. Here the fund
    // has ~47 NEAR free throughout, and the 5 NEAR never came back (it was staked, on_staked died).
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 50_000);
    assert!(f.stake_idle(U128(FIVE)));
    assert!(f.stake_near_before > 40 * 10u128.pow(24));
    with_balance(ANYONE, DAY_AFTER_STAKE, 50_000);
    f.recover_stuck_stake();
    let v = f.get_fund();
    assert_eq!(v.stranded_near.0, 0, "the fund's own NEAR is not the stake's");
    assert!(v.pending.is_none());
    assert_eq!(trade(&f, 0).status, TradeStatus::Failed);
    assert_eq!(trade(&f, 0).closed_at, Some(DAY_AFTER_STAKE));
    assert_eq!(f.near_in_flight, 0);
    assert_eq!(held(&f, 1), 15 * 10u128.pow(24));
    assert!(get_logs().iter().any(|l| l.contains("\"stake_recovered\"") && l.contains("\"stranded\":false")));
    assert!(panics(|| f.rewrap_stranded()).contains("nothing stranded"));
    // Trading continues.
    assert!(stake(&mut f, 3 * 10u128.pow(24), DAY_AFTER_STAKE + 1));
}

#[test]
fn v3_stuck_stake_whose_near_came_back_is_stranded() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 50_000);
    assert!(f.stake_idle(U128(FIVE)));
    with_balance(ANYONE, DAY_AFTER_STAKE, 55_000);
    f.recover_stuck_stake();
    let v = f.get_fund();
    assert_eq!(v.stranded_near.0, FIVE);
    assert!(v.pending.is_none());
    assert_eq!(trade(&f, 0).status, TradeStatus::Failed);
    assert!(get_logs().iter().any(|l| l.contains("\"stranded\":true")));
    // Stranded NEAR is not free NEAR.
    with_balance(ANYONE, DAY_AFTER_STAKE, 55_000);
    let free = f.get_fund().near_free.0;
    assert_eq!(free, f.raw_free_near() - FIVE);
}

#[test]
fn v3_stuck_stake_growth_tolerance_is_a_twentieth_of_a_near() {
    // Growth of 5 NEAR minus 0.05: present. One milli-NEAR less: not.
    for (growth_milli, stranded) in [(4_950u128, true), (4_949, false), (0, false), (2_500, false), (5_000, true), (9_000, true)] {
        let mut f = staking_fund(0);
        with_balance(OPERATOR, CLOSE + 20, 20_000);
        assert!(f.stake_idle(U128(FIVE)));
        with_balance(ANYONE, DAY_AFTER_STAKE, 20_000 + growth_milli);
        f.recover_stuck_stake();
        assert_eq!(f.get_fund().stranded_near.0, if stranded { FIVE } else { 0 }, "growth {growth_milli}");
    }
}

#[test]
fn v3_recover_stuck_stake_timing_and_scope() {
    let mut f = staking_fund(0);
    set(ANYONE, CLOSE + 20);
    assert!(panics(|| f.recover_stuck_stake()).contains("no trade in flight"));
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    set(ANYONE, CLOSE + 20 + 86_400);
    assert!(panics(|| f.recover_stuck_stake()).contains("too early"));
    assert!(panics(|| f.recover_stuck_trade()).contains("no swap is stuck"));
    // A swap in flight is not a stuck stake.
    let mut g = funded();
    assert!(propose(&mut g, &Q::default(), CLOSE + 20));
    set(ANYONE, DAY_AFTER_STAKE);
    assert!(panics(|| g.recover_stuck_stake()).contains("no stake is stuck"));
}

// ------------------------------------------------------------------ v3: recover_stuck_trade

#[test]
fn v3_recover_stuck_trade_after_a_day_treats_the_input_as_sent() {
    let mut f = funded();
    set(ANYONE, CLOSE + 20);
    assert!(panics(|| f.recover_stuck_trade()).contains("no trade in flight"));
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    // on_trade_sent never runs.
    set(ANYONE, CLOSE + 20 + 86_400);
    assert!(panics(|| f.recover_stuck_trade()).contains("too early"));
    set(ANYONE, CLOSE + 20 + 86_401);
    let flux = f.flux;
    f.recover_stuck_trade();
    let t = trade(&f, 0);
    assert_eq!((t.status, t.closed_at), (TradeStatus::Sent, None));
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    assert_eq!((held(&f, 0), f.flux), (90_000_000, flux + 1));
    // Not twice.
    assert!(panics(|| f.recover_stuck_trade()).contains("no swap is stuck"));
    // From here it behaves like any sent trade: output settles it...
    let mut g = funded();
    assert!(propose(&mut g, &Q::default(), CLOSE + 20));
    set(ANYONE, CLOSE + 20 + 86_401);
    g.recover_stuck_trade();
    assert_eq!(push(&mut g, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 20 + 86_402), 0);
    assert_eq!(trade(&g, 0).status, TradeStatus::Settled);
    // ...or, if the input never left (it is still in the balance), settle_refund counts it back,
    // less the refund fee.
    let flux = request_refund(&mut f, 0, CLOSE + 20 + 86_402);
    assert_eq!(refund_cb(&mut f, 0, flux, 100_000_000, CLOSE + 20 + 86_403), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 100_000_000 - 4_500);
    assert!(f.get_fund().pending.is_none());
}

#[test]
fn v3_recover_stuck_trade_settles_at_once_if_the_output_was_already_pushed() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 60), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Sending);
    set(ANYONE, CLOSE + 20 + 86_401);
    f.recover_stuck_trade();
    let t = trade(&f, 0);
    assert_eq!((t.status, t.closed_at), (TradeStatus::Settled, Some(CLOSE + 20 + 86_401)));
    assert!(f.get_fund().pending.is_none());
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT));
}

#[test]
fn v3_recover_stuck_trade_refuses_a_trade_that_was_sent() {
    let mut f = sent_fund();
    set(ANYONE, CLOSE + 20 + 86_401);
    assert!(panics(|| f.recover_stuck_trade()).contains("no swap is stuck"));
}

// ------------------------------------------------------------------ v3: in-kind join

const WNEAR_20: u128 = 20_000_000_000_000_000_000_000_000;

fn open_config() -> Config {
    let mut c = config();
    c.mandate.open_ended = true;
    c
}

fn fund_from(c: Config) -> Plinth {
    let n = c.mandate.tokens.len() as u8;
    let mut f = deploy(c);
    for i in 0..n {
        set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
        f.on_registered(i);
    }
    f
}

/// Open-ended fund after the window: Alice 60 / Bob 40 shares (x 1e6), 100 USDC and 20 wNEAR held.
fn open_fund() -> Plinth {
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, BOB, 40_000_000, T0 + 20).0, 0);
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", WNEAR_20, "donate", CLOSE + 1), 0);
    f
}

fn open_basket(f: &mut Plinth, who: &str, now: u64) {
    set_deposit(who, now, BASKET_DEPOSIT);
    f.open_basket();
}

fn fill_basket(f: &mut Plinth, who: &str, usdc: u128, wnear: u128, now: u64) {
    open_basket(f, who, now);
    if usdc > 0 {
        assert_eq!(push(f, USDC, who, usdc, "basket", now), 0);
    }
    if wnear > 0 {
        assert_eq!(push(f, WNEAR, who, wnear, "basket", now), 0);
    }
}

fn join(f: &mut Plinth, who: &str, min_shares: u128, now: u64) -> u128 {
    set(who, now);
    f.join_in_kind(U128(min_shares)).0
}

#[test]
fn v3_join_in_kind_mints_shares_in_proportion() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    // 10% of each holding.
    fill_basket(&mut f, CAROL, 10_000_000, WNEAR_20 / 10, now);
    let v = f.get_fund();
    assert_eq!(v.basket_total, vec![U128(10_000_000), U128(WNEAR_20 / 10)]);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(10_000_000), U128(WNEAR_20 / 10)]));
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (100_000_000, WNEAR_20), "a basket is not part of the holdings");
    assert_eq!(join(&mut f, CAROL, 10_000_000, now + 1), 10_000_000);
    let v = f.get_fund();
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (110_000_000, WNEAR_20 + WNEAR_20 / 10));
    assert_eq!(v.total_shares.0, 110_000_000);
    assert_eq!(v.total_subscribed.0, 100_000_000);
    assert_eq!(f.get_shares(acct(CAROL)).0, 10_000_000);
    assert_eq!(v.basket_total, vec![U128(0), U128(0)]);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(0), U128(0)]), "the emptied basket stays open");
    assert!(get_logs().iter().any(|l| l.contains("\"joined_in_kind\"")));
    // Carol redeems straight away and gets back exactly what she put in.
    set(CAROL, now + 2);
    f.redeem(U128(10_000_000));
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(10_000_000), U128(WNEAR_20 / 10)]);
}

#[test]
fn v3_join_in_kind_is_limited_by_the_scarcest_token_and_leaves_the_rest_in_the_basket() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    // 30% of the USDC but only 5% of the wNEAR: 5% of the shares.
    fill_basket(&mut f, CAROL, 30_000_000, WNEAR_20 / 20, now);
    assert_eq!(join(&mut f, CAROL, 0, now + 1), 5_000_000);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(25_000_000), U128(0)]));
    assert_eq!(f.get_fund().basket_total, vec![U128(25_000_000), U128(0)]);
    assert_eq!((held(&f, 0), held(&f, 1)), (105_000_000, WNEAR_20 + WNEAR_20 / 20));
    // Top up the wNEAR and join again with the leftovers: shares add up.
    assert_eq!(push(&mut f, WNEAR, CAROL, WNEAR_20, "basket", now + 2), 0);
    let s = join(&mut f, CAROL, 0, now + 3);
    assert_eq!(s, mul_div(25_000_000, 105_000_000, 105_000_000).unwrap());
    assert_eq!(f.get_shares(acct(CAROL)).0, 5_000_000 + s);
}

/// Per-share holdings never decrease: held_after / total_after >= held_before / total_before.
fn assert_not_diluted(held_before: u128, total_before: u128, held_after: u128, total_after: u128, what: &str) {
    // floor(held_after * total_before / total_after) >= held_before  <=>  the inequality above.
    assert!(mul_div(held_after, total_before, total_after).unwrap() >= held_before, "{what}: {held_before}/{total_before} -> {held_after}/{total_after}");
}

#[test]
fn v3_join_in_kind_rounding_favours_existing_holders() {
    let e = |n: u32| 10u128.pow(n);
    // (subscribed, donated USDC, donated wNEAR, basket USDC, basket wNEAR)
    let cases: Vec<(u128, u128, u128, u128, u128)> = vec![
        (100_000_000, 0, WNEAR_20, 10_000_000, WNEAR_20 / 10),
        (100_000_000, 7, WNEAR_20 + 13, 33_333_333, 7 * e(24)),
        (100_000_000, 7, WNEAR_20 + 13, 1, 7 * e(24)),
        (100_000_000, 7, WNEAR_20 + 13, 33_333_333, 1),
        (3, 0, 10, 1, 4),
        (3, 0, 10, 2, 9),
        (7, 4, 1, 5, 1),
        (1_000_000, 99_000_000, 1, 50_000_000, 1),
        (1, 999_999_999, 3, 1_000_000_000, 3),
        (e(37) + 3, e(36) + 1, e(38) + 7, e(37) + 11, 2 * e(37) + 5),
        (e(38), 0, e(38) + 1, e(38) - 1, e(38) - 1),
        (999_999_999_999_999_999_999_999_999, 1, 123_456_789_012_345_678_901_234_567_890, 5 * e(26) + 1, 7 * e(28) + 3),
        (3 * e(24) + 1, 2 * e(24) + 2, u128::MAX / 4, 5 * e(24) + 3, u128::MAX / 8 + 7),
        (e(30), 0, 1, e(29) + 1, 1),
        (e(6), e(32), e(32) + 1, 3 * e(31) + 1, 3 * e(31) + 2),
    ];
    for (k, (sub, d0, d1, b0, b1)) in cases.into_iter().enumerate() {
        let mut c = open_config();
        c.mandate.min_subscription = U128(1);
        c.mandate.max_total_subscriptions = U128(u128::MAX / 2);
        let mut f = fund_from(c);
        assert_eq!(subscribe(&mut f, ALICE, sub, T0 + 10).0, 0);
        if d0 > 0 {
            assert_eq!(push(&mut f, USDC, "donor.test.near", d0, "donate", CLOSE + 1), 0);
        }
        assert_eq!(push(&mut f, WNEAR, "donor.test.near", d1, "donate", CLOSE + 1), 0);
        let (h0, h1, total) = (sub + d0, d1, sub);
        fill_basket(&mut f, CAROL, b0, b1, CLOSE + 2);
        let s = mul_div(b0, total, h0).unwrap().min(mul_div(b1, total, h1).unwrap());
        if s == 0 {
            set(CAROL, CLOSE + 3);
            assert!(panics(|| f.join_in_kind(U128(0))).contains("too small"), "case {k}");
            assert_eq!((held(&f, 0), held(&f, 1), f.get_fund().total_shares.0), (h0, h1, total), "case {k}");
            continue;
        }
        assert_eq!(join(&mut f, CAROL, s, CLOSE + 3), s, "case {k}");
        let (t0, t1) = (mul_div_ceil(s, h0, total).unwrap(), mul_div_ceil(s, h1, total).unwrap());
        assert!(t0 <= b0 && t1 <= b1, "case {k}: never takes more than the basket holds");
        let v = f.get_fund();
        assert_eq!((v.held[0].1 .0, v.held[1].1 .0, v.total_shares.0), (h0 + t0, h1 + t1, total + s), "case {k}");
        assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(b0 - t0), U128(b1 - t1)]), "case {k}");
        assert_eq!(v.basket_total, vec![U128(b0 - t0), U128(b1 - t1)], "case {k}");
        assert_eq!(f.get_shares(acct(CAROL)).0, s, "case {k}");
        assert_not_diluted(h0, total, h0 + t0, total + s, &format!("case {k} USDC"));
        assert_not_diluted(h1, total, h1 + t1, total + s, &format!("case {k} wNEAR"));
        // What Alice's whole position redeems for did not go down...
        let alice = |h: u128, t: u128| mul_div(h, sub, t).unwrap();
        assert!(alice(h0 + t0, total + s) >= alice(h0, total) && alice(h1 + t1, total + s) >= alice(h1, total), "case {k}");
        // ...and the joiner cannot take out more than they put in.
        assert!(mul_div(h0 + t0, s, total + s).unwrap() <= t0 && mul_div(h1 + t1, s, total + s).unwrap() <= t1, "case {k}");
        // One more share was not affordable.
        assert!(mul_div_ceil(s + 1, h0, total).map_or(true, |x| x > b0) || mul_div_ceil(s + 1, h1, total).map_or(true, |x| x > b1), "case {k}");
    }
}

#[test]
fn v3_mul_div_ceil_rounds_up_exactly() {
    assert_eq!(mul_div_ceil(7, 3, 2), Some(11));
    assert_eq!(mul_div_ceil(6, 3, 2), Some(9));
    assert_eq!(mul_div_ceil(0, 3, 2), Some(0));
    assert_eq!(mul_div_ceil(1, 1, u128::MAX), Some(1));
    assert_eq!(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
    assert_eq!(mul_div_ceil(u128::MAX, u128::MAX - 1, u128::MAX), Some(u128::MAX - 1));
    // The quotient fits but rounding up does not.
    assert_eq!(mul_div(u128::MAX, 3, 3), Some(u128::MAX));
    assert_eq!(mul_div(u128::MAX - 1, u128::MAX, u128::MAX - 2), None);
    assert_eq!(mul_div_ceil(1, 1, 0), None);
    assert_eq!(mul_div_ceil(u128::MAX, 2, 1), None);
    let (a, b, d) = (10u128.pow(38) + 7, 10u128.pow(37) + 3, 10u128.pow(38) + 11);
    let (q, c) = (mul_div(a, b, d).unwrap(), mul_div_ceil(a, b, d).unwrap());
    assert_eq!(c, q + 1);
}

#[test]
fn v3_join_in_kind_min_shares_protects_the_joiner() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    fill_basket(&mut f, CAROL, 10_000_000, WNEAR_20 / 10, now);
    set(CAROL, now + 1);
    assert!(panics(|| f.join_in_kind(U128(10_000_001))).contains("too small for min_shares"));
    // The fund's holdings change before the join lands (a donation doubles the USDC): the same
    // basket now buys half the shares, and the joiner's min_shares refuses it.
    assert_eq!(push(&mut f, USDC, "donor.test.near", 100_000_000, "donate", now + 2), 0);
    set(CAROL, now + 3);
    assert!(panics(|| f.join_in_kind(U128(10_000_000))).contains("too small for min_shares"));
    // Nothing moved.
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(10_000_000), U128(WNEAR_20 / 10)]));
    assert_eq!((held(&f, 0), f.get_fund().total_shares.0, f.get_shares(acct(CAROL)).0), (200_000_000, 100_000_000, 0));
    // With a lower bound it goes through at the new proportions.
    assert_eq!(join(&mut f, CAROL, 5_000_000, now + 4), 5_000_000);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(0), U128(WNEAR_20 / 20)]));
}

#[test]
fn v3_join_in_kind_needs_every_token_the_fund_holds() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    fill_basket(&mut f, CAROL, 50_000_000, 0, now);
    set(CAROL, now + 1);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("too small"));
    assert!(panics(|| f.join_in_kind(U128(1))).contains("too small"));
    assert_eq!(f.get_shares(acct(CAROL)).0, 0);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(50_000_000), U128(0)]));
    // Without a basket at all.
    set("dave.test.near", now + 1);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("no basket"));
    assert!(panics(|| f.withdraw_basket()).contains("no basket"));
    // A token the fund holds none of is not needed.
    let mut g = fund_from(open_config());
    assert_eq!(subscribe(&mut g, ALICE, 100_000_000, T0 + 10).0, 0);
    fill_basket(&mut g, CAROL, 1_000_000, 5, now);
    assert_eq!(join(&mut g, CAROL, 0, now + 1), 1_000_000);
    assert_eq!(g.get_basket(acct(CAROL)), Some(vec![U128(0), U128(5)]));
    assert_eq!(held(&g, 1), 0);
}

#[test]
fn v3_join_in_kind_waits_for_a_trade_in_flight() {
    let mut f = open_fund();
    fill_basket(&mut f, CAROL, 10_000_000, WNEAR_20 / 10, CLOSE + 10);
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    set(CAROL, CLOSE + 21);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("a trade is in flight"));
    ok_sent(&mut f, 0, CLOSE + 22);
    set(CAROL, CLOSE + 23);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("a trade is in flight"));
    // Baskets can be filled meanwhile.
    assert_eq!(push(&mut f, USDC, CAROL, 1, "basket", CLOSE + 24), 0);
    // Settled: the join prices against the new holdings (90 USDC, 20 + 2.69 wNEAR).
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 30), 0);
    let s = join(&mut f, CAROL, 0, CLOSE + 31);
    assert_eq!(s, mul_div(WNEAR_20 / 10, 100_000_000, WNEAR_20 + MIN_OUT).unwrap());
}

#[test]
fn v3_join_in_kind_only_after_the_subscription_window() {
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    fill_basket(&mut f, CAROL, 10_000_000, 0, T0 + 20);
    set(CAROL, CLOSE - 1);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("the subscription window is open"));
    assert_eq!(join(&mut f, CAROL, 0, CLOSE), 10_000_000);
}

#[test]
fn v3_a_fund_that_is_not_open_ended_takes_no_baskets() {
    let mut f = funded();
    assert!(!f.get_fund().config.mandate.open_ended);
    set_deposit(CAROL, CLOSE + 10, BASKET_DEPOSIT);
    assert!(panics(|| f.open_basket()).contains("does not take in-kind joins"));
    assert!(panics(|| f.join_in_kind(U128(0))).contains("does not take in-kind joins"));
    assert!(panics(|| f.withdraw_basket()).contains("no basket"));
    // "basket" pushes come straight back, in and after the window.
    for now in [T0 + 100, CLOSE + 10] {
        assert_eq!(push(&mut f, USDC, CAROL, 5_000_000, "basket", now), 5_000_000);
        assert_eq!(push(&mut f, WNEAR, CAROL, 5, "basket", now), 5);
    }
    let v = f.get_fund();
    assert_eq!(v.basket_total, vec![U128(0), U128(0)]);
    assert_eq!((v.held[0].1 .0, v.total_shares.0), (100_000_000, 100_000_000));
    assert_eq!(f.get_basket(acct(CAROL)), None);
}

#[test]
fn v3_open_ended_defaults_to_false_in_json() {
    let mut j = serde_json::to_value(config()).unwrap();
    assert_eq!(j["mandate"]["open_ended"], json!(false));
    j["mandate"].as_object_mut().unwrap().remove("open_ended");
    let c: Config = serde_json::from_value(j).unwrap();
    assert!(!c.mandate.open_ended);
    assert_eq!(c, config());
}

#[test]
fn v3_basket_needs_open_basket_and_its_deposit() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    // No basket yet: returned.
    assert_eq!(push(&mut f, USDC, CAROL, 5_000_000, "basket", now), 5_000_000);
    assert!(get_logs().iter().any(|l| l.contains("no basket")));
    set_deposit(CAROL, now, BASKET_DEPOSIT - 1);
    assert!(panics(|| f.open_basket()).contains("attach 0.005 NEAR"));
    assert_eq!(f.get_basket(acct(CAROL)), None);
    open_basket(&mut f, CAROL, now);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(0), U128(0)]));
    let flux = f.flux;
    assert_eq!(push(&mut f, USDC, CAROL, 5_000_000, "basket", now), 0);
    assert_eq!(f.flux, flux + 2);
    // Opening again keeps what is in it.
    open_basket(&mut f, CAROL, now + 1);
    assert_eq!(f.get_basket(acct(CAROL)), Some(vec![U128(5_000_000), U128(0)]));
    // Someone else's push with "basket" does not land in Carol's basket.
    assert_eq!(push(&mut f, USDC, "dave.test.near", 7, "basket", now + 2), 7);
    assert_eq!(f.get_fund().basket_total, vec![U128(5_000_000), U128(0)]);
    // A token outside the mandate is returned as always.
    assert_eq!(push(&mut f, OTHER, CAROL, 7, "basket", now + 2), 7);
}

#[test]
fn v3_withdraw_basket_pays_everything_back_and_removes_the_entry() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    fill_basket(&mut f, CAROL, 30_000_000, WNEAR_20 / 20, now);
    assert_eq!(join(&mut f, CAROL, 0, now + 1), 5_000_000);
    assert_eq!(push(&mut f, WNEAR, CAROL, 9, "basket", now + 2), 0);
    let held_before = (held(&f, 0), held(&f, 1));
    let flux = f.flux;
    set(CAROL, now + 3);
    f.withdraw_basket();
    let v = f.get_fund();
    assert_eq!(f.get_basket(acct(CAROL)), None);
    assert_eq!(v.basket_total, vec![U128(0), U128(0)]);
    assert_eq!(v.in_flight_payouts, vec![U128(25_000_000), U128(9)]);
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), held_before);
    assert_eq!(f.flux, flux + 2);
    assert_eq!(f.get_shares(acct(CAROL)).0, 5_000_000, "shares already minted stay");
    assert!(panics(|| f.withdraw_basket()).contains("no basket"));
    // One payout lands, one fails and becomes claimable like a redemption payout.
    payout(&mut f, CAROL, 0, 25_000_000, true, now + 4);
    payout(&mut f, CAROL, 1, 9, false, now + 4);
    assert_eq!(f.get_owed(acct(CAROL)), vec![U128(0), U128(9)]);
    assert_eq!(f.get_fund().owed_total, vec![U128(0), U128(9)]);
    set(CAROL, now + 5);
    f.claim(None);
    payout(&mut f, CAROL, 1, 9, true, now + 6);
    assert!(f.get_owed(acct(CAROL)).is_empty());
    // With the basket gone, "basket" pushes are returned again.
    assert_eq!(push(&mut f, USDC, CAROL, 5, "basket", now + 7), 5);
}

#[test]
fn v3_an_empty_basket_can_be_closed_and_pays_nothing() {
    let mut f = open_fund();
    open_basket(&mut f, CAROL, CLOSE + 10);
    set(CAROL, CLOSE + 11);
    f.withdraw_basket();
    assert_eq!(f.get_basket(acct(CAROL)), None);
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(0), U128(0)]);
}

#[test]
fn v3_baskets_are_not_holdings() {
    let mut f = open_fund();
    let now = CLOSE + 100;
    // Carol parks ten times the fund in her basket.
    fill_basket(&mut f, CAROL, 1_000_000_000, 10 * WNEAR_20, now);
    // Bob's redemption is priced on holdings only.
    set(BOB, now + 1);
    f.redeem(U128(40_000_000));
    let v = f.get_fund();
    assert_eq!(v.in_flight_payouts, vec![U128(40_000_000), U128(WNEAR_20 * 40 / 100)]);
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (60_000_000, WNEAR_20 * 60 / 100));
    assert_eq!(v.basket_total, vec![U128(1_000_000_000), U128(10 * WNEAR_20)]);
    // Trade size is capped on holdings only: 25% of 60 USDC, not of 1060.
    assert!(!propose(&mut f, &Q { amount: 15_000_001, ..Default::default() }, now + 20));
    assert!(last_reason(&f).contains("of the 60000000 held"));
    assert!(propose(&mut f, &Q { amount: 15_000_000, issued: now + 15, deadline: now + 86_400, ..Default::default() }, now + 20));
    ok_sent(&mut f, 0, now + 21);
    // The basket is not a refund: balance = 45 held + 1000 basket + 40 in flight to Bob.
    let at = now + 20 + REFUND_WAIT_SECONDS;
    let flux = request_refund(&mut f, 0, at);
    assert_eq!(refund_cb(&mut f, 0, flux, 45_000_000 + 1_000_000_000 + 40_000_000, at + 1), TradeStatus::Sent);
    assert_eq!(refund_cb(&mut f, 0, flux, 45_000_000 + 1_000_000_000 + 40_000_000 + 15_000_000 - 4_500, at + 1), TradeStatus::Refunded);
    // Carol gets every unit back.
    set(CAROL, at + 2);
    f.withdraw_basket();
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(40_000_000 + 1_000_000_000), U128(WNEAR_20 * 40 / 100 + 10 * WNEAR_20)]);
}

#[test]
fn v3_join_in_kind_accrues_the_fee_first() {
    let mut c = open_config();
    c.mandate.management_fee_bps = 200;
    let mut f = fund_from(c);
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    let now = CLOSE + YEAR_SECONDS as u64;
    fill_basket(&mut f, CAROL, 10_000_000, 0, now);
    let s = join(&mut f, CAROL, 0, now);
    let op = f.get_fund().operator_shares.0;
    assert!(op > 2_000_000, "a year of 2% was minted before pricing the join: {op}");
    assert_eq!(s, mul_div(10_000_000, 100_000_000 + op, 100_000_000).unwrap());
    assert_eq!(f.get_fund().total_shares.0, 100_000_000 + op + s);
}

#[test]
fn v3_join_in_kind_needs_shares_and_holdings_to_price_against() {
    // Everyone left: no shares.
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    set(ALICE, T0 + 20);
    f.redeem(U128(100_000_000));
    fill_basket(&mut f, CAROL, 10_000_000, 5, CLOSE + 10);
    set(CAROL, CLOSE + 11);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("no shares to price a join against"));
    // Shares but no holdings (the last trade's input is gone and written off).
    let mut c = open_config();
    c.mandate.max_trade_bps = 10_000;
    let mut g = fund_from(c);
    assert_eq!(subscribe(&mut g, ALICE, 100_000_000, T0 + 10).0, 0);
    assert!(propose(&mut g, &Q { amount: 100_000_000, in_usd: "100.000000", out_usd: "99.900000", ..Default::default() }, CLOSE + 20));
    ok_sent(&mut g, 0, CLOSE + 21);
    set(ANYONE, Q::default().deadline + ABANDON_AFTER_SECONDS + 1);
    g.abandon();
    fill_basket(&mut g, CAROL, 10_000_000, 5, Q::default().deadline + ABANDON_AFTER_SECONDS + 2);
    set(CAROL, Q::default().deadline + REFUND_CLOSES_SECONDS + 1);
    assert!(panics(|| g.join_in_kind(U128(0))).contains("holds nothing to join"));
}

// ------------------------------------------------------------------ v3: claim / register / shares

#[test]
fn v3_claim_can_take_part_of_what_is_owed() {
    let mut f = funded();
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", 1_000, "donate", T0 + 50), 0);
    set(BOB, T0 + 100);
    f.redeem(U128(40_000_000));
    payout(&mut f, BOB, 0, 40_000_000, false, T0 + 101);
    payout(&mut f, BOB, 1, 400, false, T0 + 101);
    assert_eq!(f.get_owed(acct(BOB)), vec![U128(40_000_000), U128(400)]);
    // Part of the USDC, none of the wNEAR.
    set(BOB, T0 + 102);
    f.claim(Some(vec![U128(15_000_000), U128(0)]));
    assert_eq!(f.get_owed(acct(BOB)), vec![U128(25_000_000), U128(400)]);
    let v = f.get_fund();
    assert_eq!((v.owed_total.clone(), v.in_flight_payouts.clone()), (vec![U128(25_000_000), U128(400)], vec![U128(15_000_000), U128(0)]));
    payout(&mut f, BOB, 0, 15_000_000, true, T0 + 103);
    // A short list leaves the missing tokens alone; an amount over what is owed is capped.
    set(BOB, T0 + 104);
    f.claim(Some(vec![U128(u128::MAX)]));
    assert_eq!(f.get_owed(acct(BOB)), vec![U128(0), U128(400)]);
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(25_000_000), U128(0)]);
    payout(&mut f, BOB, 0, 25_000_000, false, T0 + 105); // fails again: owed again
    assert_eq!(f.get_owed(acct(BOB)), vec![U128(25_000_000), U128(400)]);
    // All zeros / empty: nothing moves, nothing is lost.
    set(BOB, T0 + 106);
    let flux = f.flux;
    f.claim(Some(vec![]));
    f.claim(Some(vec![U128(0), U128(0), U128(9)]));
    assert_eq!((f.get_owed(acct(BOB)), f.flux), (vec![U128(25_000_000), U128(400)], flux));
    // No list: everything.
    f.claim(None);
    assert!(f.get_owed(acct(BOB)).is_empty());
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(25_000_000), U128(400)]);
    assert_eq!(f.get_fund().owed_total, vec![U128(0), U128(0)]);
    assert!(panics(|| f.claim(None)).contains("nothing owed"));
    assert!(panics(|| f.claim(Some(vec![U128(1)]))).contains("nothing owed"));
    // Holdings were never touched by any of this.
    assert_eq!((held(&f, 0), held(&f, 1)), (60_000_000, 600));
    // Nobody can claim someone else's.
    set(ALICE, T0 + 107);
    assert!(panics(|| f.claim(None)).contains("nothing owed"));
}

#[test]
fn v3_register_retries_a_failed_registration() {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(config());
    set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
    f.on_registered(0);
    set_with_results(T0, vec![PromiseResult::Failed]);
    f.on_registered(1);
    assert_eq!(f.get_fund().registered, vec![true, false]);
    set(ANYONE, T0 + 5);
    assert!(panics(|| f.register(0)).contains("already registered"));
    assert!(panics(|| f.register(2)).contains("no such token"));
    assert!(panics(|| f.register(255)).contains("no such token"));
    // Not from the reserve.
    with_balance(ANYONE, T0 + 5, 30);
    assert!(panics(|| f.register(1)).contains("no NEAR left for a registration"));
    set(ANYONE, T0 + 6);
    f.register(1);
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(receipts.iter().any(|r| r.receiver_id.as_str() == WNEAR), "storage_deposit on the token");
    assert_eq!(f.get_fund().registered, vec![true, false], "not until the token confirms");
    // The retry fails again, then works.
    set_with_results(T0 + 7, vec![PromiseResult::Failed]);
    f.on_registered(1);
    assert_eq!(f.get_fund().registered, vec![true, false]);
    set(ANYONE, T0 + 8);
    f.register(1);
    set_with_results(T0 + 9, vec![PromiseResult::Successful(vec![])]);
    f.on_registered(1);
    assert_eq!(f.get_fund().registered, vec![true, true]);
    set(ANYONE, T0 + 10);
    assert!(panics(|| f.register(1)).contains("already registered"));
    // And the fund can trade the token now.
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
}

#[test]
fn v3_a_full_redeem_removes_the_share_entry() {
    let mut f = funded();
    let bob = acct(BOB);
    set(BOB, T0 + 100);
    f.redeem(U128(39_999_999));
    assert_eq!(f.shares.get(&bob), Some(&1), "a partial redeem keeps the entry");
    f.redeem(U128(1));
    assert_eq!(f.get_shares(bob.clone()).0, 0);
    assert!(f.shares.get(&bob).is_none(), "the entry is gone, not zero");
    assert!(panics(|| f.redeem(U128(1))).contains("not enough shares"));
    // Re-subscribing works and starts from zero.
    assert_eq!(subscribe(&mut f, BOB, 7_000_000, T0 + 200).0, 0);
    assert_eq!(f.get_shares(bob.clone()).0, 7_000_000);
    assert_eq!(f.get_fund().total_shares.0, 67_000_000);
    // A re-subscription is a new entry: it needs storage NEAR like any new depositor.
    set(BOB, T0 + 300);
    f.redeem(U128(7_000_000));
    with_balance(USDC, T0 + 301, 40);
    assert_eq!(f.ft_on_transfer(bob.clone(), U128(7_000_000), String::new()).0, 7_000_000);
    // An existing holder is not subject to that check.
    assert_eq!(f.ft_on_transfer(acct(ALICE), U128(7_000_000), String::new()).0, 0);
}

#[test]
fn v3_the_operators_entry_is_kept_when_there_is_a_fee() {
    let mut f = staking_fund(100);
    let op = acct(OPERATOR);
    set(ANYONE, CLOSE + YEAR_SECONDS as u64);
    f.accrue();
    let fee = f.get_shares(op.clone()).0;
    assert!(fee > 0);
    set(OPERATOR, CLOSE + YEAR_SECONDS as u64);
    f.redeem(U128(fee));
    assert_eq!(f.shares.get(&op), Some(&0), "kept at zero for later fee shares");
    // Later fees land in it.
    set(ANYONE, CLOSE + 2 * YEAR_SECONDS as u64);
    f.accrue();
    assert!(f.get_shares(op.clone()).0 > 0);
    // Without a fee the operator is a depositor like any other.
    let mut g = fund();
    assert!(g.shares.get(&op).is_none());
    assert_eq!(subscribe(&mut g, OPERATOR, 5_000_000, T0 + 10).0, 0);
    set(OPERATOR, T0 + 11);
    g.redeem(U128(5_000_000));
    assert!(g.shares.get(&op).is_none());
}

// ------------------------------------------------------------------ v3: views

#[test]
fn v3_views_saturate_instead_of_overflowing() {
    let mut f = sent_fund();
    assert!(!propose(&mut f, &Q::default(), CLOSE + 30));
    assert_eq!(f.get_trades(u64::MAX, u64::MAX), vec![]);
    assert_eq!(f.get_trades(0, u64::MAX).len(), 1);
    assert_eq!(f.get_trades(1, u64::MAX), vec![]);
    assert_eq!(f.get_trades(u64::MAX, 1), vec![]);
    assert_eq!(f.get_trades(0, 0), vec![]);
    assert_eq!(f.get_trades(1 << 32, 1), vec![], "no wrap-around to trade 0");
    assert_eq!(f.get_rejections(u32::MAX, u32::MAX), vec![]);
    assert_eq!(f.get_rejections(0, u32::MAX).len(), 1);
    assert_eq!(f.get_rejections(1, u32::MAX), vec![]);
    assert_eq!(f.get_rejections(u32::MAX, 1), vec![]);
}

#[test]
fn v3_fund_view_reports_version_baskets_owed_and_daily_cost() {
    let mut f = open_fund();
    let v = f.get_fund();
    assert_eq!(v.version, "0.3.0");
    assert_eq!(v.version, VERSION);
    // 2500 bps x 100 bps x 3 a day = 75 bps of a holding a day.
    assert_eq!(v.max_daily_cost_bps, 75);
    assert_eq!((v.basket_total.clone(), v.owed_total.clone()), (vec![U128(0), U128(0)], vec![U128(0), U128(0)]));
    assert_eq!(v.near_free.0, v.near_available_for_registrations.0 + 50_000_000_000_000_000_000_000);
    fill_basket(&mut f, CAROL, 3, 4, CLOSE + 10);
    assert_eq!(f.get_fund().basket_total, vec![U128(3), U128(4)]);
    assert_eq!(f.get_basket(acct(ALICE)), None);
    // Capped at 100%.
    let mut c = config();
    c.mandate.max_trade_bps = 10_000;
    c.mandate.max_cost_bps = 10_000;
    c.mandate.max_trades_per_day = u32::MAX;
    assert_eq!(fund_from(c).get_fund().max_daily_cost_bps, 10_000);
}

#[test]
fn v3_near_free_excludes_a_stakes_near_and_stranded_near() {
    let mut f = staking_fund(0);
    with_balance(ANYONE, CLOSE + 10, 20_000);
    let free = f.get_fund().near_free.0;
    with_balance(OPERATOR, CLOSE + 20, 20_000);
    assert!(f.stake_idle(U128(FIVE)));
    with_balance(ANYONE, CLOSE + 21, 20_000);
    assert_eq!(f.get_fund().near_free.0, free - FIVE);
}

#[test]
fn v3_trade_size_check_does_not_overflow_on_huge_holdings() {
    let mut f = funded();
    // max_trade_bps x held would overflow u128 without mul_div.
    assert_eq!(push(&mut f, USDC, "donor.test.near", u128::MAX / 2, "donate", T0 + 100), 0);
    assert!(!propose(&mut f, &Q { amount: u128::MAX / 4, ..Default::default() }, CLOSE + 20));
    assert!(last_reason(&f).contains("over 2500 bps"), "{}", last_reason(&f));
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    let mut g = staking_fund(0);
    assert_eq!(push(&mut g, WNEAR, "donor.test.near", u128::MAX / 2, "donate", T0 + 100), 0);
    assert!(!stake(&mut g, u128::MAX / 4, CLOSE + 20));
    assert!(last_reason(&g).contains("over 2500 bps"));
    assert!(stake(&mut g, u128::MAX / 16, CLOSE + 20));
}

// ------------------------------------------------------------------ v3: property test

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform-ish in lo..=hi.
    fn range(&mut self, lo: u128, hi: u128) -> u128 {
        if hi <= lo {
            return lo;
        }
        let r = ((self.next() as u128) << 64) | self.next() as u128;
        lo + r % (hi - lo + 1)
    }
    fn chance(&mut self, one_in: u64) -> bool {
        self.next() % one_in == 0
    }
}

const USERS: [&str; 5] = ["u0.test.near", "u1.test.near", "u2.test.near", "u3.test.near", "u4.test.near"];
const TOKENS: [&str; 2] = [USDC, WNEAR];

/// The model: what each token contract would say the fund's balance is.
struct World {
    f: Plinth,
    real: [u128; 2],
    now: u64,
    rng: Rng,
    deposits: u64,
    /// Refunded trades whose output might still turn up: (id, buy index, min_out).
    refunded: Vec<(u64, usize, u128)>,
    stats: std::collections::BTreeMap<&'static str, u32>,
}

impl World {
    fn count(&mut self, what: &'static str) {
        *self.stats.entry(what).or_insert(0) += 1;
    }

    /// An ft_transfer_call to the fund: the token keeps what the fund does not return.
    fn push(&mut self, i: usize, from: &str, amount: u128, msg: &str) -> u128 {
        let returned = push(&mut self.f, TOKENS[i], from, amount, msg, self.now);
        assert!(returned == 0 || returned == amount);
        self.real[i] += amount - returned;
        returned
    }

    fn in_flight(&self) -> Vec<u128> {
        self.f.get_fund().in_flight_payouts.iter().map(|x| x.0).collect()
    }

    /// Execute the ft_transfers the fund just issued to `who` (the growth of in_flight), mostly
    /// successfully. Returns what was issued per token.
    fn resolve_payouts(&mut self, who: &str, before: &[u128]) -> Vec<u128> {
        let after = self.in_flight();
        let issued: Vec<u128> = (0..2).map(|i| after[i] - before[i]).collect();
        for i in 0..2 {
            if issued[i] > 0 {
                let ok = !self.rng.chance(7);
                payout(&mut self.f, who, i as u8, issued[i], ok, self.now);
                if ok {
                    assert!(self.real[i] >= issued[i], "the fund paid out more of token {i} than it has");
                    self.real[i] -= issued[i];
                } else {
                    self.count("payout failed");
                }
            }
        }
        issued
    }

    fn check(&self, step: usize, what: &str) {
        let v = self.f.get_fund();
        let mut shares = 0u128;
        let mut baskets = [0u128; 2];
        let mut owed = [0u128; 2];
        for who in USERS.iter().chain([OPERATOR].iter()) {
            shares += self.f.get_shares(acct(who)).0;
            if let Some(b) = self.f.get_basket(acct(who)) {
                baskets[0] += b[0].0;
                baskets[1] += b[1].0;
            }
            for (i, o) in self.f.get_owed(acct(who)).iter().enumerate() {
                owed[i] += o.0;
            }
        }
        assert_eq!(shares, v.total_shares.0, "step {step} ({what}): shares do not add up");
        for i in 0..2 {
            assert_eq!(baskets[i], v.basket_total[i].0, "step {step} ({what}): baskets of token {i}");
            assert_eq!(owed[i], v.owed_total[i].0, "step {step} ({what}): owed of token {i}");
            assert_eq!(v.in_flight_payouts[i].0, 0, "step {step} ({what}): every payout was resolved");
            let accounted = v.held[i].1 .0 + v.owed_total[i].0 + v.in_flight_payouts[i].0 + v.basket_total[i].0;
            assert_eq!(accounted, self.f.accounted(i));
            assert!(
                self.real[i] >= accounted,
                "step {step} ({what}): token {i} balance {} < accounted {accounted} (held {}, owed {}, baskets {})",
                self.real[i],
                v.held[i].1 .0,
                v.owed_total[i].0,
                v.basket_total[i].0
            );
        }
        if let Some(t) = &v.pending {
            assert!(matches!(t.status, TradeStatus::Sending | TradeStatus::Sent), "step {step} ({what}): pending trade is {:?}", t.status);
        }
    }

    fn subscribe(&mut self) {
        let who = USERS[self.rng.range(0, 4) as usize];
        let amount = self.rng.range(500_000, 30_000_000);
        let before = self.f.get_shares(acct(who)).0;
        let returned = self.push(0, who, amount, "");
        if self.now >= CLOSE {
            assert_eq!(returned, amount, "no subscriptions after the window");
        }
        assert_eq!(self.f.get_shares(acct(who)).0, before + amount - returned);
        if returned == 0 {
            self.count("subscribed");
        }
    }

    fn donate(&mut self) {
        let i = self.rng.range(0, 1) as usize;
        let amount = if i == 0 { self.rng.range(1, 5_000_000) } else { self.rng.range(1, 3 * 10u128.pow(24)) };
        let total = self.f.get_fund().total_shares.0;
        assert_eq!(self.push(i, "donor.test.near", amount, "donate"), 0);
        assert_eq!(self.f.get_fund().total_shares.0, total);
        self.count("donated");
    }

    fn basket_and_join(&mut self) {
        let who = USERS[self.rng.range(0, 4) as usize];
        open_basket(&mut self.f, who, self.now);
        for i in 0..2 {
            if self.rng.chance(6) {
                continue; // sometimes leave a token out
            }
            let h = held(&self.f, i);
            let amount = if h == 0 { self.rng.range(1, 1_000) } else { self.rng.range(1, h / 3 + 2) };
            assert_eq!(self.push(i, who, amount, "basket"), 0);
        }
        set(ANYONE, self.now);
        self.f.accrue();
        let v = self.f.get_fund();
        let total = v.total_shares.0;
        let h: Vec<u128> = v.held.iter().map(|x| x.1 .0).collect();
        let b: Vec<u128> = self.f.get_basket(acct(who)).unwrap().iter().map(|x| x.0).collect();
        if self.now >= CLOSE && v.pending.is_none() && total > 0 && h.iter().any(|x| *x > 0) {
            let s = (0..2).filter(|i| h[*i] > 0).map(|i| mul_div(b[i], total, h[i]).unwrap()).min().unwrap();
            if s > 0 {
                let mine = self.f.get_shares(acct(who)).0;
                assert_eq!(join(&mut self.f, who, s, self.now), s);
                let after = self.f.get_fund();
                let b2 = self.f.get_basket(acct(who)).unwrap();
                for i in 0..2 {
                    let take = if h[i] > 0 { mul_div_ceil(s, h[i], total).unwrap() } else { 0 };
                    assert_eq!(after.held[i].1 .0, h[i] + take);
                    assert_eq!(b2[i].0, b[i] - take);
                    assert_not_diluted(h[i], total, h[i] + take, total + s, "join");
                }
                assert_eq!(after.total_shares.0, total + s);
                assert_eq!(self.f.get_shares(acct(who)).0, mine + s);
                self.count("joined");
            }
        }
        if self.rng.chance(2) {
            let before = self.in_flight();
            let b: Vec<u128> = self.f.get_basket(acct(who)).unwrap().iter().map(|x| x.0).collect();
            set(who, self.now);
            self.f.withdraw_basket();
            assert_eq!(self.resolve_payouts(who, &before), b, "the basket is paid back in full");
            assert_eq!(self.f.get_basket(acct(who)), None);
            self.count("basket withdrawn");
        }
    }

    fn redeem(&mut self) {
        let who = if self.rng.chance(8) { OPERATOR } else { USERS[self.rng.range(0, 4) as usize] };
        set(ANYONE, self.now);
        self.f.accrue();
        let v = self.f.get_fund();
        let mine = self.f.get_shares(acct(who)).0;
        if mine == 0 || v.pending.as_ref().map_or(false, |t| self.now < t.sent_at + REDEEM_WAIT_SECONDS) {
            return;
        }
        let shares = if self.rng.chance(4) { mine } else { self.rng.range(1, mine) };
        let total = v.total_shares.0;
        let expected: Vec<u128> = v.held.iter().map(|h| mul_div(h.1 .0, shares, total).unwrap()).collect();
        let before = self.in_flight();
        set(who, self.now);
        self.f.redeem(U128(shares));
        let after = self.f.get_fund();
        for i in 0..2 {
            assert_eq!(after.held[i].1 .0, v.held[i].1 .0 - expected[i]);
        }
        assert_eq!(after.total_shares.0, total - shares);
        assert_eq!(self.f.get_shares(acct(who)).0, mine - shares);
        if shares == mine && who != OPERATOR {
            assert!(self.f.shares.get(&acct(who)).is_none());
        }
        assert_eq!(self.resolve_payouts(who, &before), expected, "redeem pays exactly floor(held * shares / total)");
        self.count("redeemed");
    }

    fn claim(&mut self) {
        let who = USERS[self.rng.range(0, 4) as usize];
        let owed: Vec<u128> = self.f.get_owed(acct(who)).iter().map(|x| x.0).collect();
        if owed.is_empty() {
            return;
        }
        let want: Vec<u128> = if self.rng.chance(2) { owed.clone() } else { owed.iter().map(|o| o / 2 + o % 2).collect() };
        let before = self.in_flight();
        set(who, self.now);
        self.f.claim(if want == owed && self.rng.chance(2) { None } else { Some(want.iter().map(|x| U128(*x)).collect()) });
        assert_eq!(self.resolve_payouts(who, &before), want);
        self.count("claimed");
    }

    fn trade(&mut self) {
        let v = self.f.get_fund();
        let Some(t) = v.pending else {
            // Propose a new one.
            let sell = self.rng.range(0, 1) as usize;
            let buy = 1 - sell;
            let h = v.held[sell].1 .0;
            let max = h / 4;
            if max < 10_000 || self.now < CLOSE {
                return;
            }
            let amount = self.rng.range(5_000, max);
            let out = if buy == 1 { self.rng.range(10u128.pow(21), 10u128.pow(24)) } else { self.rng.range(100_000, 20_000_000) };
            self.deposits += 1;
            let q = Q {
                sell: TOKENS[sell],
                buy: TOKENS[buy],
                amount,
                out,
                min_out: out - out / 1_000,
                issued: self.now - 5,
                deadline: self.now + 3 * 86_400,
                deposit: format!("{:064x}", self.deposits),
                ..Default::default()
            };
            if !propose(&mut self.f, &q, self.now) {
                self.count("refused");
                return;
            }
            let id = self.f.get_fund().trades - 1;
            assert_eq!(held(&self.f, sell), h - amount);
            // Sometimes the output is pushed before the send is confirmed.
            let early = self.rng.chance(5);
            if early {
                assert_eq!(self.push(buy, SOLVER, out, &format!("trade:{id}")), 0);
                assert_eq!(trade(&self.f, id).status, TradeStatus::Sending);
            }
            if self.rng.chance(10) {
                // The transfer to the deposit address fails: nothing leaves.
                set_with_results(self.now, vec![PromiseResult::Failed]);
                self.f.on_trade_sent(id);
                assert_eq!(held(&self.f, sell), h);
                assert_eq!(trade(&self.f, id).status, TradeStatus::Failed);
                self.count("send failed");
            } else {
                ok_sent(&mut self.f, id, self.now);
                self.real[sell] -= amount;
                assert_eq!(trade(&self.f, id).status, if early { TradeStatus::Settled } else { TradeStatus::Sent });
                self.count("sent");
                if early {
                    self.count("settled");
                }
            }
            return;
        };
        if t.status != TradeStatus::Sent {
            return;
        }
        let (sell, buy) = (t.sell as usize, t.buy as usize);
        match self.rng.range(0, 2) {
            0 => {
                // 1Click delivers, in one or two pushes.
                let first = if self.rng.chance(3) { self.rng.range(1, t.min_out.0 - 1) } else { t.quoted_out.0 };
                let h = held(&self.f, buy);
                assert_eq!(self.push(buy, SOLVER, first, &format!("trade:{}", t.id)), 0);
                if first < t.min_out.0.saturating_sub(t.received_out.0) {
                    assert_eq!(trade(&self.f, t.id).status, TradeStatus::Sent);
                    assert_eq!(self.push(buy, SOLVER, t.quoted_out.0 - first, &format!("trade:{}", t.id)), 0);
                }
                assert_eq!(trade(&self.f, t.id).status, TradeStatus::Settled);
                assert!(self.f.get_fund().pending.is_none());
                assert!(held(&self.f, buy) >= h + t.min_out.0.saturating_sub(t.received_out.0));
                self.count("settled");
            }
            1 if self.now >= t.sent_at + REFUND_WAIT_SECONDS => {
                // 1Click refunds by plain transfer; then anyone asks the fund to look.
                let refund = t.amount_in.0 - t.refund_fee.0;
                self.real[sell] += refund;
                let h = held(&self.f, sell);
                let mut flux = request_refund(&mut self.f, t.id, self.now);
                if self.rng.chance(4) {
                    // Tokens move while the read is in the air: that read is ignored.
                    assert_eq!(self.push(sell, "donor.test.near", refund, "donate"), 0);
                    assert_eq!(refund_cb(&mut self.f, t.id, flux, self.real[sell], self.now), TradeStatus::Sent);
                    assert_eq!(held(&self.f, sell), h + refund, "only the donation");
                    flux = request_refund(&mut self.f, t.id, self.now);
                    self.count("refund read ignored");
                }
                let h = held(&self.f, sell);
                assert_eq!(refund_cb(&mut self.f, t.id, flux, self.real[sell], self.now), TradeStatus::Refunded);
                assert_eq!(held(&self.f, sell), h + refund, "exactly amount_in - refund_fee");
                assert!(self.f.get_fund().pending.is_none());
                self.refunded.push((t.id, buy, t.min_out.0.saturating_sub(t.received_out.0)));
                self.count("refunded");
            }
            _ => {}
        }
    }

    fn misc(&mut self) {
        let trades = self.f.get_fund().trades;
        if trades == 0 {
            return;
        }
        if self.rng.chance(3) && !self.refunded.is_empty() {
            // Output for a trade that was counted as refunded turns up after all.
            let k = self.rng.range(0, self.refunded.len() as u128 - 1) as usize;
            let (id, buy, need) = self.refunded.swap_remove(k);
            let before = trade(&self.f, id);
            let seen = self.stats.get("refund undone").copied().unwrap_or(0) + self.stats.get("late gift").copied().unwrap_or(0);
            if seen % 2 == 1 {
                self.now += 5 * 86_400; // long after 1Click could still deliver
            }
            let sell_held = held(&self.f, before.sell as usize);
            assert_eq!(self.push(buy, SOLVER, need.max(1), &format!("trade:{id}")), 0);
            let t = trade(&self.f, id);
            if self.now > before.deposit_deadline.max(before.sent_at) + REFUND_UNDO_SECONDS {
                // Too late to be the trade's output: a gift, the refund stands.
                assert_eq!((t.status, t.received_refund), (TradeStatus::Refunded, before.received_refund));
                assert_eq!(held(&self.f, before.sell as usize), sell_held);
                self.count("late gift");
                return;
            }
            assert_eq!((t.status, t.received_refund.0), (TradeStatus::Settled, 0));
            self.count("refund undone");
            return;
        }
        // An honest balance read for any trade at any time never breaks the books.
        let id = self.rng.range(0, trades as u128 - 1) as u64;
        let sell = trade(&self.f, id).sell as usize;
        let h = held(&self.f, sell);
        let flux = self.f.flux;
        let status = refund_cb(&mut self.f, id, flux, self.real[sell], self.now);
        if status == TradeStatus::Refunded && held(&self.f, sell) != h {
            // Only possible when the balance really holds that much more than the fund counts.
            self.count("surplus counted as a refund");
            let t = trade(&self.f, id);
            self.refunded.push((id, t.buy as usize, t.min_out.0.saturating_sub(t.received_out.0)));
        }
        // Stray pushes: wrong id, wrong token.
        let i = self.rng.range(0, 1) as usize;
        let before = self.f.get_trades(0, u64::MAX);
        let dust = self.rng.range(1, 1_000);
        assert_eq!(self.push(i, "stray.test.near", dust, &format!("trade:{}", trades + 3)), 0);
        assert_eq!(self.f.get_trades(0, u64::MAX), before);
    }
}

fn run_world(seed: u64, steps: usize) -> World {
    let mut c = open_config();
    c.mandate.max_trades_per_day = 1_000;
    c.mandate.management_fee_bps = 100;
    let mut w = World { f: fund_from(c), real: [0, 0], now: T0 + 1, rng: Rng(seed), deposits: 0, refunded: vec![], stats: Default::default() };
    for step in 0..steps {
        // Slow steps while the subscription window is open, so it sees a fair number of them.
        w.now += if w.now < CLOSE {
            w.rng.range(5, 60) as u64
        } else if w.rng.chance(8) {
            4_000
        } else {
            w.rng.range(20, 500) as u64
        };
        let action = w.rng.range(0, 11);
        let what = match action {
            0 | 1 => {
                w.subscribe();
                "subscribe"
            }
            2 => {
                w.donate();
                "donate"
            }
            3 | 4 => {
                w.basket_and_join();
                "basket/join"
            }
            5 | 6 => {
                w.redeem();
                "redeem"
            }
            7 => {
                w.claim();
                "claim"
            }
            8 | 9 | 10 => {
                w.trade();
                "trade"
            }
            _ => {
                w.misc();
                "misc"
            }
        };
        w.check(step, what);
    }
    w
}

#[test]
fn v3_property_random_sequences_keep_the_books_inside_the_real_balances() {
    let mut totals: std::collections::BTreeMap<&'static str, u32> = Default::default();
    for seed in [0x9E37_79B9_7F4A_7C15u64, 20_261_110] {
        let w = run_world(seed, 450);
        for (k, n) in &w.stats {
            *totals.entry(k).or_insert(0) += n;
        }
    }
    // The runs must actually have exercised every path.
    for (what, at_least) in [
        ("subscribed", 10),
        ("donated", 30),
        ("joined", 8),
        ("basket withdrawn", 30),
        ("redeemed", 15),
        ("claimed", 8),
        ("payout failed", 10),
        ("sent", 40),
        ("send failed", 3),
        ("settled", 25),
        ("refunded", 6),
        ("refund read ignored", 1),
        ("refund undone", 1),
        ("late gift", 1),
    ] {
        assert!(totals.get(what).copied().unwrap_or(0) >= at_least, "{what}: {:?}", totals);
    }
}

// ------------------------------------------------------------------ v3: the refund read and its limit

/// Documented limit (docs/SECURITY.md, "What is still a balance read: refunds"). A
/// `ft_transfer_call` to the fund whose `ft_on_transfer` never completes (starved of gas) sits in
/// `ft_balance_of(fund)` until the token takes it back, and leaves no trace in the fund. A refund
/// check that reads the balance in that gap counts a refund that is not there. This test pins down
/// how far that goes: one trade with no output for an hour, exactly `amount_in - refund_fee`, once,
/// never after 14 days, and taken back if the output arrives within a day of the deadline.
#[test]
fn v3_limit_a_gas_starved_bounce_can_fake_one_capped_refund() {
    let bounce = 5 * REFUND; // however much the attacker parks in the balance
    // Not before the trade has been out for an hour.
    let mut f = sent_fund();
    set(ANYONE, REFUND_AT - 1);
    assert!(panics(|| f.settle_refund(0)).contains("an hour after the trade was sent"));
    assert_eq!(refund_now(&mut f, 0, 90_000_000 + bounce, REFUND_AT - 1), TradeStatus::Sent);
    assert_eq!(held(&f, 0), 90_000_000);
    // After the hour: the read sees the bounce, nothing in the fund moved, and it is believed.
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + bounce, REFUND_AT + 1), TradeStatus::Refunded);
    // Capped: exactly amount_in - refund_fee, whatever the balance showed.
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    assert_eq!(trade(&f, 0).received_refund.0, REFUND);
    // Once: neither a new request nor another callback adds anything for this trade.
    set(ANYONE, REFUND_AT + 2);
    assert!(panics(|| f.settle_refund(0)).contains("not waiting for a refund"));
    assert_eq!(refund_now(&mut f, 0, 90_000_000 + REFUND + bounce, REFUND_AT + 2), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    // Only that one trade: there is no other trade to fake a refund for.
    assert_eq!(f.get_fund().trades, 1);
    // Undone when the real output arrives within the window.
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", REFUND_AT + 100), 0);
    assert_eq!((trade(&f, 0).status, trade(&f, 0).received_refund.0), (TradeStatus::Settled, 0));
    assert_eq!((held(&f, 0), held(&f, 1)), (90_000_000, MIN_OUT));
    // A bounce one unit short of the refund fakes nothing.
    let mut g = sent_fund();
    let flux = request_refund(&mut g, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut g, 0, flux, 90_000_000 + REFUND - 1, REFUND_AT + 1), TradeStatus::Sent);
    assert_eq!(held(&g, 0), 90_000_000);
    // Not after 14 days past the deposit deadline.
    let close = Q::default().deadline + REFUND_CLOSES_SECONDS;
    set(ANYONE, close + 1);
    assert!(panics(|| g.settle_refund(0)).contains("too late"));
    assert_eq!(refund_now(&mut g, 0, 90_000_000 + bounce, close + 1), TradeStatus::Sent);
    assert_eq!(held(&g, 0), 90_000_000);
}

#[test]
fn v3_a_bounce_that_reaches_ft_on_transfer_discards_the_refund_read() {
    // Every way the fund hands a transfer back. Each one sat in a token balance for a moment.
    let bounces: [(&str, &str, u128, &str); 6] = [
        (USDC, "", REFUND, "subscription after the window"),
        (USDC, "anything else", REFUND, "unknown instruction"),
        (USDC, "basket", REFUND, "basket without open_basket"),
        (USDC, "donate", 0, "zero amount"),
        (USDC, "trade:0", u128::MAX, "would overflow"),
        (WNEAR, "", REFUND, "another fund token without instruction"),
    ];
    for (token, msg, amount, what) in bounces {
        let mut f = sent_fund();
        let stale = request_refund(&mut f, 0, REFUND_AT);
        assert_eq!(push(&mut f, token, "mallory.test.near", amount, msg, REFUND_AT), amount, "{what}: returned in full");
        assert_ne!(f.flux, stale, "{what}");
        // The read ran while the bounced tokens were still in the balance: thrown away.
        assert_eq!(refund_cb(&mut f, 0, stale, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Sent, "{what}");
        assert!(get_logs().iter().any(|l| l.contains("tokens moved while the balance was read")), "{what}");
        let v = f.get_fund();
        assert_eq!((v.held[0].1 .0, v.held[1].1 .0, v.pending.as_ref().map(|t| t.id)), (90_000_000, 0, Some(0)), "{what}");
        assert_eq!(trade(&f, 0).received_refund.0, 0, "{what}");
        // A read after the bounce resolved sees the honest balance: no refund...
        let flux = request_refund(&mut f, 0, REFUND_AT + 5);
        assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000, REFUND_AT + 6), TradeStatus::Sent, "{what}");
        // ...and a real one is still counted.
        assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 6), TradeStatus::Refunded, "{what}");
    }
    // A token outside the mandate cannot be the token sold, and does not disturb a read.
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(push(&mut f, OTHER, "mallory.test.near", REFUND, "", REFUND_AT), REFUND);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
}

#[test]
fn v3_refunds_close_14_days_after_the_deposit_deadline() {
    let close = Q::default().deadline + REFUND_CLOSES_SECONDS;
    // At the limit a refund is still counted.
    let mut f = sent_fund();
    let flux = request_refund(&mut f, 0, close);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, close), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    // One second later it is not: neither a new request...
    let mut g = sent_fund();
    set(ANYONE, close + 1);
    assert!(panics(|| g.settle_refund(0)).contains("too late: refunds are counted for 14 days"));
    assert_eq!(refund_now(&mut g, 0, 90_000_000 + REFUND, close + 1), TradeStatus::Sent);
    // ...nor the callback of a read that was requested in time.
    let mut h = sent_fund();
    let flux = request_refund(&mut h, 0, close);
    assert_eq!(refund_cb(&mut h, 0, flux, 90_000_000 + REFUND, close + 1), TradeStatus::Sent);
    assert_eq!((held(&g, 0), held(&h, 0)), (90_000_000, 90_000_000));
    assert_eq!(trade(&h, 0).received_refund.0, 0);
    // The trade is not stuck: it can be written off, and real output still settles it.
    set(ANYONE, close + 2);
    g.abandon();
    assert!(g.get_fund().pending.is_none());
    assert!(panics(|| g.settle_refund(0)).contains("too late"));
    assert_eq!(push(&mut g, WNEAR, SOLVER, MIN_OUT, "trade:0", close + 3), 0);
    assert_eq!(trade(&g, 0).status, TradeStatus::Settled);
    // An abandoned trade (a week after the deadline) keeps the same closing time.
    let (mut a, at) = abandoned_fund();
    assert!(at < close);
    let flux = request_refund(&mut a, 0, close);
    assert_eq!(refund_cb(&mut a, 0, flux, 90_000_000 + REFUND, close + 1), TradeStatus::Abandoned);
    assert_eq!(refund_cb(&mut a, 0, flux, 90_000_000 + REFUND, close), TradeStatus::Refunded);
}

// ------------------------------------------------------------------ v3: regressions for fixed findings

/// Was BUG 2: `settle_refund(2^32 + id)` refunded trade `id` but left it pending for ever.
#[test]
fn v3_bug_settle_refund_with_a_wrapped_trade_id_must_not_leave_the_trade_pending() {
    for wrapped in [1u64 << 32, (1 << 32) + 1, u64::MAX, 1] {
        let mut f = sent_fund();
        set(ANYONE, REFUND_AT);
        assert!(panics(|| f.settle_refund(wrapped)).contains("no such trade"), "{wrapped}");
        // A forged callback id changes nothing either (and does not panic).
        refund_now(&mut f, wrapped, 90_000_000 + REFUND, REFUND_AT + 1);
        let v = f.get_fund();
        assert_eq!(v.pending.map(|t| (t.id, t.status)), Some((0, TradeStatus::Sent)), "{wrapped}");
        assert_eq!((held(&f, 0), trade(&f, 0).received_refund.0), (90_000_000, 0), "{wrapped}");
        // The real id still works and clears pending.
        let flux = request_refund(&mut f, 0, REFUND_AT + 2);
        assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 3), TradeStatus::Refunded);
        assert!(f.get_fund().pending.is_none());
    }
}

/// Was BUG 3: the stuck-stake snapshot included NEAR stranded earlier, so a second stuck stake's
/// returned NEAR went unnoticed.
#[test]
fn v3_bug_a_stuck_stake_is_recovered_even_with_near_stranded_from_before() {
    let three = 3 * 10u128.pow(24);
    let stranded_then_stuck = || {
        let mut f = staking_fund(0);
        with_balance(OPERATOR, CLOSE + 20, 20_000);
        assert!(f.stake_idle(U128(FIVE)));
        set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
        f.on_unwrapped(0);
        set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
        f.on_rewrapped(0, U128(FIVE));
        assert_eq!(f.get_fund().stranded_near.0, FIVE);
        // The account now holds 25 NEAR (20 + the 5 unwrapped). Stake B is sent.
        with_balance(OPERATOR, CLOSE + 720, 25_000);
        assert!(f.stake_idle(U128(three)));
        f
    };
    let later = CLOSE + 720 + 86_401;
    // B's near_withdraw succeeded (28 NEAR) but on_unwrapped never completed.
    let mut f = stranded_then_stuck();
    with_balance(ANYONE, later, 28_000);
    f.recover_stuck_stake();
    assert_eq!(f.get_fund().stranded_near.0, FIVE + three, "stake B's 3 NEAR came back and must be recoverable");
    // B's NEAR never came back (it was staked; on_staked died): only A's 5 stay stranded.
    let mut g = stranded_then_stuck();
    with_balance(ANYONE, later, 25_000);
    g.recover_stuck_stake();
    assert_eq!(g.get_fund().stranded_near.0, FIVE);
    // Someone re-wraps A's 5 NEAR while B is stuck (25 + 3 - 5 = 23 NEAR): B's are still found.
    let mut h = stranded_then_stuck();
    with_balance(ANYONE, CLOSE + 800, 28_000);
    h.rewrap_stranded();
    set_with_results(CLOSE + 801, vec![PromiseResult::Successful(vec![])]);
    h.on_rewrapped(u64::MAX, U128(FIVE));
    with_balance(ANYONE, later, 23_000);
    h.recover_stuck_stake();
    assert_eq!(h.get_fund().stranded_near.0, three);
    // The same, B's NEAR gone (20 NEAR left): nothing stranded.
    let mut k = stranded_then_stuck();
    with_balance(ANYONE, CLOSE + 800, 25_000);
    k.rewrap_stranded();
    set_with_results(CLOSE + 801, vec![PromiseResult::Successful(vec![])]);
    k.on_rewrapped(u64::MAX, U128(FIVE));
    with_balance(ANYONE, later, 20_000);
    k.recover_stuck_stake();
    assert_eq!(k.get_fund().stranded_near.0, 0);
}

/// Was BUG 4: refusals stored while a stake was stuck grew storage past the recovery tolerance
/// and hid the stake's returned NEAR.
#[test]
fn v3_bug_refusals_stored_while_a_stake_is_stuck_must_not_hide_its_returned_near() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 20_000);
    let storage_at_stake = env::storage_usage();
    assert!(f.stake_idle(U128(FIVE)));
    let stored = f.get_fund().rejections;
    for k in 0..150 {
        with_balance(OPERATOR, CLOSE + 100 + k, 25_000);
        assert!(!f.stake_idle(U128(10u128.pow(24))));
    }
    assert_eq!(f.get_fund().rejections, stored + 150);
    // Unit tests keep collection writes in memory; flush them to learn what they cost on chain.
    with_balance(ANYONE, CLOSE + 1_000, 25_000);
    let before = env::storage_usage();
    f.rejections.flush();
    let grown = env::storage_usage() - before;
    assert!(grown as u128 * env::storage_byte_cost().as_yoctonear() > 50_000_000_000_000_000_000_000, "150 refusals cost more than the 0.05 NEAR tolerance");
    // A day later: the 5 NEAR are in the account (20 -> 25), and storage is `grown` bytes larger.
    let mut c = ctx(ANYONE, DAY_AFTER_STAKE);
    c.account_balance(NearToken::from_near(25)).storage_usage(storage_at_stake + grown);
    testing_env!(c.build());
    f.recover_stuck_stake();
    assert_eq!(f.get_fund().stranded_near.0, FIVE, "the stake's NEAR is in the account and must be recoverable");
}

// ------------------------------------------------------------------ v3: stranded NEAR and joins

/// Open-ended fund with a staking route: 100 USDC, 20 wNEAR, no stNEAR.
fn open_staking_fund() -> Plinth {
    let mut c = staking_config(0);
    c.mandate.open_ended = true;
    let mut f = fund_from(c);
    assert_eq!(subscribe(&mut f, ALICE, 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, BOB, 40_000_000, T0 + 20).0, 0);
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", WNEAR_20, "donate", T0 + 30), 0);
    f
}

/// ...whose 5 NEAR stake failed and could not be wrapped back: 15 wNEAR held, 5 NEAR stranded.
fn stranded_fund() -> Plinth {
    let mut f = open_staking_fund();
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    f.on_unwrapped(0);
    set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
    f.on_rewrapped(0, U128(FIVE));
    assert_eq!((f.get_fund().stranded_near.0, held(&f, 1)), (FIVE, 15 * 10u128.pow(24)));
    assert!(f.get_fund().pending.is_none());
    f
}

#[test]
fn v3_join_in_kind_waits_while_near_is_stranded() {
    let mut f = stranded_fund();
    let now = CLOSE + 100;
    assert_eq!(push(&mut f, USDC, "x.test.near", 1, "donate", now), 0); // any activity is fine
    open_basket(&mut f, CAROL, now);
    assert_eq!(push(&mut f, USDC, CAROL, 10_000_010, "basket", now), 0);
    assert_eq!(push(&mut f, WNEAR, CAROL, 2 * 10u128.pow(24), "basket", now), 0);
    set(CAROL, now + 1);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("NEAR from a failed stake is being wrapped back"));
    assert_eq!(f.get_shares(acct(CAROL)).0, 0);
    // Redeeming is not blocked by it.
    set(BOB, now + 2);
    f.redeem(U128(1_000_000));
    // Once the NEAR is wrapped back into holdings the join prices against all 20 wNEAR.
    with_balance(ANYONE, now + 3, 20_000);
    f.rewrap_stranded();
    set_with_results(now + 4, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(FIVE));
    let (h0, h1, total) = (held(&f, 0), held(&f, 1), f.get_fund().total_shares.0);
    let s = join(&mut f, CAROL, 0, now + 5);
    assert_eq!(s, mul_div(10_000_010, total, h0).unwrap().min(mul_div(2 * 10u128.pow(24), total, h1).unwrap()));
    // The same guard after a stuck stake whose NEAR came back.
    let mut g = open_staking_fund();
    with_balance(OPERATOR, CLOSE + 20, 20_000);
    assert!(g.stake_idle(U128(FIVE)));
    with_balance(ANYONE, DAY_AFTER_STAKE, 25_000);
    g.recover_stuck_stake();
    fill_basket(&mut g, CAROL, 10_000_000, 2 * 10u128.pow(24), DAY_AFTER_STAKE + 1);
    set(CAROL, DAY_AFTER_STAKE + 2);
    assert!(panics(|| g.join_in_kind(U128(0))).contains("NEAR from a failed stake"));
}

// ------------------------------------------------------------------ v3: regressions for pass-2 findings
//
// BUG 5-8 below were found in the second pass and are fixed in lib.rs; the tests assert the fixed
// behaviour. Their comments describe the bug as it was.

/// BUG 5 (medium). `rewrap_stranded` sets `stranded_near = 0` when it SENDS the NEAR to be
/// wrapped; `held[wNEAR]` grows only two blocks later in `on_rewrapped`. In between the fund's
/// wNEAR is understated, nothing is pending, and the `stranded_near == 0` guard in `join_in_kind`
/// passes. Anyone can call `rewrap_stranded` and `join_in_kind` back to back.
///
/// Scenario: 100 USDC + 15 wNEAR held, 5 NEAR stranded, 100 shares. Mallory fills a basket with
/// 100 USDC + 15 wNEAR, calls `rewrap_stranded`, then `join_in_kind` before `on_rewrapped` runs:
/// she gets 100 shares (half the fund). `on_rewrapped` then adds 5 wNEAR. Mallory redeems:
/// 100 USDC + 17.5 wNEAR. Expected: the join is refused until the re-wrap has resolved (or she
/// gets back at most what she put in). Actual: she takes 2.5 wNEAR from the existing holders.
#[test]
fn v3_bug_join_while_a_rewrap_is_in_flight_must_not_take_a_share_of_the_stranded_near() {
    let mut f = stranded_fund();
    let now = CLOSE + 100;
    let wnear_in = 15 * 10u128.pow(24);
    fill_basket(&mut f, "mallory.test.near", 100_000_000, wnear_in, now);
    with_balance(ANYONE, now + 1, 20_000);
    f.rewrap_stranded();
    set("mallory.test.near", now + 1);
    let joined = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.join_in_kind(U128(0)))).is_ok();
    set_with_results(now + 2, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(FIVE));
    if joined {
        let shares = f.get_shares(acct("mallory.test.near")).0;
        set("mallory.test.near", now + 3);
        f.redeem(U128(shares));
        let out = f.get_fund().in_flight_payouts[1].0;
        assert!(out <= wnear_in, "Mallory put in {wnear_in} wNEAR and took out {out}");
    }
}

/// BUG 6 (low/medium, same class). An abandoned trade can still be refunded for a week
/// (deadline + 7 d .. deadline + 14 d). If 1Click's refund lands in that week it sits in the
/// balance uncounted with nothing pending, so `join_in_kind` prices the fund without it; whoever
/// joins first and then calls `settle_refund` takes a share of the refund.
///
/// Scenario: 90 USDC held, trade 0 (10 USDC) abandoned, its 9.9955 USDC refund has arrived.
/// Mallory joins with 90 USDC (half the shares), then calls `settle_refund(0)`, then redeems:
/// 94.99775 USDC. Expected: at most the 90 she put in. Actual: +4.99775 USDC from the holders.
#[test]
fn v3_bug_join_before_an_abandoned_trades_refund_is_counted_must_not_take_a_share_of_it() {
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, BOB, 40_000_000, T0 + 20).0, 0);
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    let at = Q::default().deadline + ABANDON_AFTER_SECONDS + 1;
    set(ANYONE, at);
    f.abandon();
    // The refund (9.9955 USDC) is in the fund's balance. Mallory tries to join before it is counted.
    fill_basket(&mut f, "mallory.test.near", 90_000_000, 0, at + 1);
    set("mallory.test.near", at + 2);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("a written-off trade can still be refunded"));
    // Counting the refund first does not reopen joins early either; the holders keep all of it.
    let flux = request_refund(&mut f, 0, at + 3);
    assert_eq!(refund_cb(&mut f, 0, flux, 180_000_000 + REFUND, at + 4), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 90_000_000 + REFUND);
    set("mallory.test.near", at + 5);
    assert!(panics(|| f.join_in_kind(U128(0))).contains("a written-off trade can still be refunded"));
    // When refunds for that trade have closed she joins at the full price and gains nothing.
    let open = Q::default().deadline + REFUND_CLOSES_SECONDS + 1;
    let (h, total) = (held(&f, 0), f.get_fund().total_shares.0);
    let shares = join(&mut f, "mallory.test.near", 0, open);
    assert_eq!(shares, mul_div(90_000_000, total, h).unwrap());
    set("mallory.test.near", open + 1);
    f.redeem(U128(shares));
    let out = f.get_fund().in_flight_payouts[0].0;
    assert!(out <= 90_000_000, "Mallory put in 90000000 USDC and took out {out}");
}

/// BUG 7 (low; needs an extreme base token). `accrue_fee` computes
/// `bps * (self.total_shares + minted)` in plain u128 (the line that sets `used`). With a fee and
/// more than u128::MAX / bps shares (1.7e36 at 200 bps) it overflows and panics, and `accrue_fee`
/// runs first in `redeem`, `join_in_kind`, `propose_trade`, `stake_idle` and `accrue`.
///
/// Scenario: fee 200 bps, subscriptions of 2e36 base units (the mandate's cap allows it). One
/// second after the window closes every `redeem` panics, for ever. Expected: redeem pays out.
#[test]
fn v3_bug_fee_accrual_must_not_overflow_and_block_redemptions() {
    let mut c = config();
    c.mandate.management_fee_bps = 200;
    c.mandate.max_total_subscriptions = U128(u128::MAX / 4);
    let mut f = fund_from(c);
    let big = 2 * 10u128.pow(36);
    assert_eq!(subscribe(&mut f, ALICE, big, T0 + 10).0, 0);
    set(ALICE, CLOSE + 86_400);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.redeem(U128(big / 2))));
    assert!(r.is_ok(), "redeem panics inside accrue_fee: the depositors can never leave");
    assert!(f.get_fund().in_flight_payouts[0].0 > 0);
}

/// BUG 8 (theoretical: needs a callback more than a day late). The callbacks `on_trade_sent`,
/// `on_unwrapped`, `on_staked` and `on_rewrapped` do not check that the trade is still the one in
/// flight and still `Sending`. After `recover_stuck_trade` / `recover_stuck_stake` moved the trade
/// on, a late callback acts on it again.
///
/// Scenario: trade 0's send fails but `on_trade_sent` is delayed. A day later
/// `recover_stuck_trade` marks it Sent; the input is still in the balance, so `settle_refund`
/// counts it back (Refunded). Then the delayed `on_trade_sent(failure)` runs. Expected: ignored.
/// Actual: the input is restored a second time: 109.9955 USDC counted, 100 in the balance.
/// (The stake variant is worse: a late `on_staked`/`on_rewrapped` sets `pending = None` whatever
/// trade is in flight by then.)
#[test]
fn v3_bug_a_callback_arriving_after_recovery_must_not_be_applied_twice() {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    let day = CLOSE + 20 + 86_401;
    set(ANYONE, day);
    f.recover_stuck_trade();
    let flux = request_refund(&mut f, 0, day + 1);
    assert_eq!(refund_cb(&mut f, 0, flux, 100_000_000, day + 2), TradeStatus::Refunded);
    assert_eq!(held(&f, 0), 100_000_000 - 4_500);
    set_with_results(day + 3, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    assert!(held(&f, 0) <= 100_000_000, "the fund counts {} USDC and has 100000000", held(&f, 0));
}

// ------------------------------------------------------------------ v3: strategy (no manager)

const OUTLAYER: &str = "outlayer.test.near";

fn strategy(exclusive: bool) -> Strategy {
    Strategy {
        outlayer: acct(OUTLAYER),
        wasm_url: "https://example.org/strategy.wasm".into(),
        wasm_hash: "0123456789abcdef".repeat(4),
        max_instructions: 10_000_000_000,
        max_execution_seconds: 60,
        secrets_profile: None,
        secrets_owner: None,
        exclusive,
    }
}

/// The staking fund (100 USDC, 20 wNEAR, stNEAR route) with a strategy.
fn strategy_fund(exclusive: bool) -> Plinth {
    let mut c = staking_config(0);
    c.mandate.strategy = Some(strategy(exclusive));
    let mut f = fund_from(c);
    assert_eq!(subscribe(&mut f, ALICE, 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, BOB, 40_000_000, T0 + 20).0, 0);
    assert_eq!(push(&mut f, WNEAR, "donor.test.near", WNEAR_20, "donate", T0 + 30), 0);
    f
}

fn set_rebalance(now: u64, deposit: u128, tgas: u64) {
    let mut c = ctx(ANYONE, now);
    c.attached_deposit(NearToken::from_yoctonear(deposit)).prepaid_gas(Gas::from_tgas(tgas));
    testing_env!(c.build());
}

fn rebalance(f: &mut Plinth, now: u64) {
    set_rebalance(now, 10u128.pow(23), 300);
    f.rebalance();
}

/// OutLayer's answer reaches the fund: None = the run failed.
fn answer(f: &mut Plinth, result: Option<&[u8]>, now: u64) -> String {
    set_with_results(now, vec![result.map_or(PromiseResult::Failed, |b| PromiseResult::Successful(b.to_vec()))]);
    f.on_strategy()
}

fn trade_answer(q: &Q, next_id: u64) -> Vec<u8> {
    json!({"action": "trade", "quote": quote_json(q, next_id)}).to_string().into_bytes()
}

#[test]
fn v3_strategy_rebalance_preconditions() {
    // No strategy in the mandate.
    let mut plain = funded();
    set_rebalance(CLOSE + 20, 10u128.pow(23), 300);
    assert!(panics(|| plain.rebalance()).contains("this fund has no strategy"));
    assert_eq!(plain.get_fund().strategy_started, 0);

    let mut f = strategy_fund(false);
    for too_little in [0, 1, BASKET_DEPOSIT - 1] {
        set_rebalance(CLOSE + 20, too_little, 300);
        assert!(panics(|| f.rebalance()).contains("attach at least 0.005 NEAR for the strategy run"), "{too_little}");
    }
    assert_eq!(f.get_fund().strategy_started, 0);
    set_rebalance(CLOSE + 20, 10u128.pow(23), 294);
    assert!(panics(|| f.rebalance()).contains("attach 300 TGas"));
    // The window is still open.
    set_rebalance(CLOSE - 1, 10u128.pow(23), 300);
    assert!(panics(|| f.rebalance()).contains("trading starts when the subscription window closes"));
    assert_eq!(f.get_fund().strategy_started, 0, "a refused call starts nothing");
    // 295 TGas is enough.
    // Exactly 0.005 NEAR and 295 TGas are enough.
    set_rebalance(CLOSE + 20, BASKET_DEPOSIT, 295);
    f.rebalance();
    assert_eq!(f.get_fund().strategy_started, CLOSE + 20);
    assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == OUTLAYER), "request_execution on OutLayer");
    assert!(get_logs().iter().any(|l| l.contains("\"strategy_requested\"")));
    // Nothing of the fund's moved.
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0, v.trades), (100_000_000, WNEAR_20, 0));
}

#[test]
fn v3_strategy_one_run_at_a_time_until_it_answers_or_times_out() {
    let mut f = strategy_fund(false);
    rebalance(&mut f, CLOSE + 20);
    set_rebalance(CLOSE + 21, 10u128.pow(23), 300);
    assert!(panics(|| f.rebalance()).contains("a strategy run is in flight"));
    set_rebalance(CLOSE + 20 + 600, 10u128.pow(23), 300);
    assert!(panics(|| f.rebalance()).contains("a strategy run is in flight"));
    // A run that never answered stops blocking after 600 s.
    rebalance(&mut f, CLOSE + 20 + 601);
    assert_eq!(f.get_fund().strategy_started, CLOSE + 20 + 601);
    // Once it answers, the next can start at once.
    assert_eq!(answer(&mut f, Some(b"null"), CLOSE + 20 + 602), "hold");
    assert_eq!(f.get_fund().strategy_started, 0);
    rebalance(&mut f, CLOSE + 20 + 603);
}

#[test]
fn v3_strategy_rebalance_obeys_trade_timing() {
    let mut f = strategy_fund(false);
    // A trade in flight.
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    set_rebalance(CLOSE + 21, 10u128.pow(23), 300);
    assert!(panics(|| f.rebalance()).contains("a trade is already in flight"));
    ok_sent(&mut f, 0, CLOSE + 22);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 23), 0);
    // Cooldown.
    set_rebalance(CLOSE + 20 + 659, 10u128.pow(23), 300);
    assert!(panics(|| f.rebalance()).contains("too soon after the last trade"));
    assert_eq!(f.get_fund().strategy_started, 0);
    rebalance(&mut f, CLOSE + 20 + 660);
    // Daily cap (3 a day in this mandate): two more trades through the strategy, then refused.
    let mut now = CLOSE + 20 + 660;
    for id in 1..3u64 {
        let q = Q { deposit: format!("{:064x}", id), issued: now, deadline: now + 86_400, ..Default::default() };
        assert_eq!(answer(&mut f, Some(&trade_answer(&q, id)), now + 1), "trade");
        ok_sent(&mut f, id, now + 2);
        assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, &format!("trade:{id}"), now + 3), 0);
        now += 700;
    }
    if (CLOSE + 20) / 86_400 == now / 86_400 {
        set_rebalance(now, 10u128.pow(23), 300);
        assert!(panics(|| f.rebalance()).contains("used up"));
    }
}

#[test]
fn v3_strategy_a_valid_quote_is_sent_like_an_operators() {
    let mut f = strategy_fund(true);
    rebalance(&mut f, CLOSE + 20);
    assert_eq!(answer(&mut f, Some(&trade_answer(&Q::default(), 0)), CLOSE + 25), "trade");
    let v = f.get_fund();
    let t = v.pending.unwrap();
    assert_eq!((t.id, t.status, t.amount_in.0, t.min_out.0, t.sent_at), (0, TradeStatus::Sending, AMOUNT_IN, MIN_OUT, CLOSE + 25));
    assert_eq!(v.held[0].1 .0, 90_000_000);
    assert_eq!((v.strategy_started, v.rejections, v.last_trade_at), (0, 0, CLOSE + 25));
    assert!(get_logs().iter().any(|l| l.contains("\"trade_sent\"")));
    // It settles by push like any trade.
    ok_sent(&mut f, 0, CLOSE + 26);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", CLOSE + 60), 0);
    assert_eq!(trade(&f, 0).status, TradeStatus::Settled);
}

#[test]
fn v3_strategy_hostile_answers_are_refused_and_recorded_and_nothing_moves() {
    let tampered = String::from_utf8(trade_answer(&Q::default(), 0)).unwrap().replace(&"a".repeat(64), &"b".repeat(64)).into_bytes();
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (trade_answer(&Q { amount: 30_000_000, ..Default::default() }, 0), "over 2500 bps"),
        (trade_answer(&Q { out_usd: "9.800000", ..Default::default() }, 0), "all-in cost"),
        (trade_answer(&Q { recipient: "thief.test.near".into(), ..Default::default() }, 0), "deliver to and refund to this fund"),
        (trade_answer(&Q { refund_to: "thief.test.near".into(), ..Default::default() }, 0), "deliver to and refund to this fund"),
        (trade_answer(&Q { buy: OTHER, ..Default::default() }, 0), "not allowed by the mandate"),
        (trade_answer(&Q { msg: Some(String::new()), ..Default::default() }, 0), "quote must set customRecipientMsg to \"trade:0\""),
        (trade_answer(&Q { msg: Some("trade:1".into()), ..Default::default() }, 0), "quote must set customRecipientMsg to \"trade:0\""),
        (trade_answer(&Q { memo: true, ..Default::default() }, 0), "depositMemo"),
        (trade_answer(&Q { issued: CLOSE - 200, ..Default::default() }, 0), "s old"),
        (tampered, "does not verify"),
        (br#"{"action":"trade","quote":"{}"}"#.to_vec(), "quote missing quoteRequest"),
        (br#"{"action":"trade","quote":"not json"}"#.to_vec(), "not valid JSON"),
        (br#"{"action":"trade"}"#.to_vec(), "the strategy's trade has no quote"),
        (br#"{"action":"trade","quote":{"quote":{}}}"#.to_vec(), "the strategy's trade has no quote"),
        (br#"{"action":"trade","quote":null}"#.to_vec(), "the strategy's trade has no quote"),
        (br#"{"action":"stake"}"#.to_vec(), "the strategy's stake has no amount"),
        (br#"{"action":"stake","amount":5000000000000000000000000}"#.to_vec(), "the strategy's stake has no amount"),
        (br#"{"action":"stake","amount":"-1"}"#.to_vec(), "the strategy's stake has no amount"),
        (br#"{"action":"stake","amount":"340282366920938463463374607431768211456"}"#.to_vec(), "the strategy's stake has no amount"),
        (br#"{"action":"stake","amount":"6000000000000000000000000"}"#.to_vec(), "over 2500 bps"),
        (br#"{"action":"stake","amount":"1"}"#.to_vec(), "below the minimum"),
        (br#"{"action":"stake","amount":"0"}"#.to_vec(), "below the minimum"),
    ];
    for (bytes, why) in cases {
        let mut f = strategy_fund(true);
        rebalance(&mut f, CLOSE + 20);
        let flux = f.flux;
        assert_eq!(answer(&mut f, Some(&bytes), CLOSE + 25), "refused", "{why}");
        assert!(last_reason(&f).contains(why), "expected '{why}', got '{}'", last_reason(&f));
        let v = f.get_fund();
        assert!(v.pending.is_none(), "{why}");
        assert_eq!((v.held[0].1 .0, v.held[1].1 .0, v.held[2].1 .0), (100_000_000, WNEAR_20, 0), "{why}");
        assert_eq!((v.trades, v.rejections, v.strategy_started, v.last_trade_at, v.trades_today), (0, 1, 0, 0, 0), "{why}");
        assert_eq!((f.flux, f.near_in_flight), (flux, 0), "{why}");
        assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "{why}: no promise is created");
    }
}

#[test]
fn v3_strategy_stake_goes_through_the_staking_checks() {
    let mut f = strategy_fund(true);
    rebalance(&mut f, CLOSE + 20);
    assert_eq!(answer(&mut f, Some(format!("{{\"action\":\"stake\",\"amount\":\"{FIVE}\"}}").as_bytes()), CLOSE + 25), "stake");
    let v = f.get_fund();
    let t = v.pending.unwrap();
    assert_eq!((t.id, t.stake, t.status, t.amount_in.0), (0, true, TradeStatus::Sending, FIVE));
    assert_eq!((v.held[1].1 .0, v.strategy_started, f.near_in_flight), (15 * 10u128.pow(24), 0, FIVE));
    unwrapped(&mut f, 0, CLOSE + 26);
    staked(&mut f, 0, Some(format!("\"{}\"", expected_mint()).as_bytes()), CLOSE + 27);
    assert_eq!(held(&f, 2), expected_mint());
    assert_eq!(trade(&f, 0).status, TradeStatus::Settled);
    // A strategy that asks for a stake in a fund with no staking route is refused, not a panic.
    let mut c = config();
    c.mandate.strategy = Some(strategy(true));
    let mut g = fund_from(c);
    assert_eq!(subscribe(&mut g, ALICE, 100_000_000, T0 + 10).0, 0);
    rebalance(&mut g, CLOSE + 20);
    assert_eq!(answer(&mut g, Some(format!("{{\"action\":\"stake\",\"amount\":\"{FIVE}\"}}").as_bytes()), CLOSE + 25), "refused");
    assert!(last_reason(&g).contains("no staking route"));
    assert!(g.get_fund().pending.is_none());
}

#[test]
fn v3_strategy_no_answer_or_anything_else_is_a_hold() {
    let big = format!("{{\"action\":\"hold\",\"reason\":\"{}\"}}", "x".repeat(17_000));
    let answers: Vec<Option<&[u8]>> = vec![
        None, // the run failed
        Some(b"null"),
        Some(b""),
        Some(b"garbage"),
        Some(b"\"trade\""),
        Some(b"[]"),
        Some(b"[{\"action\":\"stake\",\"amount\":\"5000000000000000000000000\"}]"),
        Some(b"42"),
        Some(b"true"),
        Some(b"{}"),
        Some(b"{\"action\":\"hold\",\"reason\":\"nothing to do\"}"),
        Some(b"{\"action\":\"TRADE\",\"quote\":\"x\"}"),
        Some(b"{\"action\":null}"),
        Some(b"{\"action\":1}"),
        Some(b"{\"action\":[\"trade\"]}"),
        Some(b"{\"quote\":\"x\",\"amount\":\"5000000000000000000000000\"}"),
        Some(big.as_bytes()), // over the 16 KiB the fund reads
    ];
    for a in answers {
        let shown = a.map(|b| String::from_utf8_lossy(&b[..b.len().min(60)]).to_string());
        let mut f = strategy_fund(true);
        rebalance(&mut f, CLOSE + 20);
        assert_eq!(f.get_fund().strategy_started, CLOSE + 20);
        let flux = f.flux;
        assert_eq!(answer(&mut f, a, CLOSE + 25), "hold", "{shown:?}");
        assert!(get_logs().iter().any(|l| l.contains("\"strategy_hold\"")), "{shown:?}");
        let v = f.get_fund();
        assert!(v.pending.is_none(), "{shown:?}");
        assert_eq!((v.strategy_started, v.rejections, v.trades, v.last_trade_at), (0, 0, 0, 0), "{shown:?}");
        assert_eq!((v.held[0].1 .0, v.held[1].1 .0, f.flux), (100_000_000, WNEAR_20, flux), "{shown:?}");
        // A hold does not start the cooldown: the next run can be asked for at once.
        rebalance(&mut f, CLOSE + 26);
    }
}

#[test]
fn v3_strategy_long_hold_reasons_are_cut_in_the_log() {
    let mut f = strategy_fund(true);
    rebalance(&mut f, CLOSE + 20);
    let a = format!("{{\"action\":\"hold\",\"reason\":\"{}\"}}", "y".repeat(5_000));
    assert_eq!(answer(&mut f, Some(a.as_bytes()), CLOSE + 25), "hold");
    let log = get_logs().into_iter().find(|l| l.contains("\"strategy_hold\"")).unwrap();
    assert!(log.contains(&"y".repeat(200)) && !log.contains(&"y".repeat(201)));
}

#[test]
fn v3_strategy_exclusive_blocks_the_operator() {
    let mut f = strategy_fund(true);
    set(OPERATOR, CLOSE + 20);
    assert!(panics(|| f.propose_trade(quote_json(&Q::default(), 0))).contains("only its strategy proposes"));
    assert!(panics(|| f.stake_idle(U128(FIVE))).contains("only its strategy proposes"));
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.trades, v.rejections, v.held[0].1 .0, v.held[1].1 .0), (0, 0, 100_000_000, WNEAR_20));
    // Others are still told they are not the operator.
    set(ALICE, CLOSE + 20);
    assert!(panics(|| f.propose_trade(quote_json(&Q::default(), 0))).contains("only the operator"));
    assert!(panics(|| f.stake_idle(U128(FIVE))).contains("only the operator"));
    // Not exclusive: the operator and the strategy can both propose.
    let mut g = strategy_fund(false);
    assert!(stake(&mut g, FIVE, CLOSE + 20));
    let mut h = strategy_fund(false);
    assert!(propose(&mut h, &Q::default(), CLOSE + 20));
}

#[test]
fn v3_strategy_answer_is_checked_against_the_fund_as_it_is_when_it_arrives() {
    // Not exclusive: the operator sends a trade while the strategy run is in the air.
    let mut f = strategy_fund(false);
    rebalance(&mut f, CLOSE + 20);
    assert!(propose(&mut f, &Q::default(), CLOSE + 22));
    let q = Q { deposit: "c".repeat(64), msg: Some("trade:1".into()), ..Default::default() };
    assert_eq!(answer(&mut f, Some(&trade_answer(&q, 1)), CLOSE + 25), "refused");
    assert!(get_logs().iter().any(|l| l.contains("a trade is already in flight")));
    assert_eq!(f.get_fund().pending.unwrap().id, 0);
    assert_eq!((held(&f, 0), f.get_fund().trades), (90_000_000, 1));
    // A quote the strategy got for trade 0 is useless once the id moved on.
    let mut g = strategy_fund(false);
    rebalance(&mut g, CLOSE + 20);
    assert!(propose(&mut g, &Q::default(), CLOSE + 22));
    set_with_results(CLOSE + 23, vec![PromiseResult::Failed]);
    g.on_trade_sent(0);
    let later = CLOSE + 22 + 660;
    let q = Q { deposit: "c".repeat(64), msg: Some("trade:0".into()), issued: later, deadline: later + 86_400, ..Default::default() };
    assert_eq!(answer(&mut g, Some(&trade_answer(&q, 0)), later + 1), "refused");
    assert_eq!(last_reason(&g), "quote must set customRecipientMsg to \"trade:1\"");
}

#[test]
fn v3_strategy_settings_are_checked_at_launch() {
    let bad: Vec<(Box<dyn Fn(&mut Strategy)>, &str)> = vec![
        (Box::new(|s| s.wasm_url = "http://example.org/s.wasm".into()), "wasm_url must be https"),
        (Box::new(|s| s.wasm_url = format!("https://{}", "a".repeat(510))), "wasm_url must be https"),
        (Box::new(|s| s.wasm_hash = "0123456789ABCDEF".repeat(4)), "64 lowercase hex"),
        (Box::new(|s| s.wasm_hash = "0123456789abcdef".repeat(3)), "64 lowercase hex"),
        (Box::new(|s| s.wasm_hash = "g".repeat(64)), "64 lowercase hex"),
        (Box::new(|s| s.max_instructions = 0), "bad strategy limits"),
        (Box::new(|s| s.max_execution_seconds = 0), "bad strategy limits"),
        (Box::new(|s| s.max_execution_seconds = 121), "bad strategy limits"),
        (Box::new(|s| s.secrets_profile = Some("p".into())), "both a profile and an owner"),
        (Box::new(|s| s.secrets_owner = Some(acct(ALICE))), "both a profile and an owner"),
        (Box::new(|s| s.outlayer = acct(FUND)), "bad strategy account"),
    ];
    for (edit, why) in bad {
        let mut c = config();
        let mut s = strategy(false);
        edit(&mut s);
        c.mandate.strategy = Some(s);
        set("deployer.test.near", T0);
        assert!(panics(|| Plinth::new(c)).contains(why), "{why}");
    }
    // Accepted, with secrets; and absent from JSON it defaults to none.
    let mut c = config();
    let mut s = strategy(true);
    s.secrets_profile = Some("default".into());
    s.secrets_owner = Some(acct(ALICE));
    c.mandate.strategy = Some(s);
    let mut f = fund_from(c.clone());
    assert_eq!(f.get_fund().config, c);
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    rebalance(&mut f, CLOSE + 20);
    let mut j = serde_json::to_value(config()).unwrap();
    j["mandate"].as_object_mut().unwrap().remove("strategy");
    assert_eq!(serde_json::from_value::<Config>(j).unwrap().mandate.strategy, None);
}

// ------------------------------------------------------------------ v3: round-3 changes

#[test]
fn v3_a_quote_whose_deposit_address_stays_open_over_14_days_is_refused() {
    let now = CLOSE + 20;
    let mut f = funded();
    assert!(!propose(&mut f, &Q { deadline: now + MAX_DEADLINE_SECONDS + 1, ..Default::default() }, now));
    assert_eq!(last_reason(&f), "the quote's deposit address stays open too long");
    assert_eq!(f.get_rejections(0, 1)[0].deposit_address, Some("a".repeat(64)));
    assert!(f.get_fund().pending.is_none());
    assert_eq!(held(&f, 0), 100_000_000);
    // A far-future deadline (what made a lost trade impossible to write off) is refused as well.
    assert!(!propose(&mut f, &Q { deadline: now + 1_000 * 365 * 86_400, ..Default::default() }, now));
    assert_eq!(last_reason(&f), "the quote's deposit address stays open too long");
    // Exactly 14 days ahead is accepted, and such a trade can be written off 7 days after that.
    assert!(propose(&mut f, &Q { deadline: now + MAX_DEADLINE_SECONDS, ..Default::default() }, now));
    ok_sent(&mut f, 0, now + 1);
    set(ANYONE, now + MAX_DEADLINE_SECONDS + ABANDON_AFTER_SECONDS + 1);
    f.abandon();
    assert_eq!(f.get_fund().joins_blocked_until, now + MAX_DEADLINE_SECONDS + REFUND_CLOSES_SECONDS);
}

#[test]
fn v3_joins_are_blocked_after_an_abandon_until_refunds_for_it_close() {
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    assert_eq!(f.get_fund().joins_blocked_until, 0);
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    assert_eq!(f.get_fund().joins_blocked_until, 0, "only a write-off blocks joins");
    let at = Q::default().deadline + ABANDON_AFTER_SECONDS + 1;
    set(ANYONE, at);
    f.abandon();
    let until = Q::default().deadline + REFUND_CLOSES_SECONDS;
    assert_eq!(f.get_fund().joins_blocked_until, until);
    fill_basket(&mut f, CAROL, 9_000_000, 0, at + 1);
    for now in [at + 2, until - 1, until] {
        set(CAROL, now);
        assert!(panics(|| f.join_in_kind(U128(0))).contains("a written-off trade can still be refunded; joins reopen when that closes"), "{now}");
    }
    // Everything else goes on: redeem, baskets in and out, the next trade.
    set(ALICE, at + 3);
    f.redeem(U128(1_000_000));
    let q = Q { deposit: "c".repeat(64), amount: 1_000_000, in_usd: "1.000000", out_usd: "0.999000", issued: at, deadline: at + 86_400, ..Default::default() };
    assert!(propose(&mut f, &q, at + 4));
    ok_sent(&mut f, 1, at + 5);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:1", at + 6), 0);
    // A later trade settling normally does not move the block either way.
    assert_eq!(f.get_fund().joins_blocked_until, until);
    // One second after refunds close, joins reopen (with every token now held).
    assert_eq!(push(&mut f, WNEAR, CAROL, MIN_OUT, "basket", until), 0);
    let s = join(&mut f, CAROL, 0, until + 1);
    assert!(s > 0);
    assert_eq!(f.get_shares(acct(CAROL)).0, s);
}

#[test]
fn v3_joins_are_not_blocked_in_funds_without_a_written_off_trade() {
    // Settled, refunded and failed trades do not block joins.
    let mut f = open_fund();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    let flux = request_refund(&mut f, 0, REFUND_AT);
    assert_eq!(refund_cb(&mut f, 0, flux, 90_000_000 + REFUND, REFUND_AT + 1), TradeStatus::Refunded);
    let now = REFUND_AT + 700;
    let q = |dep: &str, at: u64| Q { deposit: dep.repeat(64), issued: at - 5, deadline: at + 86_400, ..Default::default() };
    assert!(propose(&mut f, &q("c", now), now));
    set_with_results(now + 1, vec![PromiseResult::Failed]);
    f.on_trade_sent(1);
    assert!(propose(&mut f, &q("d", now + 700), now + 700));
    ok_sent(&mut f, 2, now + 701);
    assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:2", now + 702), 0);
    assert_eq!(f.get_fund().joins_blocked_until, 0);
    fill_basket(&mut f, CAROL, 10_000_000, WNEAR_20, now + 703);
    assert!(join(&mut f, CAROL, 0, now + 704) > 0);
}

#[test]
fn v3_a_second_abandon_never_shortens_the_join_block() {
    let mut f = fund_from(open_config());
    assert_eq!(subscribe(&mut f, ALICE, 100_000_000, T0 + 10).0, 0);
    // Trade 0 has a long deadline (14 days), trade 1 a short one that is written off later.
    let first = CLOSE + 20;
    assert!(propose(&mut f, &Q { deadline: first + MAX_DEADLINE_SECONDS, ..Default::default() }, first));
    ok_sent(&mut f, 0, first + 1);
    set(ANYONE, first + MAX_DEADLINE_SECONDS + ABANDON_AFTER_SECONDS + 1);
    f.abandon();
    let until0 = first + MAX_DEADLINE_SECONDS + REFUND_CLOSES_SECONDS;
    assert_eq!(f.get_fund().joins_blocked_until, until0);
    let second = first + MAX_DEADLINE_SECONDS + ABANDON_AFTER_SECONDS + 10;
    let q = Q { deposit: "c".repeat(64), issued: second - 5, deadline: second + 700, ..Default::default() };
    assert!(propose(&mut f, &q, second));
    ok_sent(&mut f, 1, second + 1);
    set(ANYONE, second + 700 + ABANDON_AFTER_SECONDS + 1);
    f.abandon();
    let until1 = second + 700 + REFUND_CLOSES_SECONDS;
    assert!(until1 > until0);
    assert_eq!(f.get_fund().joins_blocked_until, until1, "the later of the two");
}

#[test]
fn v3_a_rewrap_is_tracked_from_dispatch_to_callback_on_every_path() {
    // on_staked failure -> rewrap -> on_rewrapped (ok).
    let mut f = staking_fund(0);
    assert!(stake(&mut f, FIVE, CLOSE + 20));
    assert_eq!(f.rewrap_started, 0);
    unwrapped(&mut f, 0, CLOSE + 21);
    staked(&mut f, 0, None, CLOSE + 22);
    assert_eq!((f.rewrap_started, f.near_in_flight), (CLOSE + 22, 0));
    assert_eq!(f.get_fund().pending.unwrap().status, TradeStatus::Sending, "the legitimate chain is not a late callback");
    set_with_results(CLOSE + 23, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(0, U128(FIVE));
    assert!(!get_logs().iter().any(|l| l.contains("late callback")));
    assert_eq!((f.rewrap_started, held(&f, 1), trade(&f, 0).status), (0, WNEAR_20, TradeStatus::Failed));
    assert!(f.get_fund().pending.is_none());
    // on_unwrapped without a price -> rewrap -> on_rewrapped (fails) -> stranded -> rewrap_stranded.
    let mut g = staking_fund(0);
    assert!(stake(&mut g, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    g.on_unwrapped(0);
    assert!(!get_logs().iter().any(|l| l.contains("late callback")));
    assert_eq!((g.rewrap_started, g.near_in_flight), (CLOSE + 21, 0));
    set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
    g.on_rewrapped(0, U128(FIVE));
    assert!(!get_logs().iter().any(|l| l.contains("late callback")));
    assert_eq!((g.rewrap_started, g.get_fund().stranded_near.0, trade(&g, 0).status), (0, FIVE, TradeStatus::Failed));
    with_balance(ANYONE, CLOSE + 30, 20_000);
    g.rewrap_stranded();
    assert_eq!((g.rewrap_started, g.get_fund().stranded_near.0), (CLOSE + 30, 0));
    // The retry fails: stranded again, nothing in flight.
    set_with_results(CLOSE + 31, vec![PromiseResult::Failed]);
    g.on_rewrapped(u64::MAX, U128(FIVE));
    assert_eq!((g.rewrap_started, g.get_fund().stranded_near.0, held(&g, 1)), (0, FIVE, 15 * 10u128.pow(24)));
    with_balance(ANYONE, CLOSE + 32, 20_000);
    g.rewrap_stranded();
    set_with_results(CLOSE + 33, vec![PromiseResult::Successful(vec![])]);
    g.on_rewrapped(u64::MAX, U128(FIVE));
    assert_eq!((g.rewrap_started, g.get_fund().stranded_near.0, held(&g, 1)), (0, 0, WNEAR_20));
    // A failed unwrap never starts a re-wrap.
    let mut h = staking_fund(0);
    assert!(stake(&mut h, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed, PromiseResult::Failed]);
    h.on_unwrapped(0);
    assert_eq!(h.rewrap_started, 0);
}

#[test]
fn v3_settle_refund_waits_while_near_is_being_wrapped_back() {
    // A written-off wNEAR -> USDC swap, then a stake that fails and strands its NEAR.
    let mut f = staking_fund(0);
    let q = Q { sell: WNEAR, buy: USDC, amount: FIVE, out: 10_000_000, min_out: 9_990_000, ..Default::default() };
    assert!(propose(&mut f, &q, CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    let at = q.deadline + ABANDON_AFTER_SECONDS + 1;
    set(ANYONE, at);
    f.abandon();
    let three = 3 * 10u128.pow(24);
    assert!(stake(&mut f, three, at + 1));
    set_with_results(at + 2, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    f.on_unwrapped(1);
    // The stake's own re-wrap is in flight (and the stake is still pending).
    set(ANYONE, at + 3);
    assert!(panics(|| f.settle_refund(0)).contains("another trade is being sent"));
    set_with_results(at + 4, vec![PromiseResult::Failed]);
    f.on_rewrapped(1, U128(three));
    assert_eq!((f.rewrap_started, f.get_fund().stranded_near.0), (0, three));
    assert!(f.get_fund().pending.is_none());
    // Stranded but nothing moving: the refund check may run.
    let stale = request_refund(&mut f, 0, at + 5);
    // Someone starts the retry: the wNEAR balance is about to grow by 3, which is not a refund.
    with_balance(ANYONE, at + 6, 20_000);
    f.rewrap_stranded();
    assert_eq!(f.rewrap_started, at + 6);
    set(ANYONE, at + 7);
    assert!(panics(|| f.settle_refund(0)).contains("another trade is being sent"));
    // 12 wNEAR held; the read saw 12 + 3 re-wrapped. Neither the stale nor a current flux counts it.
    let wrapped_balance = 12 * 10u128.pow(24) + three;
    assert_eq!(refund_cb(&mut f, 0, stale, wrapped_balance + FIVE, at + 7), TradeStatus::Abandoned);
    assert_eq!(refund_now(&mut f, 0, wrapped_balance + FIVE, at + 7), TradeStatus::Abandoned);
    assert_eq!(held(&f, 1), 12 * 10u128.pow(24));
    // The re-wrap lands: 15 wNEAR held, and the check works again against the honest balance.
    set_with_results(at + 8, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(three));
    assert_eq!((f.rewrap_started, held(&f, 1)), (0, 15 * 10u128.pow(24)));
    let flux = request_refund(&mut f, 0, at + 9);
    assert_eq!(refund_cb(&mut f, 0, flux, 15 * 10u128.pow(24), at + 10), TradeStatus::Abandoned, "no refund there");
    assert_eq!(refund_cb(&mut f, 0, flux, 15 * 10u128.pow(24) + FIVE - 4_500, at + 10), TradeStatus::Refunded);
}

/// Everything a late callback could disturb.
fn snapshot(f: &Plinth) -> (Vec<u128>, Option<u64>, Vec<Trade>, u128, u128, u64, u64, u128) {
    let v = f.get_fund();
    (v.held.iter().map(|h| h.1 .0).collect(), v.pending.map(|t| t.id), f.get_trades(0, u64::MAX), f.near_in_flight, v.stranded_near.0, f.rewrap_started, v.last_trade_at, v.total_shares.0)
}

#[test]
fn v3_late_swap_callbacks_are_ignored_after_recover_stuck_trade() {
    for late_ok in [true, false] {
        // Recovered, still Sent and pending.
        let mut f = funded();
        assert!(propose(&mut f, &Q::default(), CLOSE + 20));
        let day = CLOSE + 20 + 86_401;
        set(ANYONE, day);
        f.recover_stuck_trade();
        let before = snapshot(&f);
        set_with_results(day + 1, vec![if late_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
        f.on_trade_sent(0);
        assert!(get_logs().iter().any(|l| l.contains("late callback for trade 0 ignored")));
        assert_eq!(snapshot(&f), before, "late_ok {late_ok}");
        // Recovered, settled by output, and a NEWER trade is in flight.
        assert_eq!(push(&mut f, WNEAR, SOLVER, MIN_OUT, "trade:0", day + 2), 0);
        let q = Q { deposit: "c".repeat(64), issued: day, deadline: day + 86_400, ..Default::default() };
        assert!(propose(&mut f, &q, day + 3));
        let before = snapshot(&f);
        assert_eq!(before.1, Some(1));
        set_with_results(day + 4, vec![if late_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
        f.on_trade_sent(0);
        assert_eq!(snapshot(&f), before, "late_ok {late_ok}: trade 1 is untouched");
        // Trade 1's own callback is not "late".
        ok_sent(&mut f, 1, day + 5);
        assert!(!get_logs().iter().any(|l| l.contains("late callback")));
        assert_eq!(trade(&f, 1).status, TradeStatus::Sent);
    }
}

#[test]
fn v3_a_duplicate_on_trade_sent_is_ignored() {
    let mut f = sent_fund();
    let before = snapshot(&f);
    set_with_results(CLOSE + 30, vec![PromiseResult::Failed]);
    f.on_trade_sent(0);
    assert_eq!(snapshot(&f), before, "a sent trade's input is not restored by a second callback");
    // Nor after it failed once.
    let mut g = funded();
    assert!(propose(&mut g, &Q::default(), CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed]);
    g.on_trade_sent(0);
    set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
    g.on_trade_sent(0);
    assert_eq!(held(&g, 0), 100_000_000);
}

/// A stake stuck and recovered after a day, then a newer trade in flight: a swap (trade 1) or
/// another stake (trade 1).
fn recovered_stake_then(newer_is_stake: bool, unwrapped_first: bool) -> (Plinth, u64) {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 20_000);
    assert!(f.stake_idle(U128(FIVE)));
    if unwrapped_first {
        unwrapped(&mut f, 0, CLOSE + 21); // quoted_out and min_out are set; on_staked never came
    }
    with_balance(ANYONE, DAY_AFTER_STAKE, 20_000);
    f.recover_stuck_stake();
    assert_eq!((trade(&f, 0).status, f.get_fund().stranded_near.0), (TradeStatus::Failed, 0));
    let now = DAY_AFTER_STAKE + 10;
    if newer_is_stake {
        assert!(stake(&mut f, 3 * 10u128.pow(24), now));
        assert_eq!(f.near_in_flight, 3 * 10u128.pow(24));
    } else {
        assert!(propose(&mut f, &Q { issued: now - 5, deadline: now + 86_400, ..Default::default() }, now));
    }
    assert_eq!(f.get_fund().pending.unwrap().id, 1);
    (f, now)
}

#[test]
fn v3_late_stake_callbacks_are_ignored_after_recover_stuck_stake() {
    let minted = format!("\"{}\"", expected_mint()).into_bytes();
    let price = format!("\"{PRICE}\"").into_bytes();
    // (name, the late callback for stake 0)
    let late: Vec<(&str, Box<dyn Fn(&mut Plinth, u64)>)> = vec![
        ("on_unwrapped, unwrap ok", Box::new({
            let price = price.clone();
            move |f, now| {
                set_with_results(now, vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(price.clone())]);
                f.on_unwrapped(0);
            }
        })),
        ("on_unwrapped, unwrap failed", Box::new(move |f, now| {
            set_with_results(now, vec![PromiseResult::Failed, PromiseResult::Successful(price.clone())]);
            f.on_unwrapped(0);
        })),
        ("on_unwrapped, no price", Box::new(|f, now| {
            set_with_results(now, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
            f.on_unwrapped(0);
        })),
        ("on_staked, success", Box::new(move |f, now| staked(f, 0, Some(&minted), now))),
        ("on_staked, failure", Box::new(|f, now| staked(f, 0, None, now))),
        ("on_rewrapped, ok", Box::new(|f, now| {
            set_with_results(now, vec![PromiseResult::Successful(vec![])]);
            f.on_rewrapped(0, U128(FIVE));
        })),
        ("on_rewrapped, failed", Box::new(|f, now| {
            set_with_results(now, vec![PromiseResult::Failed]);
            f.on_rewrapped(0, U128(FIVE));
        })),
    ];
    for (what, callback) in &late {
        for newer_is_stake in [false, true] {
            for unwrapped_first in [false, true] {
                let (mut f, now) = recovered_stake_then(newer_is_stake, unwrapped_first);
                let before = snapshot(&f);
                callback(&mut f, now + 1);
                let tag = format!("{what}, newer stake {newer_is_stake}, unwrapped {unwrapped_first}");
                assert!(get_logs().iter().any(|l| l.contains("late callback for trade 0 ignored")), "{tag}");
                assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "{tag}: a late callback sends nothing");
                assert_eq!(snapshot(&f), before, "{tag}: the newer trade, holdings and NEAR books are untouched");
                // The newer trade still completes normally afterwards.
                if newer_is_stake {
                    unwrapped(&mut f, 1, now + 2);
                    staked(&mut f, 1, Some(b"\"7\""), now + 3);
                    assert_eq!((trade(&f, 1).status, held(&f, 2), f.near_in_flight), (TradeStatus::Settled, 7, 0), "{tag}");
                } else {
                    ok_sent(&mut f, 1, now + 2);
                    assert_eq!(trade(&f, 1).status, TradeStatus::Sent, "{tag}");
                }
                assert_eq!(trade(&f, 0).status, TradeStatus::Failed, "{tag}");
            }
        }
        // With nothing newer in flight it is ignored just the same.
        let mut f = staking_fund(0);
        with_balance(OPERATOR, CLOSE + 20, 20_000);
        assert!(f.stake_idle(U128(FIVE)));
        with_balance(ANYONE, DAY_AFTER_STAKE, 20_000);
        f.recover_stuck_stake();
        let before = snapshot(&f);
        callback(&mut f, DAY_AFTER_STAKE + 1);
        assert_eq!(snapshot(&f), before, "{what}, nothing pending");
    }
}

#[test]
fn v3_fee_accrual_skips_instead_of_overflowing() {
    // Shares so many that total + minted cannot be represented: the accrual is skipped, the clock
    // moves on, and people can still leave.
    let mut c = config();
    c.mandate.management_fee_bps = 200;
    c.mandate.max_total_subscriptions = U128(u128::MAX);
    let mut f = fund_from(c);
    let huge = u128::MAX - 5;
    assert_eq!(subscribe(&mut f, ALICE, huge, T0 + 10).0, 0);
    set(ANYONE, CLOSE + YEAR_SECONDS as u64);
    f.accrue();
    let v = f.get_fund();
    assert_eq!((v.operator_shares.0, v.total_shares.0, v.fee_accrued_at), (0, huge, CLOSE + YEAR_SECONDS as u64));
    set(ALICE, CLOSE + YEAR_SECONDS as u64 + 1);
    f.redeem(U128(huge));
    assert_eq!(f.get_fund().in_flight_payouts[0].0, huge);
    // Large but representable (2e36, where bps * total overflows): the fee is still minted, about
    // 2% a year, and the operator's shares add up.
    let mut c = config();
    c.mandate.management_fee_bps = 200;
    c.mandate.max_total_subscriptions = U128(u128::MAX / 4);
    let mut g = fund_from(c);
    let big = 2 * 10u128.pow(36);
    assert_eq!(subscribe(&mut g, ALICE, big, T0 + 10).0, 0);
    set(ANYONE, CLOSE + YEAR_SECONDS as u64);
    g.accrue();
    let v = g.get_fund();
    assert_eq!(v.total_shares.0, big + v.operator_shares.0);
    let ppm = mul_div(v.operator_shares.0, 1_000_000, v.total_shares.0).unwrap();
    assert!((19_999..=20_000).contains(&ppm), "operator holds {ppm} ppm after a year at 2%");
    // A second accrual in the same second mints nothing more.
    g.accrue();
    assert_eq!(g.get_fund().operator_shares.0, v.operator_shares.0);
}

// ------------------------------------------------------------------ v3: a lost re-wrap callback

/// Was BUG 9: a re-wrap whose `on_rewrapped` never ran blocked `settle_refund` and `join_in_kind`
/// for good. Now a re-wrap counts as in flight for at most an hour (REWRAP_WAIT_SECONDS).
#[test]
fn v3_bug_a_lost_on_rewrapped_must_not_block_refunds_and_joins_for_ever() {
    let mut f = staking_fund(0);
    with_balance(OPERATOR, CLOSE + 20, 20_000);
    assert!(f.stake_idle(U128(FIVE)));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    f.on_unwrapped(0); // re-wrap dispatched; its callback is lost
    assert_eq!(f.rewrap_started, CLOSE + 21);
    with_balance(ANYONE, DAY_AFTER_STAKE, 20_000);
    f.recover_stuck_stake();
    assert!(f.get_fund().pending.is_none());
    // Trading goes on: a swap is sent and 1Click refunds it. The refund is counted.
    let now = DAY_AFTER_STAKE + 10;
    assert!(propose(&mut f, &Q { issued: now - 5, deadline: now + 86_400, ..Default::default() }, now));
    ok_sent(&mut f, 1, now + 1);
    let flux = request_refund(&mut f, 1, now + REFUND_WAIT_SECONDS);
    assert_eq!(refund_cb(&mut f, 1, flux, 90_000_000 + REFUND, now + REFUND_WAIT_SECONDS + 1), TradeStatus::Refunded);
}

#[test]
fn v3_a_lost_rewrap_retry_delays_refunds_and_joins_by_an_hour_at_most() {
    // Open-ended staking fund, 5 NEAR stranded, plus a written-off swap that can still be refunded
    // would need a week; a join is enough to watch the guard.
    let mut f = stranded_fund();
    let start = CLOSE + 100;
    fill_basket(&mut f, CAROL, 10_000_000, 2 * 10u128.pow(24), start);
    with_balance(ANYONE, start, 20_000);
    f.rewrap_stranded(); // its on_rewrapped never runs
    assert_eq!((f.rewrap_started, f.get_fund().stranded_near.0), (start, 0));
    for now in [start, start + 1, start + 3_600] {
        set(CAROL, now);
        assert!(panics(|| f.join_in_kind(U128(0))).contains("NEAR from a failed stake is being wrapped back"), "{now}");
    }
    // An hour and a second later the re-wrap is taken as lost and joins work again.
    assert!(join(&mut f, CAROL, 0, start + 3_601) > 0);
    // The same for the refund check, on a swap sent after the lost re-wrap started.
    let mut g = staking_fund(0);
    assert!(stake(&mut g, FIVE, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    g.on_unwrapped(0);
    set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
    g.on_rewrapped(0, U128(FIVE)); // stranded
    let now = CLOSE + 20 + 700;
    let q = Q { issued: now - 5, deadline: now + 86_400, ..Default::default() };
    // (20 NEAR in the account: the 5 stranded are not free NEAR.)
    with_balance(OPERATOR, now, 20_000);
    assert!(g.propose_trade(quote_json(&q, 1)));
    ok_sent(&mut g, 1, now + 1);
    let retry = now + REFUND_WAIT_SECONDS; // the swap may be checked from here on
    with_balance(ANYONE, retry, 20_000);
    g.rewrap_stranded(); // callback lost
    for t in [retry, retry + 3_600] {
        set(ANYONE, t);
        assert!(panics(|| g.settle_refund(1)).contains("another trade is being sent"), "{t}");
        assert_eq!(refund_now(&mut g, 1, 90_000_000 + REFUND, t), TradeStatus::Sent, "{t}");
    }
    let flux = request_refund(&mut g, 1, retry + 3_601);
    assert_eq!(refund_cb(&mut g, 1, flux, 90_000_000 + REFUND, retry + 3_602), TradeStatus::Refunded);
}

// ------------------------------------------------------------------ v3: suspected contract bugs (pass 4)

/// BUG 10 (low; narrow timing). There is ONE `rewrap_started` for two re-wraps that can be in
/// flight together: a stake's own (`rewrap`, lib.rs ~911) and a `rewrap_stranded` retry of NEAR
/// stranded earlier (lib.rs ~953). Whichever `on_rewrapped` lands first sets it to 0
/// (lib.rs ~925 / ~932) while the other near_deposit is still on its way, so `rewrap_in_flight()`
/// is false with wNEAR about to be added to holdings: the BUG 5 window again.
///
/// Scenario: 5 NEAR stranded from an earlier stake. A second stake (3 NEAR) fails and its re-wrap
/// is dispatched. Mallory calls `rewrap_stranded` right then. The stake's `on_rewrapped` lands
/// first: stake Failed, nothing pending, `rewrap_started = 0`, the retry's 5 wNEAR not yet
/// counted. Mallory joins with 100 USDC + 15 wNEAR (half the fund); the retry lands (+5 wNEAR);
/// she redeems 17.5 wNEAR. Expected: the join is refused until the retry has resolved.
#[test]
#[ignore = "contract bug: one rewrap_started for two overlapping re-wraps; the first callback clears the guard for the second"]
fn v3_bug_overlapping_rewraps_must_both_keep_joins_closed() {
    let mut f = stranded_fund(); // 100 USDC, 15 wNEAR, 5 NEAR stranded
    let three = 3 * 10u128.pow(24);
    let now = CLOSE + 20 + 700;
    with_balance(OPERATOR, now, 20_000); // the 5 stranded NEAR are not free NEAR
    assert!(f.stake_idle(U128(three)));
    set_with_results(now + 1, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    f.on_unwrapped(1); // no price: the stake's 3 NEAR are being wrapped back
    let wnear_in = 15 * 10u128.pow(24);
    fill_basket(&mut f, "mallory.test.near", 100_000_000, wnear_in, now + 1);
    with_balance("mallory.test.near", now + 2, 20_000);
    f.rewrap_stranded(); // the earlier 5 NEAR are being wrapped too
    set_with_results(now + 3, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(1, U128(three)); // the stake's lands first: 15 wNEAR held, nothing pending
    assert_eq!((held(&f, 1), f.get_fund().stranded_near.0), (wnear_in, 0));
    set("mallory.test.near", now + 3);
    let joined = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.join_in_kind(U128(0)))).is_ok();
    set_with_results(now + 4, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(FIVE));
    if joined {
        let shares = f.get_shares(acct("mallory.test.near")).0;
        set("mallory.test.near", now + 5);
        f.redeem(U128(shares));
        let out = f.get_fund().in_flight_payouts[1].0;
        assert!(out <= wnear_in, "Mallory put in {wnear_in} wNEAR and took out {out}");
    }
}
