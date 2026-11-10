//! Unit tests: every mandate rule, refusals recorded, subscribe, trade bookkeeping, settle,
//! refunds, abandon, and in-kind redemption. Quotes are signed with a test key using exactly the
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

fn fund() -> Plinth {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(config());
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
    custom_msg: bool,
    memo: bool,
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
            custom_msg: false,
            memo: false,
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

fn quote_json(q: &Q) -> String {
    let mut req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": format!("nep141:{}", q.sell), "depositType": "ORIGIN_CHAIN",
        "destinationAsset": format!("nep141:{}", q.buy), "amount": q.amount.to_string(),
        "refundTo": q.refund_to, "refundType": "ORIGIN_CHAIN", "recipient": q.recipient,
        "recipientType": "DESTINATION_CHAIN", "deadline": iso(q.issued + 600), "quoteWaitingTimeMs": 0,
    });
    if q.custom_msg {
        req["customRecipientMsg"] = json!("hello");
    }
    let mut quote = json!({
        "amountIn": q.amount.to_string(), "amountInFormatted": "x", "amountInUsd": q.in_usd, "minAmountIn": q.amount.to_string(),
        "amountOut": q.out.to_string(), "amountOutFormatted": "y", "amountOutUsd": q.out_usd, "minAmountOut": q.min_out.to_string(),
        "timeEstimate": 22, "refundFee": "4500", "deadline": iso(q.deadline), "timeWhenInactive": iso(q.deadline), "depositAddress": q.deposit,
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
    set(OPERATOR, now);
    f.propose_trade(quote_json(q))
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
        (Q { custom_msg: true, ..Default::default() }, CLOSE + 20, "customRecipientMsg"),
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
    let tampered = quote_json(&Q::default()).replace(&"a".repeat(64), &"b".repeat(64));
    set(OPERATOR, CLOSE + 20);
    assert!(!f.propose_trade(tampered));
    assert!(last_reason(&f).contains("does not verify"));
}

#[test]
#[should_panic(expected = "only the operator")]
fn nobody_but_the_operator_can_propose() {
    let mut f = funded();
    set("alice.test.near", CLOSE + 20);
    f.propose_trade(quote_json(&Q::default()));
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

// ------------------------------------------------------------------ settle / refund / abandon

fn sent_fund() -> Plinth {
    let mut f = funded();
    assert!(propose(&mut f, &Q::default(), CLOSE + 20));
    ok_sent(&mut f, 0, CLOSE + 21);
    f
}

#[test]
fn settle_credits_the_output_when_at_least_min_out_arrived() {
    let mut f = sent_fund();
    set_with_results(CLOSE + 60, vec![]);
    // Not yet: nothing arrived.
    assert_eq!(f.on_settle(0, 0, bal(0), bal(90_000_000)), TradeStatus::Sent);
    assert!(f.get_fund().pending.is_some());
    // Output arrived.
    let out = 2_695_000_000_000_000_000_000_000;
    assert_eq!(f.on_settle(0, 0, bal(out), bal(90_000_000)), TradeStatus::Settled);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!((v.held[0].1 .0, v.held[1].1 .0), (90_000_000, out));
    assert_eq!(f.get_trades(0, 1)[0].received_out.0, out);
    // A second settle callback for the same trade changes nothing.
    assert_eq!(f.on_settle(0, 0, bal(out * 2), bal(90_000_000)), TradeStatus::Settled);
    assert_eq!(f.get_fund().held[1].1 .0, out);
}

#[test]
fn a_1click_refund_closes_the_trade_as_refunded() {
    let mut f = sent_fund();
    set_with_results(CLOSE + 900, vec![]);
    assert_eq!(f.on_settle(0, 0, bal(0), bal(90_000_000 + 10_000_000 - 4_500)), TradeStatus::Refunded);
    assert_eq!(f.get_fund().held[0].1 .0, 100_000_000 - 4_500);
}

#[test]
fn abandon_only_long_after_the_deposit_address_expired() {
    let mut f = sent_fund();
    let deadline = Q::default().deadline;
    set("anyone.test.near", deadline + ABANDON_AFTER_SECONDS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.abandon())).is_err());
    set("anyone.test.near", deadline + ABANDON_AFTER_SECONDS + 1);
    f.abandon();
    assert!(f.get_fund().pending.is_none());
    assert_eq!(f.get_trades(0, 1)[0].status, TradeStatus::Abandoned);
}

#[test]
fn absorb_counts_donations_only_with_no_trade_in_flight() {
    let mut f = funded();
    set_with_results(T0 + 100, vec![]);
    assert_eq!(f.on_absorb(0, 0, bal(100_000_123)).0, 123);
    assert_eq!(f.get_fund().held[0].1 .0, 100_000_123);
}

// ------------------------------------------------------------------ redeem

#[test]
fn redeem_pays_the_pro_rata_amount_of_every_token_in_kind() {
    let mut f = sent_fund();
    set_with_results(CLOSE + 60, vec![]);
    let out = 2_695_000_000_000_000_000_000_000u128;
    f.on_settle(0, 0, bal(out), bal(90_000_000));
    // Bob holds 40%.
    set("bob.test.near", CLOSE + 70);
    f.redeem(U128(40_000_000));
    let v = f.get_fund();
    assert_eq!(v.held[0].1 .0, 90_000_000 - 36_000_000);
    assert_eq!(v.held[1].1 .0, out - out * 40 / 100);
    assert_eq!(v.total_shares.0, 60_000_000);
    assert_eq!(f.get_shares("bob.test.near".parse().unwrap()).0, 0);
    // In flight, the payouts are tracked per token and are not claimable.
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(36_000_000), U128(out * 40 / 100)]);
    assert!(f.get_owed("bob.test.near".parse().unwrap()).is_empty());
    payout(&mut f, "bob.test.near", 0, 36_000_000, true, CLOSE + 71);
    payout(&mut f, "bob.test.near", 1, out * 40 / 100, true, CLOSE + 71);
    assert_eq!(f.get_fund().in_flight_payouts, vec![U128(0), U128(0)]);
    assert!(f.get_owed("bob.test.near".parse().unwrap()).is_empty());
}

#[test]
fn a_failed_payout_stays_owed_and_is_not_mistaken_for_trade_output() {
    let mut f = funded();
    set("bob.test.near", T0 + 100);
    f.redeem(U128(40_000_000));
    payout(&mut f, "bob.test.near", 0, 40_000_000, false, T0 + 101);
    assert_eq!(f.get_owed("bob.test.near".parse().unwrap()), vec![U128(40_000_000), U128(0)]);
    // The fund's token balance still includes Bob's 40; absorb must not count it as a donation.
    set_with_results(T0 + 102, vec![]);
    assert_eq!(f.on_absorb(0, 1, bal(100_000_000)).0, 0);
    assert_eq!(f.get_fund().held[0].1 .0, 60_000_000);
    // Claim retries it; success clears it.
    set("bob.test.near", T0 + 103);
    f.claim();
    payout(&mut f, "bob.test.near", 0, 40_000_000, true, T0 + 104);
    assert!(f.get_owed("bob.test.near".parse().unwrap()).is_empty());
}

#[test]
fn redeem_waits_at_most_ten_minutes_for_a_trade_in_flight() {
    let mut f = sent_fund();
    set("alice.test.near", CLOSE + 21 + 60);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.redeem(U128(1_000_000)))).is_err());
    set("alice.test.near", CLOSE + 20 + REDEEM_WAIT_SECONDS);
    f.redeem(U128(60_000_000));
    // Alice leaves with 60% of what is held (the 10 USDC in flight stays with the fund).
    assert_eq!(f.get_fund().held[0].1 .0, 90_000_000 - 54_000_000);
}

#[test]
#[should_panic(expected = "not enough shares")]
fn cannot_redeem_more_than_you_hold() {
    let mut f = funded();
    set("bob.test.near", T0 + 100);
    f.redeem(U128(40_000_001));
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
        has_custom_recipient_msg: false,
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
    set("bob.test.near", T0 + 100);
    f.redeem(U128(40_000_000));
    // Same receipt: claim finds nothing while the payout is in flight.
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.claim())).is_err());
    payout(&mut f, "bob.test.near", 0, 40_000_000, false, T0 + 101);
    set("bob.test.near", T0 + 102);
    f.claim();
    // Already re-sent: a second claim before it resolves finds nothing.
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.claim())).is_err());
    assert_eq!(f.get_fund().in_flight_payouts[0].0, 40_000_000);
    payout(&mut f, "bob.test.near", 0, 40_000_000, true, T0 + 103);
    assert_eq!(f.get_fund().in_flight_payouts[0].0, 0);
    assert!(f.get_owed("bob.test.near".parse().unwrap()).is_empty());
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
    set_with_results(T0 + 100, vec![]);
    f.on_absorb(1, 0, bal(3 * 10u128.pow(28)));
    set("alice.test.near", T0 + 101);
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
    let mut f = sent_fund();
    set("bob.test.near", CLOSE + 20 + REDEEM_WAIT_SECONDS);
    f.redeem(U128(10_000_000));
    payout(&mut f, "bob.test.near", 0, 9_000_000, true, CLOSE + 20 + REDEEM_WAIT_SECONDS + 1);
    set_with_results(CLOSE + 700, vec![]);
    // Read taken with payouts_resolved = 0, but one payout resolved meanwhile: no credit.
    assert_eq!(f.on_settle(0, 0, bal(2_695_000_000_000_000_000_000_000), bal(90_000_000)), TradeStatus::Sent);
    assert_eq!(f.on_settle(0, 1, bal(2_695_000_000_000_000_000_000_000), bal(81_000_000)), TradeStatus::Settled);
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
    assert_eq!(subscribe(&mut f, "alice.test.near", 1_000_000_000, T0 + 20).0, 0);
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
    assert_eq!(subscribe(&mut f, "alice.test.near", 100_000_000, T0 + 10).0, 0);
    assert!(!propose(&mut f, &Q::default(), CLOSE + 20));
    assert!(last_reason(&f).contains("not registered"));
}

#[test]
fn audit_h3_trades_per_day_are_capped() {
    let mut f = funded();
    let mut t = CLOSE + 20;
    let mut sent = 0;
    for k in 0..4 {
        let q = Q { deposit: format!("{:064x}", k + 1), issued: t - 5, deadline: t + 86_400, ..Default::default() };
        if propose(&mut f, &q, t) {
            sent += 1;
            ok_sent(&mut f, k as u64, t + 1);
            set_with_results(t + 2, vec![]);
            let held_b = f.get_fund().held[1].1 .0;
            f.on_settle(k as u64, 0, bal(held_b + 2_695_000_000_000_000_000_000_000), bal(f.get_fund().held[0].1 .0));
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

fn staking_config(fee_bps: u16) -> Config {
    let mut c = config();
    c.mandate.tokens = vec![USDC.parse().unwrap(), WNEAR.parse().unwrap(), LST.parse().unwrap()];
    c.mandate.management_fee_bps = fee_bps;
    c.mandate.staking = Some(StakingRoute { wrap_index: 1, lst_index: 2, price_method: "get_st_near_price".into(), min_stake: U128(10u128.pow(24)), max_price_slippage_bps: 50 });
    c
}

fn staking_fund(fee_bps: u16) -> Plinth {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(staking_config(fee_bps));
    for i in 0..3 {
        set_with_results(T0, vec![PromiseResult::Successful(vec![])]);
        f.on_registered(i);
    }
    assert_eq!(subscribe(&mut f, "alice.test.near", 60_000_000, T0 + 10).0, 0);
    assert_eq!(subscribe(&mut f, "bob.test.near", 40_000_000, T0 + 20).0, 0);
    // The fund holds 20 wNEAR (a settled trade or a donation).
    set_with_results(T0 + 30, vec![]);
    f.on_absorb(1, 0, bal(20 * 10u128.pow(24)));
    f
}

fn stake(f: &mut Plinth, amount: u128, now: u64) -> bool {
    set(OPERATOR, now);
    f.stake_idle(U128(amount))
}

#[test]
fn stake_idle_unwraps_stakes_at_par_and_settles_against_the_price() {
    let mut f = staking_fund(0);
    let five = 5 * 10u128.pow(24);
    assert!(stake(&mut f, five, CLOSE + 20));
    assert_eq!(f.get_fund().held[1].1 .0, 15 * 10u128.pow(24));
    // Unwrap succeeded, price read: the contract computes the minimum it must receive.
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(0);
    let t = f.get_fund().pending.unwrap();
    let expected = mul_div(five, 10u128.pow(24), PRICE).unwrap();
    assert_eq!(t.quoted_out.0, expected);
    assert_eq!(t.min_out.0, expected * 9_950 / 10_000);
    set_with_results(CLOSE + 22, vec![PromiseResult::Successful(vec![])]);
    f.on_staked(0);
    assert_eq!(f.get_fund().pending.unwrap().status, TradeStatus::Sent);
    // Anyone settles: the minted stNEAR shows in the fund's balance.
    set_with_results(CLOSE + 30, vec![]);
    assert_eq!(f.on_settle(0, 0, bal(expected), bal(15 * 10u128.pow(24))), TradeStatus::Settled);
    assert_eq!(f.get_fund().held[2].1 .0, expected);
    // Redemption pays stNEAR in kind like any other token.
    set("bob.test.near", CLOSE + 40);
    f.redeem(U128(40_000_000));
    assert_eq!(f.get_fund().in_flight_payouts[2].0, expected * 40 / 100);
}

#[test]
fn a_mint_below_the_price_minimum_does_not_settle() {
    let mut f = staking_fund(0);
    let five = 5 * 10u128.pow(24);
    assert!(stake(&mut f, five, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(0);
    set_with_results(CLOSE + 22, vec![PromiseResult::Successful(vec![])]);
    f.on_staked(0);
    let min = f.get_fund().pending.unwrap().min_out.0;
    set_with_results(CLOSE + 30, vec![]);
    assert_eq!(f.on_settle(0, 0, bal(min - 1), bal(15 * 10u128.pow(24))), TradeStatus::Sent);
}

#[test]
fn a_failed_unwrap_restores_the_wnear() {
    let mut f = staking_fund(0);
    assert!(stake(&mut f, 5 * 10u128.pow(24), CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Failed, PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(0);
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!(v.held[1].1 .0, 20 * 10u128.pow(24));
    assert_eq!(f.get_trades(0, 1)[0].status, TradeStatus::Failed);
}

#[test]
fn a_failed_stake_is_wrapped_back_or_left_recoverable() {
    // deposit_and_stake fails, re-wrap succeeds: holdings restored.
    let mut f = staking_fund(0);
    let five = 5 * 10u128.pow(24);
    assert!(stake(&mut f, five, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(format!("\"{PRICE}\"").into_bytes())]);
    f.on_unwrapped(0);
    set_with_results(CLOSE + 22, vec![PromiseResult::Failed]);
    f.on_staked(0);
    set_with_results(CLOSE + 23, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(0, U128(five));
    assert_eq!(f.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
    assert!(f.get_fund().pending.is_none());
    // Same, but the re-wrap fails too: the NEAR is stranded, then recovered by anyone.
    let mut g = staking_fund(0);
    assert!(stake(&mut g, five, CLOSE + 20));
    set_with_results(CLOSE + 21, vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    g.on_unwrapped(0); // no price: straight to re-wrap
    set_with_results(CLOSE + 23, vec![PromiseResult::Failed]);
    g.on_rewrapped(0, U128(five));
    assert_eq!(g.get_fund().stranded_near.0, five);
    assert!(g.get_fund().pending.is_none());
    let mut ctx = ctx("anyone.test.near", CLOSE + 30);
    ctx.account_balance(NearToken::from_near(20));
    testing_env!(ctx.build());
    g.rewrap_stranded();
    assert_eq!(g.get_fund().stranded_near.0, 0);
    set_with_results(CLOSE + 31, vec![PromiseResult::Successful(vec![])]);
    g.on_rewrapped(u64::MAX, U128(five));
    assert_eq!(g.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
}

#[test]
fn stake_idle_obeys_size_minimum_cooldown_and_operator() {
    let mut f = staking_fund(0);
    assert!(!stake(&mut f, 6 * 10u128.pow(24), CLOSE + 20)); // 30% of 20
    assert!(last_reason(&f).contains("over 2500 bps"));
    assert!(!stake(&mut f, 10u128.pow(23), CLOSE + 20)); // 0.1 NEAR
    assert!(last_reason(&f).contains("below the minimum"));
    assert!(stake(&mut f, 5 * 10u128.pow(24), CLOSE + 20));
    assert!(!stake(&mut f, 10u128.pow(24), CLOSE + 25));
    // Refused and logged; not stored, because the stake's NEAR in transit is reserved (audit 2, H).
    assert!(get_logs().iter().any(|l| l.contains("already in flight")));
    set("alice.test.near", CLOSE + 30);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.stake_idle(U128(10u128.pow(24))))).is_err());
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
    set("anyone.test.near", CLOSE - 1);
    f.accrue();
    assert_eq!(f.get_fund().operator_shares.0, 0);
    // One year after the window closes the operator holds 1% of all shares.
    set("anyone.test.near", CLOSE + YEAR_SECONDS as u64);
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
    set("bob.test.near", CLOSE + YEAR_SECONDS as u64 + 1);
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
        set("anyone.test.near", t);
        f.accrue();
    }
    let frequent = f.get_fund().operator_shares.0;
    let mut g = staking_fund(200);
    set("anyone.test.near", CLOSE + 3600);
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
    let five = 5 * 10u128.pow(24);
    with_balance(OPERATOR, CLOSE + 20, 7_000); // 7 NEAR: ~2 NEAR really free
    assert!(f.stake_idle(U128(five)));
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
    set("anyone.test.near", T0 + 40);
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
        subscribe(&mut f, "alice.test.near", 3_000_000_000, T0 + 10);
        f
    };
    let mut a = mk();
    for t in 1..=3600u64 {
        set("anyone.test.near", CLOSE + t);
        a.accrue();
    }
    let mut b = mk();
    set("anyone.test.near", CLOSE + 3600);
    b.accrue();
    let (x, y) = (a.get_fund().operator_shares.0, b.get_fund().operator_shares.0);
    // Before the fix x was 48% of y. Now each call loses at most one share's rounding plus 1 ns.
    assert!(x <= y && x * 1000 >= y * 999, "every second: {x}; once: {y}");
}

#[test]
fn audit2_h_a_stuck_stake_can_be_recovered_after_a_day() {
    let mut f = staking_fund(0);
    let five = 5 * 10u128.pow(24);
    with_balance(OPERATOR, CLOSE + 20, 7_000);
    assert!(f.stake_idle(U128(five)));
    // on_unwrapped never completes (e.g. it ran out of balance or gas): the stake is stuck Sending.
    with_balance("anyone.test.near", CLOSE + 1000, 12_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.recover_stuck_stake())).is_err());
    with_balance("anyone.test.near", CLOSE + 20 + 86_401, 12_000);
    f.recover_stuck_stake();
    let v = f.get_fund();
    assert!(v.pending.is_none());
    assert_eq!(v.stranded_near.0, five);
    // ...and anyone wraps it back into fund holdings.
    with_balance("anyone.test.near", CLOSE + 20 + 86_402, 12_000);
    f.rewrap_stranded();
    set_with_results(CLOSE + 20 + 86_403, vec![PromiseResult::Successful(vec![])]);
    f.on_rewrapped(u64::MAX, U128(five));
    assert_eq!(f.get_fund().held[1].1 .0, 20 * 10u128.pow(24));
}

#[test]
fn audit2_m_new_depositors_cannot_eat_the_reserve() {
    set("deployer.test.near", T0);
    let mut f = Plinth::new(staking_config(0));
    with_balance(USDC, T0 + 10, 40); // 0.04 NEAR: below the reserve
    assert_eq!(f.ft_on_transfer("carol.test.near".parse().unwrap(), U128(5_000_000), String::new()).0, 5_000_000);
    assert_eq!(f.get_fund().total_shares.0, 0);
    with_balance(USDC, T0 + 11, 5_000);
    assert_eq!(f.ft_on_transfer("carol.test.near".parse().unwrap(), U128(5_000_000), String::new()).0, 0);
}
