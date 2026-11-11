//! Plinth: a keyless NEAR fund.
//!
//! - The mandate is fixed at `new()` and there is no method that changes it, the operator, the
//!   code or the account's keys. Deployed without any access key, nobody can change anything.
//! - The operator can only *propose* a swap by handing in a live NEAR Intents 1Click quote. The
//!   contract verifies 1Click's signature and checks the quote against the mandate, then sends the
//!   input itself to the quote's deposit address, with the fund as recipient and refund address.
//! - Depositors subscribe in the base token during a subscription window (1 share per base unit),
//!   and can always `redeem` their pro-rata amount of every token the fund holds, in kind. No
//!   price, oracle, operator or enclave is involved in the exit.
//!
//! Earning: a fund may list a liquid-staking token (e.g. Meta Pool stNEAR) and its wNEAR; the
//! operator can then `stake_idle` wNEAR into it at par (unwrap, deposit_and_stake), so depositors
//! earn staking yield while NEAR is staked. The operator is paid only by a yearly management fee in
//! new shares, fixed at launch (at most 2%), accrued per second; there is no per-trade fee.
//!
//! Accounting rule (release 0.3): the fund counts a token as its own only when the token contract
//! calls `ft_on_transfer` and the fund keeps it (a "push"), or when one of the fund's own calls
//! returns it. It never trusts a balance it reads for trade output, because a `ft_transfer_call`
//! that is about to bounce sits in `ft_balance_of` for a couple of blocks (the bug in 0.1 and 0.2).
//! - Trade output: the 1Click quote must carry `customRecipientMsg = "trade:<id>"`, so 1Click
//!   delivers with `ft_transfer_call` and the trade settles inside `ft_on_transfer`.
//! - Stake output: the amount `deposit_and_stake` returns.
//! - Refunds arrive as a plain transfer, so `settle_refund` is the one place a balance is read. It
//!   can only run an hour after a trade was sent without output, credits exactly
//!   `amount_in - refund_fee` once, and is undone if the output arrives after all.
//!
//! No manager (optional, `strategy`): anyone can call `rebalance()`. The fund asks OutLayer to run
//! a strategy program, pinned by its sha256 in the mandate, inside a TEE; the program's answer comes
//! back as a proposal and goes through exactly the checks an operator's proposal does. The fund
//! cannot verify the TEE on chain: a forged answer can do what an operator could, and no more.
//!
//! Joining after trading starts is in kind (`open_ended` funds): deposit every token the fund holds
//! in the fund's proportions and receive shares, with no price involved.

pub mod quote;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError, PromiseIndex};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);
/// Redemptions wait at most this long for a trade in flight to settle; after that a redeemer can
/// leave and forfeits only their share of that one trade (which stays with the other holders).
pub const REDEEM_WAIT_SECONDS: u64 = 10 * 60;
/// A trade whose deposit address expired this long ago without output or refund can be written
/// off by anyone, so a lost trade cannot block trading forever.
pub const ABANDON_AFTER_SECONDS: u64 = 7 * 24 * 3600;
/// NEAR the fund keeps for its own storage before paying deposit-address registrations.
const NEAR_RESERVE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
/// Storage a stake record needs (a Trade entry; measured ~0.002 NEAR), on top of the reserve.
const STAKE_STORAGE: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
/// Storage of one depositor's share entry (~0.001 NEAR), with room.
const SUBSCRIBER_STORAGE: u128 = 2_000_000_000_000_000_000_000; // 0.002 NEAR
const MAX_REJECTIONS_KEPT: u32 = 200;
const GAS_UNWRAP: Gas = Gas::from_tgas(15);
// Meta Pool get_st_near_price burns ~4 TGas on mainnet (586 pools) and grows with pools: keep room.
const GAS_PRICE_VIEW: Gas = Gas::from_tgas(20);
const GAS_DEPOSIT_AND_STAKE: Gas = Gas::from_tgas(50);
const GAS_WRAP: Gas = Gas::from_tgas(10);
const GAS_ON_UNWRAPPED: Gas = Gas::from_tgas(110);
const GAS_ON_STAKED: Gas = Gas::from_tgas(40);
/// Largest management fee, basis points per year.
pub const MAX_MANAGEMENT_FEE_BPS: u16 = 200;
/// Seconds per year used for fee accrual (365.25 days).
pub const YEAR_SECONDS: u128 = 31_557_600;
const YEAR_NANOS: u128 = YEAR_SECONDS * 1_000_000_000;
/// A stake still `Sending` this long after it was sent can be recovered by anyone.
const STUCK_STAKE_SECONDS: u64 = 86_400;
/// 1 NEAR in yocto: liquid-staking prices are quoted as yocto-NEAR per 1e24 units of the token.
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const MAX_TOKENS: usize = 4;
pub const VERSION: &str = "0.3.0";
/// A refund is a plain transfer the fund cannot see arrive. It is looked for only this long after
/// the trade was sent, when 1Click would long have delivered (its estimate is seconds to minutes).
pub const REFUND_WAIT_SECONDS: u64 = 3600;
/// A counted refund is taken back if the trade's output arrives within this long of the quote's
/// deadline; later pushes are plain donations.
pub const REFUND_UNDO_SECONDS: u64 = 86_400;
/// NEAR a joiner attaches to `open_basket`: pays for their basket and share entries, stays with the
/// fund (the contract cannot send NEAR).
pub const BASKET_DEPOSIT: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
const GAS_REQUEST_EXECUTION: Gas = Gas::from_tgas(70);
const GAS_ON_STRATEGY: Gas = Gas::from_tgas(205);
/// A strategy run that has not answered after this long no longer blocks the next one.
const STRATEGY_TIMEOUT_SECONDS: u64 = 600;
/// A swap still `Sending` this long after it was sent can be moved on by anyone.
const STUCK_TRADE_SECONDS: u64 = 86_400;

/// Whether the single promise this callback waits on succeeded, whatever it returned.
fn promise_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 16_384).is_ok()
}

/// (a * b / d, a * b % d) with a 256-bit intermediate; None if d is 0 or the quotient does not fit.
fn mul_div_rem(a: u128, b: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 {
        return None;
    }
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | ((mid & M) << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    if hi >= d {
        return None;
    }
    let (mut rem, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1 << i;
        }
    }
    Some((q, rem))
}

/// a * b / d rounded down.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    mul_div_rem(a, b, d).map(|(q, _)| q)
}

/// a * b / d rounded up.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let (q, rem) = mul_div_rem(a, b, d)?;
    if rem == 0 {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

// Cross-contract calls use the low-level host functions only (no near_sdk::Promise), so the
// compiled wasm has no call path to any deploy / add-key / delete-key / stake host function.
// `node contracts/check-wasm.cjs` proves this from the bytes.

fn call(account: &AccountId, method: &str, args: near_sdk::serde_json::Value, deposit: u128, gas: Gas) -> PromiseIndex {
    env::promise_create(account.clone(), method, args.to_string().into_bytes(), NearToken::from_yoctonear(deposit), gas)
}

fn then_self(after: PromiseIndex, method: &str, args: near_sdk::serde_json::Value, gas: Gas) -> PromiseIndex {
    env::promise_then(after, env::current_account_id(), method, args.to_string().into_bytes(), NearToken::from_yoctonear(0), gas)
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Shares,
    Owed,
    UsedDepositAddresses,
    Trades,
    Rejections,
    Baskets,
}

/// The rules, fixed at launch.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    /// NEP-141 tokens the fund may hold, deposit and trade. `tokens[0]` is the base token
    /// (subscriptions are in it). At most 4 (MAX_TOKENS).
    pub tokens: Vec<AccountId>,
    /// Largest single trade, in basis points of the fund's holding of the token sold.
    pub max_trade_bps: u16,
    /// Largest all-in cost of a trade in basis points, computed from 1Click's signed USD marks at
    /// the worst-case output: (in_usd - out_usd * minAmountOut / amountOut) / in_usd.
    pub max_cost_bps: u16,
    /// Minimum time between two trades. At least REDEEM_WAIT_SECONDS + 60, so a redeemer can
    /// always find a moment with no trade in flight.
    pub min_seconds_between_trades: u64,
    /// At most this many trades per UTC day. With max_trade_bps and max_cost_bps it bounds what
    /// trading can cost the fund in a day (see README: the operator can capture up to the cost cap
    /// of each trade through 1Click app fees, which 1Click does not sign).
    pub max_trades_per_day: u32,
    /// A quote older than this (from its signed timestamp) is refused.
    pub max_quote_age_seconds: u64,
    /// The quote's deposit address must stay open at least this long after the trade is sent.
    pub min_deadline_margin_seconds: u64,
    /// Subscriptions are accepted until this time (Unix seconds); trading starts after it.
    pub subscription_closes_at: u64,
    /// Smallest subscription, in base-token units.
    pub min_subscription: U128,
    /// Largest total subscriptions, in base-token units.
    pub max_total_subscriptions: U128,
    /// Yearly management fee, in basis points, paid to the operator as newly minted shares,
    /// accrued per second from the close of the subscription window. At most 200 (2%). It is the
    /// operator's only pay: there is no per-trade or performance fee.
    #[serde(default)]
    pub management_fee_bps: u16,
    /// Optional: let the operator stake the fund's wNEAR into a liquid-staking token at par.
    #[serde(default)]
    pub staking: Option<StakingRoute>,
    /// Let people join after trading starts, in kind: they deposit every token the fund holds in
    /// the fund's own proportions and receive shares (`join_in_kind`). No price is used.
    #[serde(default)]
    pub open_ended: bool,
    /// Optional: a strategy program anyone can trigger with `rebalance`.
    #[serde(default)]
    pub strategy: Option<Strategy>,
}

/// A strategy program run by OutLayer (`request_execution`) in a TEE. `wasm_hash` pins the exact
/// program for the life of the fund.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Strategy {
    /// The OutLayer contract (`outlayer.near` / `outlayer.testnet`).
    pub outlayer: AccountId,
    /// Where the wasm is fetched from (https), and its sha256 (64 hex characters).
    pub wasm_url: String,
    pub wasm_hash: String,
    pub max_instructions: u64,
    pub max_execution_seconds: u32,
    /// OutLayer secrets (API keys) the program may read: profile and the account that stored them.
    #[serde(default)]
    pub secrets_profile: Option<String>,
    #[serde(default)]
    pub secrets_owner: Option<AccountId>,
    /// true: only the strategy can propose; the operator account cannot (it only receives the fee).
    pub exclusive: bool,
}

/// How the fund stakes wNEAR: `tokens[wrap_index]` must be a wNEAR contract (`near_withdraw`,
/// `near_deposit`) and `tokens[lst_index]` a liquid-staking token that mints for attached NEAR
/// (`deposit_and_stake`, which must return the minted amount as a decimal string, as Meta Pool
/// does) and reports its price in yocto-NEAR per 1e24 units (`price_method`, e.g.
/// Meta Pool's `get_st_near_price`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StakingRoute {
    pub wrap_index: u8,
    pub lst_index: u8,
    pub price_method: String,
    /// Smallest stake the liquid-staking contract accepts (Meta Pool: 1 NEAR).
    pub min_stake: U128,
    /// The minted amount must be at least amount / price minus this many basis points.
    pub max_price_slippage_bps: u16,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub mandate: Mandate,
    /// The only account that may propose trades. It cannot withdraw, pause or change anything.
    pub operator: AccountId,
    /// ed25519 key that signs 1Click quotes (base58, optional `ed25519:` prefix). Live funds use
    /// `quote::ONE_CLICK_MANAGER_PUB_KEY`; tests use their own.
    pub quote_signer: String,
    /// NEAR attached to each NEP-145 `storage_deposit` (registration of a 1Click deposit address
    /// on the token sold). 0.00125 NEAR for the common tokens.
    pub storage_deposit: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum TradeStatus {
    /// Input on its way to the deposit address.
    Sending,
    /// Input delivered to the deposit address; waiting for output or refund.
    Sent,
    Settled,
    Refunded,
    /// The token transfer to the deposit address failed; nothing left the fund.
    Failed,
    /// Written off after the deposit address expired without output or refund.
    Abandoned,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Trade {
    pub id: u64,
    /// A stake of wNEAR into the liquid-staking token (`stake_idle`) rather than a 1Click swap.
    pub stake: bool,
    pub sell: u8,
    pub buy: u8,
    pub amount_in: U128,
    pub quoted_out: U128,
    pub min_out: U128,
    pub refund_fee: U128,
    pub cost_bps: u16,
    pub deposit_address: AccountId,
    pub deposit_deadline: u64,
    pub sent_at: u64,
    pub status: TradeStatus,
    /// Output pushed to the fund for this trade so far (`ft_on_transfer` with `trade:<id>`), or
    /// the amount a stake minted.
    pub received_out: U128,
    /// Refund counted by `settle_refund` (exactly `amount_in - refund_fee`, or 0).
    pub received_refund: U128,
    pub closed_at: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rejection {
    pub at: u64,
    pub reason: String,
    pub deposit_address: Option<String>,
}

#[near(serializers = [json])]
pub struct FundView {
    pub config: Config,
    pub held: Vec<(AccountId, U128)>,
    pub total_shares: U128,
    pub total_subscribed: U128,
    pub subscription_open: bool,
    pub trading_open: bool,
    pub pending: Option<Trade>,
    pub trades: u64,
    pub rejections: u32,
    pub last_trade_at: u64,
    pub near_available_for_registrations: U128,
    pub in_flight_payouts: Vec<U128>,
    pub registered: Vec<bool>,
    pub trades_today: u32,
    pub fee_accrued_at: u64,
    pub stranded_near: U128,
    pub operator_shares: U128,
    pub version: String,
    /// Failed payouts waiting to be claimed, per token.
    pub owed_total: Vec<U128>,
    /// Tokens waiting in joiners' baskets (not part of the fund's holdings).
    pub basket_total: Vec<U128>,
    /// NEAR the account holds above its storage cost and the stake NEAR it is keeping.
    pub near_free: U128,
    /// The most trading can cost one token's holding in a day under the mandate, in basis points:
    /// max_trade_bps x max_cost_bps x max_trades_per_day (capped at 10000).
    pub max_daily_cost_bps: u32,
    /// When the strategy run in flight was requested (0 = none).
    pub strategy_started: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Plinth {
    config: Config,
    signer_key: [u8; 32],
    /// Token balances the fund accounts for (index = mandate.tokens index). Excludes a trade in
    /// flight and amounts owed to redeemers.
    held: Vec<u128>,
    total_shares: u128,
    total_subscribed: u128,
    shares: LookupMap<AccountId, u128>,
    /// Redemption payouts whose transfer failed (e.g. redeemer not registered on the token),
    /// claimable with `claim`.
    owed: LookupMap<AccountId, Vec<u128>>,
    /// Sum of `owed` per token (failed payouts, claimable), excluded from the fund's holdings.
    owed_total: Vec<u128>,
    /// Redemption payouts whose transfer has not resolved yet, per token. Not claimable.
    in_flight: Vec<u128>,
    /// Bumped whenever tokens move in or out of what the fund accounts for. The one balance read
    /// (`settle_refund`) is ignored if this changed between the read and its callback.
    flux: u64,
    /// Whether the fund's own storage registration on each token succeeded.
    registered: Vec<bool>,
    /// UTC day of the last trade and the number of trades sent that day.
    trade_day: u64,
    trades_today: u32,
    /// Management fee accrued up to this time (nanoseconds, so frequent accruals lose nothing).
    fee_accrued_at: u64,
    /// Unwrapped NEAR that could not be re-wrapped after a failed stake (`rewrap_stranded`).
    stranded_near: u128,
    /// NEAR of a stake between `near_withdraw` and `deposit_and_stake` (or its re-wrap). It sits in
    /// the account balance but is the fund's, so it is never spent on storage.
    near_in_flight: u128,
    /// Free NEAR just before the stake in flight started, so a stuck stake can tell whether its
    /// NEAR came back without mistaking the fund's own NEAR for it.
    stake_near_before: u128,
    /// Tokens joiners have deposited towards an in-kind join, per account and in total.
    baskets: LookupMap<AccountId, Vec<u128>>,
    basket_total: Vec<u128>,
    /// When the strategy run in flight was requested (0 = none).
    strategy_started: u64,
    used_deposit_addresses: LookupSet<AccountId>,
    trades: Vector<Trade>,
    pending: Option<u64>,
    last_trade_at: u64,
    rejections: Vector<Rejection>,
}

fn now_seconds() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn event(kind: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "plinth", "version": "1.0.0", "event": kind, "data": [data]})));
}

/// All-in cost of a quote in basis points at the worst-case output, from 1Click's signed marks.
pub fn cost_bps(q: &quote::VerifiedQuote) -> Option<u128> {
    if q.amount_in_usd_micros == 0 || q.amount_out == 0 {
        return None;
    }
    let worst_out_usd = mul_div(q.amount_out_usd_micros, q.min_amount_out, q.amount_out)?;
    mul_div(q.amount_in_usd_micros.saturating_sub(worst_out_usd), 10_000, q.amount_in_usd_micros)
}

#[near]
impl Plinth {
    /// Set up the fund. Attach enough NEAR for the fund's own storage plus deposit-address
    /// registrations (each trade spends `storage_deposit`). Registers the fund on every token.
    #[init]
    #[payable]
    pub fn new(config: Config) -> Self {
        let m = &config.mandate;
        // Redemption pays every token in one transaction (35 TGas per token attached): 4 fits with room.
        require!(!m.tokens.is_empty() && m.tokens.len() <= MAX_TOKENS, "1 to 4 tokens");
        for (i, t) in m.tokens.iter().enumerate() {
            require!(!m.tokens[..i].contains(t), "duplicate token");
            require!(*t != env::current_account_id(), "the fund cannot list itself");
        }
        require!(m.max_trade_bps > 0 && m.max_trade_bps <= 10_000, "max_trade_bps must be 1..=10000");
        require!(m.max_cost_bps <= 10_000, "max_cost_bps must be <= 10000");
        require!(m.max_quote_age_seconds > 0, "max_quote_age_seconds must be > 0");
        require!(m.min_seconds_between_trades >= REDEEM_WAIT_SECONDS + 60, "min_seconds_between_trades must be at least 660");
        require!(m.max_trades_per_day > 0, "max_trades_per_day must be > 0");
        require!(m.subscription_closes_at > now_seconds(), "subscription must close in the future");
        require!(m.min_subscription.0 > 0 && m.min_subscription.0 <= m.max_total_subscriptions.0, "bad subscription limits");
        require!(config.operator != env::current_account_id(), "the fund cannot be its own operator");
        require!(m.management_fee_bps <= MAX_MANAGEMENT_FEE_BPS, "management_fee_bps must be at most 200");
        if let Some(r) = &m.staking {
            let n = m.tokens.len() as u8;
            require!(r.wrap_index < n && r.lst_index < n && r.wrap_index != r.lst_index, "bad staking token indices");
            require!(!r.price_method.is_empty() && r.price_method.len() <= 64, "bad price_method");
            // Meta Pool rounds the minted amount down; 0 bps would make every stake unsettleable.
            require!(r.max_price_slippage_bps >= 1 && r.max_price_slippage_bps <= 500, "max_price_slippage_bps must be 1..=500");
        }
        if let Some(s) = &m.strategy {
            require!(s.wasm_url.starts_with("https://") && s.wasm_url.len() <= 512, "strategy wasm_url must be https");
            require!(s.wasm_hash.len() == 64 && s.wasm_hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "strategy wasm_hash must be 64 lowercase hex characters");
            require!(s.max_instructions > 0 && s.max_execution_seconds > 0 && s.max_execution_seconds <= 120, "bad strategy limits");
            require!(s.secrets_profile.is_some() == s.secrets_owner.is_some(), "strategy secrets need both a profile and an owner");
            require!(s.outlayer != env::current_account_id(), "bad strategy account");
        }
        let signer_key = quote::decode_public_key(&config.quote_signer).unwrap_or_else(|| env::panic_str("quote_signer is not an ed25519 key"));
        let n = m.tokens.len();
        // Register the fund on every token it may hold, so outputs and refunds can land.
        let per = config.storage_deposit.0;
        require!(env::attached_deposit().as_yoctonear() >= per * n as u128, "attach at least storage_deposit for each token");
        for (i, t) in m.tokens.iter().enumerate() {
            let p = call(t, "storage_deposit", json!({"account_id": env::current_account_id(), "registration_only": true}), per, GAS_STORAGE_DEPOSIT);
            then_self(p, "on_registered", json!({"token_index": i as u8}), GAS_CALLBACK);
        }
        event("fund_created", json!({"config": &config}));
        // The operator's fee shares get their storage now, paid at launch, so a later first accrual
        // (run inside every redeem) never needs NEAR the fund may not have.
        let mut shares = LookupMap::new(StorageKey::Shares);
        if m.management_fee_bps > 0 {
            shares.insert(config.operator.clone(), 0u128);
        }
        Self {
            config,
            signer_key,
            held: vec![0; n],
            total_shares: 0,
            total_subscribed: 0,
            shares,
            owed: LookupMap::new(StorageKey::Owed),
            owed_total: vec![0; n],
            in_flight: vec![0; n],
            flux: 0,
            registered: vec![false; n],
            trade_day: 0,
            trades_today: 0,
            fee_accrued_at: 0,
            stranded_near: 0,
            near_in_flight: 0,
            stake_near_before: 0,
            baskets: LookupMap::new(StorageKey::Baskets),
            basket_total: vec![0; n],
            strategy_started: 0,
            used_deposit_addresses: LookupSet::new(StorageKey::UsedDepositAddresses),
            trades: Vector::new(StorageKey::Trades),
            pending: None,
            last_trade_at: 0,
            rejections: Vector::new(StorageKey::Rejections),
        }
    }

    // ------------------------------------------------------------------ subscribe

    /// NEP-141 receiver: the only way tokens enter the fund's accounts. By `msg`:
    /// - `trade:<id>`: output of a trade (1Click delivers this way because the quote's signed
    ///   `customRecipientMsg` says so). Always kept. The trade settles here once `min_out` is in.
    /// - `donate`: kept and added to the fund's holdings.
    /// - `basket`: kept towards the sender's in-kind join (`open_basket` first).
    /// - anything else: a base-token subscription while the window is open; otherwise returned.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let Some(i) = self.config.mandate.tokens.iter().position(|t| *t == token) else {
            return amount; // not one of the fund's tokens
        };
        if amount.0 == 0 || self.held[i].checked_add(amount.0).is_none() {
            return amount;
        }
        if let Some(id) = msg.strip_prefix("trade:") {
            self.credit_push(i, id.parse::<u64>().ok(), amount.0, &sender_id);
            return U128(0);
        }
        match msg.as_str() {
            "donate" => {
                self.credit_push(i, None, amount.0, &sender_id);
                U128(0)
            }
            "basket" => self.basket_deposit(sender_id, i, amount),
            _ => self.subscribe(sender_id, i, amount),
        }
    }

    /// Tokens the fund keeps: add them to its holdings, and close the trade they belong to.
    fn credit_push(&mut self, i: usize, trade_id: Option<u64>, amount: u128, sender: &AccountId) {
        self.held[i] += amount;
        self.flux += 1;
        let token = self.config.mandate.tokens[i].clone();
        let Some(id) = trade_id.filter(|id| *id < self.trades.len() as u64) else {
            event("donated", json!({"token": token, "amount": U128(amount), "from": sender}));
            return;
        };
        let mut t = self.trades[id as u32].clone();
        if t.stake || t.buy as usize != i || matches!(t.status, TradeStatus::Settled | TradeStatus::Failed) {
            event("donated", json!({"token": token, "amount": U128(amount), "from": sender, "trade_id": id}));
            return;
        }
        t.received_out = U128(t.received_out.0.saturating_add(amount));
        event("output_received", json!({"trade_id": id, "amount": U128(amount), "total": t.received_out}));
        self.close_if_delivered(&mut t);
        self.trades.replace(id as u32, t);
    }

    /// Settle a trade whose output has been pushed in full. If a refund had been counted for it
    /// (`settle_refund`), that credit is taken back: 1Click delivers or refunds, never both.
    fn close_if_delivered(&mut self, t: &mut Trade) {
        if t.status == TradeStatus::Sending || t.received_out.0 < t.min_out.0 {
            return;
        }
        if t.received_refund.0 > 0 && now_seconds() > t.deposit_deadline.max(t.sent_at) + REFUND_UNDO_SECONDS {
            // Long after 1Click could still deliver: this is a gift, not the trade's output. The
            // refund stands (otherwise anyone could pay min_out to strike an old refund off the books).
            return;
        }
        if t.received_refund.0 > 0 {
            let s = t.sell as usize;
            let undo = t.received_refund.0.min(self.held[s]);
            self.held[s] -= undo;
            event("refund_undone", json!({"trade_id": t.id, "amount": U128(undo)}));
            t.received_refund = U128(0);
        }
        if self.pending == Some(t.id) {
            self.pending = None;
        }
        t.status = TradeStatus::Settled;
        t.closed_at = Some(now_seconds());
        event("trade_closed", json!({"trade": &*t}));
    }

    fn subscribe(&mut self, sender_id: AccountId, i: usize, amount: U128) -> U128 {
        let m = &self.config.mandate;
        if i != 0 {
            // Not the base token and no instruction: hand it back.
            return amount;
        }
        if now_seconds() >= m.subscription_closes_at {
            env::log_str("subscription window is closed; returned");
            return amount;
        }
        if amount.0 < m.min_subscription.0 || self.total_subscribed + amount.0 > m.max_total_subscriptions.0 {
            env::log_str("subscription outside the fund's limits; returned");
            return amount;
        }
        // A new depositor's share entry is paid from the fund's NEAR; never let it eat the reserve
        // that failed-payout records (`owed`) and stakes rely on.
        if self.shares.get(&sender_id).is_none() && self.free_near() < NEAR_RESERVE + SUBSCRIBER_STORAGE {
            env::log_str("the fund has no NEAR left to store a new depositor; returned");
            return amount;
        }
        // Before trading starts, 1 share per base unit.
        let s = self.shares.get(&sender_id).copied().unwrap_or(0);
        self.shares.insert(sender_id.clone(), s + amount.0);
        self.total_shares += amount.0;
        self.total_subscribed += amount.0;
        self.held[0] += amount.0;
        self.flux += 1;
        event("subscribed", json!({"account_id": sender_id, "amount": amount, "shares": amount}));
        U128(0)
    }

    // ------------------------------------------------------------------ join in kind

    /// Open (or top up the storage of) the caller's basket for an in-kind join. Attach
    /// BASKET_DEPOSIT; it pays for the basket and share entries and stays with the fund.
    #[payable]
    pub fn open_basket(&mut self) {
        require!(self.config.mandate.open_ended, "this fund does not take in-kind joins");
        require!(env::attached_deposit().as_yoctonear() >= BASKET_DEPOSIT, "attach 0.005 NEAR for storage");
        let who = env::predecessor_account_id();
        if self.baskets.get(&who).is_none() {
            self.baskets.insert(who, vec![0; self.held.len()]);
        }
    }

    fn basket_deposit(&mut self, sender_id: AccountId, i: usize, amount: U128) -> U128 {
        let Some(mut b) = self.baskets.get(&sender_id).cloned() else {
            env::log_str("no basket: call open_basket first; returned");
            return amount;
        };
        b[i] += amount.0;
        self.basket_total[i] += amount.0;
        self.flux += 1;
        self.baskets.insert(sender_id.clone(), b);
        event("basket_deposit", json!({"account_id": sender_id, "token": self.config.mandate.tokens[i], "amount": amount}));
        U128(0)
    }

    /// Turn the caller's basket into shares. The fund takes, of every token it holds, the same
    /// fraction of its holding, and mints that fraction of the shares; whatever the basket holds
    /// beyond that stays in the basket (`withdraw_basket`). Rounding favours existing holders.
    /// `min_shares` protects the joiner if the fund's holdings change before this runs.
    pub fn join_in_kind(&mut self, min_shares: U128) -> U128 {
        require!(self.config.mandate.open_ended, "this fund does not take in-kind joins");
        require!(now_seconds() >= self.config.mandate.subscription_closes_at, "the subscription window is open: subscribe in the base token");
        require!(self.pending.is_none(), "a trade is in flight; join when it has settled");
        self.accrue_fee();
        let who = env::predecessor_account_id();
        let mut b = self.baskets.get(&who).cloned().unwrap_or_else(|| env::panic_str("no basket: call open_basket first"));
        let total = self.total_shares;
        require!(total > 0, "the fund has no shares to price a join against");
        let mut s = u128::MAX;
        for i in 0..self.held.len() {
            if self.held[i] > 0 {
                s = s.min(mul_div(b[i], total, self.held[i]).unwrap_or(0));
            }
        }
        require!(s != u128::MAX, "the fund holds nothing to join");
        require!(s > 0 && s >= min_shares.0, "the basket is too small for min_shares at the fund's current holdings");
        let mut taken = Vec::new();
        for i in 0..self.held.len() {
            if self.held[i] > 0 {
                // ceil(s * held / total) <= basket, because s <= basket * total / held.
                let take = mul_div_ceil(s, self.held[i], total).unwrap_or_else(|| env::panic_str("overflow")).min(b[i]);
                b[i] -= take;
                self.basket_total[i] -= take;
                self.held[i] += take;
                taken.push(json!({"token": self.config.mandate.tokens[i], "amount": U128(take)}));
            }
        }
        let mine = self.shares.get(&who).copied().unwrap_or(0);
        self.shares.insert(who.clone(), mine + s);
        self.total_shares += s;
        self.baskets.insert(who.clone(), b);
        event("joined_in_kind", json!({"account_id": who, "shares": U128(s), "taken": taken}));
        U128(s)
    }

    /// Send back everything in the caller's basket and close it.
    pub fn withdraw_basket(&mut self) {
        let who = env::predecessor_account_id();
        let b = self.baskets.remove(&who).unwrap_or_else(|| env::panic_str("no basket"));
        for (i, amount) in b.into_iter().enumerate() {
            if amount > 0 {
                self.basket_total[i] -= amount;
                self.pay(who.clone(), i, amount);
            }
        }
    }

    // ------------------------------------------------------------------ trade

    /// Operator only. Propose a swap with a live 1Click quote (the full JSON response). Returns
    /// true when the trade was sent. A quote that breaks the mandate is refused and recorded
    /// (with its reason) instead of panicking, so refusals are visible on chain.
    pub fn propose_trade(&mut self, quote: String) -> bool {
        require!(env::predecessor_account_id() == self.config.operator, "only the operator can propose trades");
        require!(!self.strategy_only(), "this fund has no manager: only its strategy proposes (rebalance)");
        self.propose(&quote)
    }

    fn strategy_only(&self) -> bool {
        self.config.mandate.strategy.as_ref().map_or(false, |s| s.exclusive)
    }

    fn propose(&mut self, quote: &str) -> bool {
        self.accrue_fee();
        match self.check_trade(quote) {
            Ok(t) => {
                self.send_trade(t);
                true
            }
            Err((reason, deposit_address)) => {
                self.refuse(reason, deposit_address);
                false
            }
        }
    }

    fn refuse(&mut self, reason: String, deposit_address: Option<String>) {
        let r = Rejection { at: now_seconds(), reason: reason.clone(), deposit_address: deposit_address.clone() };
        if self.rejections.len() < MAX_REJECTIONS_KEPT && self.free_near() > 2 * NEAR_RESERVE {
            self.rejections.push(r);
        }
        event("trade_refused", json!({"reason": reason, "deposit_address": deposit_address}));
    }

    /// The checks every trade and stake share: window closed, nothing in flight, cooldown, daily cap.
    fn check_timing(&self) -> Result<(), String> {
        let m = &self.config.mandate;
        let now = now_seconds();
        if now < m.subscription_closes_at {
            return Err("trading starts when the subscription window closes".into());
        }
        if self.pending.is_some() {
            return Err("a trade is already in flight".into());
        }
        if self.last_trade_at > 0 && now < self.last_trade_at + m.min_seconds_between_trades {
            return Err("too soon after the last trade".into());
        }
        if now / 86_400 == self.trade_day && self.trades_today >= m.max_trades_per_day {
            return Err("the mandate's trades for today are used up".into());
        }
        Ok(())
    }

    fn start_trade(&mut self, t: &Trade) {
        self.held[t.sell as usize] -= t.amount_in.0;
        self.flux += 1;
        self.pending = Some(t.id);
        self.last_trade_at = t.sent_at;
        let day = t.sent_at / 86_400;
        if day != self.trade_day {
            self.trade_day = day;
            self.trades_today = 0;
        }
        self.trades_today += 1;
    }

    // ------------------------------------------------------------------ stake

    /// Operator only, if the mandate has a staking route. Stake `amount` of the fund's wNEAR into the
    /// liquid-staking token at par: unwrap it, read the token's price, `deposit_and_stake` the NEAR,
    /// and count the amount that call returns as minted. Counts as a trade for the size cap,
    /// cooldown and daily limit. If staking fails the NEAR is wrapped back.
    pub fn stake_idle(&mut self, amount: U128) -> bool {
        require!(env::predecessor_account_id() == self.config.operator, "only the operator can stake");
        require!(!self.strategy_only(), "this fund has no manager: only its strategy proposes (rebalance)");
        require!(self.config.mandate.staking.is_some(), "this fund has no staking route");
        self.stake(amount)
    }

    fn stake(&mut self, amount: U128) -> bool {
        let Some(r) = self.config.mandate.staking.clone() else {
            self.refuse("this fund has no staking route".into(), None);
            return false;
        };
        self.accrue_fee();
        let (w, l) = (r.wrap_index as usize, r.lst_index as usize);
        let why = self.check_timing().err().or_else(|| {
            let held = self.held[w];
            if amount.0 < r.min_stake.0 {
                Some(format!("stake of {} is below the minimum {}", amount.0, r.min_stake.0))
            } else if amount.0 > mul_div(held, self.config.mandate.max_trade_bps as u128, 10_000).unwrap_or(0) {
                Some(format!("stake of {} is over {} bps of the {} held", amount.0, self.config.mandate.max_trade_bps, held))
            } else if !self.registered[w] || !self.registered[l] {
                Some("the fund is not registered on one of these tokens".into())
            } else if self.free_near() < NEAR_RESERVE + STAKE_STORAGE {
                Some("the fund has no NEAR left for the stake's storage".into())
            } else {
                None
            }
        });
        if let Some(reason) = why {
            self.refuse(reason, None);
            return false;
        }
        let tokens = self.config.mandate.tokens.clone();
        let now = now_seconds();
        let t = Trade {
            id: self.trades.len() as u64,
            stake: true,
            sell: w as u8,
            buy: l as u8,
            amount_in: amount,
            quoted_out: U128(0),
            min_out: U128(0),
            refund_fee: U128(0),
            cost_bps: 0,
            deposit_address: tokens[l].clone(),
            deposit_deadline: now + 86_400,
            sent_at: now,
            status: TradeStatus::Sending,
            received_out: U128(0),
            received_refund: U128(0),
            closed_at: None,
        };
        self.start_trade(&t);
        self.stake_near_before = self.raw_free_near();
        self.near_in_flight = amount.0;
        event("stake_sent", json!({"trade": &t}));
        let unwrap = call(&tokens[w], "near_withdraw", json!({"amount": amount}), 1, GAS_UNWRAP);
        let price = call(&tokens[l], &r.price_method, json!({}), 0, GAS_PRICE_VIEW);
        then_self(env::promise_and(&[unwrap, price]), "on_unwrapped", json!({"trade_id": t.id}), GAS_ON_UNWRAPPED);
        self.trades.push(t);
        true
    }

    #[private]
    pub fn on_unwrapped(&mut self, trade_id: u64) {
        self.flux += 1;
        let mut t = self.trades[trade_id as u32].clone();
        let r = self.config.mandate.staking.clone().unwrap_or_else(|| env::panic_str("no staking route"));
        let tokens = self.config.mandate.tokens.clone();
        if env::promise_result_checked(0, 16_384).is_err() {
            // Nothing was unwrapped: restore it.
            self.near_in_flight = 0;
            self.held[t.sell as usize] += t.amount_in.0;
            t.status = TradeStatus::Failed;
            t.closed_at = Some(now_seconds());
            self.pending = None;
            event("stake_failed", json!({"trade_id": trade_id, "at": "unwrap"}));
            self.trades.replace(trade_id as u32, t);
            return;
        }
        let price = env::promise_result_checked(1, 1_024)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<U128>(&b).ok())
            .map(|p| p.0)
            .filter(|p| *p > 0);
        let Some(price) = price else {
            self.trades.replace(trade_id as u32, t);
            self.rewrap(trade_id);
            return;
        };
        let expected = mul_div(t.amount_in.0, ONE_NEAR, price).unwrap_or(0);
        t.quoted_out = U128(expected);
        t.min_out = U128(mul_div(expected, 10_000 - r.max_price_slippage_bps as u128, 10_000).unwrap_or(0).max(1));
        let p = call(&tokens[t.buy as usize], "deposit_and_stake", json!({}), t.amount_in.0, GAS_DEPOSIT_AND_STAKE);
        then_self(p, "on_staked", json!({"trade_id": trade_id}), GAS_ON_STAKED);
        self.trades.replace(trade_id as u32, t);
    }

    #[private]
    pub fn on_staked(&mut self, trade_id: u64) {
        self.flux += 1;
        let Ok(bytes) = env::promise_result_checked(0, 1_024) else {
            self.rewrap(trade_id);
            return;
        };
        // The staking contract returns what it minted. Never more than the price read allows for.
        let mut t = self.trades[trade_id as u32].clone();
        let slip = self.config.mandate.staking.as_ref().map(|r| r.max_price_slippage_bps as u128).unwrap_or(0);
        let ceiling = mul_div(t.quoted_out.0, 10_000 + slip, 10_000).unwrap_or(t.quoted_out.0);
        let minted = near_sdk::serde_json::from_slice::<U128>(&bytes).map(|m| m.0).unwrap_or(0).min(ceiling);
        if minted < t.min_out.0 {
            env::log_str(&format!("stake {trade_id} minted {minted}, below the {} expected", t.min_out.0));
        }
        self.held[t.buy as usize] += minted;
        t.received_out = U128(minted);
        t.status = TradeStatus::Settled;
        t.closed_at = Some(now_seconds());
        self.near_in_flight = 0;
        self.pending = None;
        event("trade_closed", json!({"trade": &t}));
        self.trades.replace(trade_id as u32, t);
    }

    /// The unwrapped NEAR of a failed stake goes back into wNEAR.
    fn rewrap(&mut self, trade_id: u64) {
        let t = &self.trades[trade_id as u32];
        let wrap = self.config.mandate.tokens[t.sell as usize].clone();
        let p = call(&wrap, "near_deposit", json!({}), t.amount_in.0, GAS_WRAP);
        then_self(p, "on_rewrapped", json!({"trade_id": trade_id, "amount": t.amount_in}), GAS_CALLBACK);
        self.near_in_flight = 0;
    }

    /// trade_id u64::MAX = a `rewrap_stranded` retry.
    #[private]
    pub fn on_rewrapped(&mut self, trade_id: u64, amount: U128) {
        self.flux += 1;
        let ok = promise_ok();
        if trade_id != u64::MAX {
            let mut t = self.trades[trade_id as u32].clone();
            t.status = TradeStatus::Failed;
            t.closed_at = Some(now_seconds());
            self.pending = None;
            self.trades.replace(trade_id as u32, t);
        }
        let w = self.config.mandate.staking.as_ref().map(|r| r.wrap_index as usize).unwrap_or(0);
        if ok {
            self.held[w] += amount.0;
            event("stake_failed", json!({"trade_id": trade_id, "rewrapped": amount}));
        } else {
            // The NEAR came back to the fund's account but could not be wrapped; it stays reserved
            // (excluded from free NEAR) and anyone can retry with `rewrap_stranded`.
            self.stranded_near += amount.0;
            event("near_stranded", json!({"amount": amount}));
        }
    }

    /// Anyone. Wrap NEAR left over from a failed stake back into wNEAR, as fund holdings.
    pub fn rewrap_stranded(&mut self) {
        require!(self.stranded_near > 0, "nothing stranded");
        let amount = self.stranded_near;
        // free_near() already excludes the stranded NEAR: what is left must still cover the reserve.
        require!(self.free_near() >= NEAR_RESERVE, "the stranded NEAR is not in the account");
        self.stranded_near = 0;
        self.flux += 1;
        let w = self.config.mandate.staking.as_ref().map(|r| r.wrap_index as usize).unwrap_or(0);
        let p = call(&self.config.mandate.tokens[w], "near_deposit", json!({}), amount, GAS_WRAP);
        then_self(p, "on_rewrapped", json!({"trade_id": u64::MAX, "amount": U128(amount)}), GAS_CALLBACK);
    }

    /// Anyone, a day after a stake was sent and still `Sending` (a callback ran out of gas): close
    /// it as failed. If the account's free NEAR has grown by the stake since it started, the NEAR
    /// came back: it becomes `stranded_near`, which `rewrap_stranded` wraps into holdings. The
    /// fund's own NEAR is never mistaken for it. Trading can then continue.
    pub fn recover_stuck_stake(&mut self) {
        let id = self.pending.unwrap_or_else(|| env::panic_str("no trade in flight"));
        let mut t = self.trades[id as u32].clone();
        require!(t.stake && t.status == TradeStatus::Sending, "no stake is stuck");
        require!(now_seconds() > t.sent_at + STUCK_STAKE_SECONDS, "too early to recover this stake");
        let tolerance = NEAR_RESERVE.min(t.amount_in.0 / 2);
        let present = self.raw_free_near().saturating_sub(self.stranded_near) >= self.stake_near_before.saturating_add(t.amount_in.0 - tolerance);
        self.near_in_flight = 0;
        if present {
            self.stranded_near += t.amount_in.0;
        }
        t.status = TradeStatus::Failed;
        t.closed_at = Some(now_seconds());
        self.pending = None;
        self.flux += 1;
        event("stake_recovered", json!({"trade_id": id, "stranded": present}));
        self.trades.replace(id as u32, t);
    }

    /// Anyone, a day after a swap was sent and still `Sending` (its callback never ran): treat the
    /// input as sent. If the output then arrives the trade settles; if the input never left, it is
    /// still in the fund's balance and `settle_refund` counts it back.
    pub fn recover_stuck_trade(&mut self) {
        let id = self.pending.unwrap_or_else(|| env::panic_str("no trade in flight"));
        let mut t = self.trades[id as u32].clone();
        require!(!t.stake && t.status == TradeStatus::Sending, "no swap is stuck");
        require!(now_seconds() > t.sent_at + STUCK_TRADE_SECONDS, "too early to recover this trade");
        t.status = TradeStatus::Sent;
        self.flux += 1;
        self.close_if_delivered(&mut t);
        self.trades.replace(id as u32, t);
    }

    // ------------------------------------------------------------------ strategy (no manager)

    /// Anyone. Ask the fund's strategy program for a proposal. Attach the NEAR OutLayer charges for
    /// the run (what is not used is refunded to the caller by OutLayer) and 300 TGas. The answer is
    /// treated exactly like an operator's proposal: a trade must carry a 1Click-signed quote inside
    /// the mandate, a stake must pass the staking checks, anything else is a hold.
    #[payable]
    pub fn rebalance(&mut self) {
        let s = self.config.mandate.strategy.clone().unwrap_or_else(|| env::panic_str("this fund has no strategy"));
        let now = now_seconds();
        require!(env::attached_deposit().as_yoctonear() > 0, "attach NEAR for the strategy run");
        require!(env::prepaid_gas() >= Gas::from_tgas(295), "attach 300 TGas");
        require!(self.strategy_started == 0 || now > self.strategy_started + STRATEGY_TIMEOUT_SECONDS, "a strategy run is in flight");
        if let Err(e) = self.check_timing() {
            env::panic_str(&e);
        }
        let m = &self.config.mandate;
        let input = json!({
            "fund": env::current_account_id(),
            "now": now,
            "next_trade_id": self.trades.len(),
            "tokens": m.tokens,
            "held": self.held.iter().map(|h| U128(*h)).collect::<Vec<_>>(),
            "total_shares": U128(self.total_shares),
            "max_trade_bps": m.max_trade_bps,
            "max_cost_bps": m.max_cost_bps,
            "staking": m.staking,
        });
        let mut args = json!({
            "source": {"WasmUrl": {"url": s.wasm_url, "hash": s.wasm_hash, "build_target": "wasm32-wasip2"}},
            "resource_limits": {"max_instructions": s.max_instructions, "max_memory_mb": 128, "max_execution_seconds": s.max_execution_seconds},
            "input_data": input.to_string(),
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        if let (Some(profile), Some(owner)) = (&s.secrets_profile, &s.secrets_owner) {
            args["secrets_ref"] = json!({"profile": profile, "account_id": owner});
        }
        self.strategy_started = now;
        event("strategy_requested", json!({"by": env::predecessor_account_id()}));
        let p = call(&s.outlayer, "request_execution", args, env::attached_deposit().as_yoctonear(), GAS_REQUEST_EXECUTION);
        env::promise_return(then_self(p, "on_strategy", json!({}), GAS_ON_STRATEGY));
    }

    /// The strategy's answer: `{"action":"trade","quote":"<1Click response>"}`,
    /// `{"action":"stake","amount":"<units>"}` or anything else (hold). Returns what was done.
    #[private]
    pub fn on_strategy(&mut self) -> String {
        self.strategy_started = 0;
        let answer = env::promise_result_checked(0, 16_384).ok().and_then(|b| near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&b).ok());
        let Some(d) = answer.filter(|d| d.is_object()) else {
            event("strategy_hold", json!({"reason": "no answer"}));
            return "hold".into();
        };
        // Timing may have changed while the program ran; the same checks run again inside.
        match d["action"].as_str() {
            Some("trade") => match d["quote"].as_str() {
                Some(q) => if self.propose(q) { "trade".into() } else { "refused".into() },
                None => {
                    self.refuse("the strategy's trade has no quote".into(), None);
                    "refused".into()
                }
            },
            Some("stake") => match d["amount"].as_str().and_then(|a| a.parse::<u128>().ok()) {
                Some(a) => if self.stake(U128(a)) { "stake".into() } else { "refused".into() },
                None => {
                    self.refuse("the strategy's stake has no amount".into(), None);
                    "refused".into()
                }
            },
            _ => {
                let reason: String = d["reason"].as_str().unwrap_or("").chars().take(200).collect();
                event("strategy_hold", json!({"reason": reason}));
                "hold".into()
            }
        }
    }

    // ------------------------------------------------------------------ fee

    /// Anyone. Mint the management fee accrued since the last accrual to the operator.
    pub fn accrue(&mut self) {
        self.accrue_fee();
    }

    fn accrue_fee(&mut self) {
        let m = &self.config.mandate;
        let now = env::block_timestamp();
        let from = self.fee_accrued_at.max(m.subscription_closes_at.saturating_mul(1_000_000_000));
        if now <= from {
            return;
        }
        if m.management_fee_bps == 0 || self.total_shares == 0 {
            self.fee_accrued_at = now;
            return;
        }
        // The operator ends up with bps * dt / year of the fund: mint s with s / (total + s) = f.
        let dt = ((now - from) as u128).min(YEAR_NANOS);
        let bps = m.management_fee_bps as u128;
        let minted = mul_div(self.total_shares, bps * dt, 10_000 * YEAR_NANOS - bps * dt).unwrap_or(0);
        if minted == 0 {
            // Too little time for a whole share: keep the clock where it was, so frequent calls
            // cannot round the fee away.
            return;
        }
        // Advance the clock only by the time these whole shares pay for (s / (total + s) =
        // bps * t / year), so the fraction left over carries into the next accrual.
        // Rounded up by one nanosecond, so rounding always favours depositors.
        let used = mul_div(minted, 10_000 * YEAR_NANOS, bps * (self.total_shares + minted)).map_or(dt, |t| t + 1).min(dt);
        self.fee_accrued_at = from + used as u64;
        let op = self.config.operator.clone();
        let s = self.shares.get(&op).copied().unwrap_or(0);
        self.shares.insert(op.clone(), s + minted);
        self.total_shares += minted;
        event("fee_accrued", json!({"operator": op, "shares": U128(minted), "seconds": (used / 1_000_000_000) as u64}));
    }

    fn check_trade(&self, raw: &str) -> Result<Trade, (String, Option<String>)> {
        let m = &self.config.mandate;
        let now = now_seconds();
        self.check_timing().map_err(|e| (e, None))?;
        let q = quote::verify_quote(raw, &self.signer_key).map_err(|e| (e, None))?;
        let dep = Some(q.deposit_address.to_string());
        let fail = |r: String| Err((r, dep.clone()));
        let me = env::current_account_id();
        if q.recipient != me.as_str() || q.refund_to != me.as_str() || q.refund_type != "ORIGIN_CHAIN" {
            return fail("quote must deliver to and refund to this fund on NEAR".into());
        }
        // 1Click must deliver with ft_transfer_call and this exact message, so the output is
        // counted when it arrives and never from a balance read.
        let want = format!("trade:{}", self.trades.len());
        if q.custom_recipient_msg.as_deref() != Some(want.as_str()) {
            return fail(format!("quote must set customRecipientMsg to \"{want}\""));
        }
        if let Some(f) = &q.unsupported_field {
            return fail(format!("{f} is not supported"));
        }
        let idx = |asset: &str| asset.strip_prefix("nep141:").and_then(|a| m.tokens.iter().position(|t| t.as_str() == a));
        let (Some(sell), Some(buy)) = (idx(&q.origin_asset), idx(&q.destination_asset)) else {
            return fail(format!("{} -> {} is not allowed by the mandate", q.origin_asset, q.destination_asset));
        };
        if sell == buy {
            return fail("cannot trade a token for itself".into());
        }
        if !self.registered[sell] || !self.registered[buy] {
            return fail("the fund is not registered on one of these tokens".into());
        }
        if q.amount_in == 0 || q.min_amount_out == 0 || q.min_amount_out > q.amount_out {
            return fail("quote amounts are not usable".into());
        }
        let held = self.held[sell];
        if q.amount_in > mul_div(held, m.max_trade_bps as u128, 10_000).unwrap_or(0) {
            return fail(format!("trade of {} is over {} bps of the {} held", q.amount_in, m.max_trade_bps, held));
        }
        let cost = cost_bps(&q).ok_or(("quote has no usable USD marks".to_string(), dep.clone()))?;
        if cost > m.max_cost_bps as u128 {
            return fail(format!("all-in cost {} bps is over the mandate's {} bps", cost, m.max_cost_bps));
        }
        if q.issued_seconds > now + 60 || now - q.issued_seconds.min(now) > m.max_quote_age_seconds {
            return fail(format!("quote is {} s old; the mandate allows {} s", now.saturating_sub(q.issued_seconds), m.max_quote_age_seconds));
        }
        if q.deadline_seconds < now + m.min_deadline_margin_seconds {
            return fail("the quote's deposit address closes too soon".into());
        }
        if self.used_deposit_addresses.contains(&q.deposit_address) {
            return fail("this deposit address was already used".into());
        }
        let available = self.free_near();
        if available < self.config.storage_deposit.0 + NEAR_RESERVE {
            return fail("the fund has no NEAR left to register the deposit address".into());
        }
        Ok(Trade {
            id: self.trades.len() as u64,
            stake: false,
            sell: sell as u8,
            buy: buy as u8,
            amount_in: U128(q.amount_in),
            quoted_out: U128(q.amount_out),
            min_out: U128(q.min_amount_out),
            refund_fee: U128(q.refund_fee),
            cost_bps: cost as u16,
            deposit_address: q.deposit_address,
            deposit_deadline: q.deadline_seconds,
            sent_at: now,
            status: TradeStatus::Sending,
            received_out: U128(0),
            received_refund: U128(0),
            closed_at: None,
        })
    }

    fn send_trade(&mut self, t: Trade) {
        let token = self.config.mandate.tokens[t.sell as usize].clone();
        self.start_trade(&t);
        self.used_deposit_addresses.insert(t.deposit_address.clone());
        event("trade_sent", json!({"trade": &t}));
        // Register the deposit address on the token and transfer to it in ONE receipt: the actions
        // of a batch succeed or fail together.
        let batch = env::promise_batch_create(&token);
        env::promise_batch_action_function_call(
            batch,
            "storage_deposit",
            json!({"account_id": t.deposit_address, "registration_only": true}).to_string().as_bytes(),
            NearToken::from_yoctonear(self.config.storage_deposit.0),
            GAS_STORAGE_DEPOSIT,
        );
        env::promise_batch_action_function_call(
            batch,
            "ft_transfer",
            json!({"receiver_id": t.deposit_address, "amount": t.amount_in, "memo": format!("plinth trade {}", t.id)}).to_string().as_bytes(),
            ONE_YOCTO,
            GAS_FT_TRANSFER,
        );
        then_self(batch, "on_trade_sent", json!({"trade_id": t.id}), GAS_CALLBACK);
        self.trades.push(t);
    }

    #[private]
    pub fn on_trade_sent(&mut self, trade_id: u64) {
        let mut t = self.trades[trade_id as u32].clone();
        self.flux += 1;
        if promise_ok() {
            t.status = TradeStatus::Sent;
            self.close_if_delivered(&mut t);
        } else {
            // Nothing left the fund: restore it.
            self.held[t.sell as usize] += t.amount_in.0;
            t.status = TradeStatus::Failed;
            t.closed_at = Some(now_seconds());
            self.pending = None;
            event("trade_failed", json!({"trade_id": trade_id}));
        }
        self.trades.replace(trade_id as u32, t);
    }

    /// Anyone, at least REFUND_WAIT_SECONDS after a swap was sent with no output: check whether
    /// 1Click refunded it. A refund is a plain transfer, so this reads the fund's balance of the
    /// token sold; if it holds at least `amount_in - refund_fee` more than the fund accounts for,
    /// exactly that amount is counted and the trade closes as `Refunded`. Counted once per trade,
    /// and taken back if the output arrives after all.
    pub fn settle_refund(&mut self, trade_id: u64) {
        let t = self.refundable(trade_id).unwrap_or_else(|e| env::panic_str(e));
        let token = &self.config.mandate.tokens[t.sell as usize];
        let p = call(token, "ft_balance_of", json!({"account_id": env::current_account_id()}), 0, GAS_FT_BALANCE);
        env::promise_return(then_self(p, "on_settle_refund", json!({"trade_id": trade_id, "flux": self.flux}), GAS_CALLBACK));
    }

    fn refundable(&self, trade_id: u64) -> Result<Trade, &'static str> {
        let t = self.trades.get(trade_id as u32).ok_or("no such trade")?.clone();
        if t.stake || !matches!(t.status, TradeStatus::Sent | TradeStatus::Abandoned) || t.received_refund.0 > 0 {
            return Err("this trade is not waiting for a refund");
        }
        if now_seconds() < t.sent_at + REFUND_WAIT_SECONDS {
            return Err("a refund can be counted an hour after the trade was sent");
        }
        // Nothing of the fund's may be on its way out or in while the balance is read.
        if self.near_in_flight > 0 || self.pending.map_or(false, |id| self.trades[id as u32].status == TradeStatus::Sending) {
            return Err("another trade is being sent; try again shortly");
        }
        Ok(t)
    }

    #[private]
    pub fn on_settle_refund(&mut self, trade_id: u64, flux: u64, #[callback_result] balance: Result<U128, PromiseError>) -> TradeStatus {
        let status = self.trades[trade_id as u32].status.clone();
        let Ok(mut t) = self.refundable(trade_id) else { return status };
        if flux != self.flux {
            env::log_str("tokens moved while the balance was read; try again");
            return status;
        }
        let Ok(bal) = balance else {
            env::log_str("could not read the balance; try again");
            return status;
        };
        let s = t.sell as usize;
        let back = bal.0.saturating_sub(self.accounted(s));
        let refund = t.amount_in.0.saturating_sub(t.refund_fee.0);
        if refund == 0 || back < refund {
            env::log_str(&format!("trade {trade_id}: {back} back, a refund would be {refund}"));
            return status;
        }
        self.held[s] += refund;
        self.flux += 1;
        t.received_refund = U128(refund);
        t.status = TradeStatus::Refunded;
        t.closed_at = Some(now_seconds());
        if self.pending == Some(trade_id) {
            self.pending = None;
        }
        event("trade_closed", json!({"trade": &t}));
        self.trades.replace(trade_id as u32, t);
        TradeStatus::Refunded
    }

    /// Anyone, after the trade's deposit address has been expired for ABANDON_AFTER_SECONDS with
    /// neither output nor refund: write the trade off so trading can continue.
    pub fn abandon(&mut self) {
        let id = self.pending.unwrap_or_else(|| env::panic_str("no trade in flight"));
        let mut t = self.trades[id as u32].clone();
        require!(t.status == TradeStatus::Sent, "the trade is still being sent");
        require!(now_seconds() > t.deposit_deadline + ABANDON_AFTER_SECONDS, "too early to write this trade off");
        t.status = TradeStatus::Abandoned;
        t.closed_at = Some(now_seconds());
        self.pending = None;
        event("trade_abandoned", json!({"trade_id": id}));
        self.trades.replace(id as u32, t);
    }

    /// Anyone. Retry the fund's own registration on a token if it failed at launch.
    pub fn register(&mut self, token_index: u8) {
        let i = token_index as usize;
        require!(i < self.registered.len(), "no such token");
        require!(!self.registered[i], "already registered");
        let per = self.config.storage_deposit.0;
        require!(self.free_near() >= NEAR_RESERVE + per, "the fund has no NEAR left for a registration");
        let p = call(&self.config.mandate.tokens[i], "storage_deposit", json!({"account_id": env::current_account_id(), "registration_only": true}), per, GAS_STORAGE_DEPOSIT);
        then_self(p, "on_registered", json!({"token_index": token_index}), GAS_CALLBACK);
    }

    // ------------------------------------------------------------------ exit

    /// Burn `shares` and receive the same fraction of every token the fund holds, in kind. Needs
    /// no operator, price or oracle. While a trade is in flight (at most REDEEM_WAIT_SECONDS) the
    /// call waits; after that a redeemer may leave without their share of that one trade.
    pub fn redeem(&mut self, shares: U128) {
        self.accrue_fee();
        let who = env::predecessor_account_id();
        let mine = self.shares.get(&who).copied().unwrap_or(0);
        require!(shares.0 > 0 && shares.0 <= mine, "not enough shares");
        if let Some(id) = self.pending {
            let t = &self.trades[id as u32];
            require!(now_seconds() >= t.sent_at + REDEEM_WAIT_SECONDS, "a trade is in flight; settle it or wait up to 10 minutes");
        }
        let total = self.total_shares;
        let mut paid = Vec::new();
        for i in 0..self.held.len() {
            let amount = mul_div(self.held[i], shares.0, total).unwrap_or_else(|| env::panic_str("overflow"));
            if amount > 0 {
                self.held[i] -= amount;
                paid.push((i, amount));
            }
        }
        let left = mine - shares.0;
        if left == 0 && !(who == self.config.operator && self.config.mandate.management_fee_bps > 0) {
            // Frees the entry's storage. The operator's entry stays: fee shares need it later.
            self.shares.remove(&who);
        } else {
            self.shares.insert(who.clone(), left);
        }
        self.total_shares -= shares.0;
        if now_seconds() < self.config.mandate.subscription_closes_at {
            // Leaving during the window frees room under the subscription cap again.
            self.total_subscribed -= shares.0;
        }
        event("redeemed", json!({"account_id": who, "shares": shares, "paid": paid.iter().map(|(i, a)| json!({"token": self.config.mandate.tokens[*i], "amount": U128(*a)})).collect::<Vec<_>>()}));
        for (i, amount) in paid {
            self.pay(who.clone(), i, amount);
        }
    }

    /// Retry payouts whose transfer failed (e.g. after registering on the token). `amounts`, one
    /// per token, claims part of what is owed; without it everything owed is paid.
    pub fn claim(&mut self, amounts: Option<Vec<U128>>) {
        let who = env::predecessor_account_id();
        let mut owed = self.owed.get(&who).cloned().unwrap_or_else(|| env::panic_str("nothing owed"));
        for i in 0..owed.len() {
            let want = amounts.as_ref().map_or(owed[i], |a| a.get(i).map_or(0, |x| x.0.min(owed[i])));
            if want > 0 {
                // Out of the claimable set before paying: a second claim finds nothing until this
                // payout fails again.
                owed[i] -= want;
                self.owed_total[i] -= want;
                self.pay(who.clone(), i, want);
            }
        }
        if owed.iter().all(|x| *x == 0) {
            self.owed.remove(&who);
        } else {
            self.owed.insert(who, owed);
        }
    }

    /// Payouts in flight are tracked per token only, never as claimable, so they can be paid once.
    fn pay(&mut self, to: AccountId, i: usize, amount: u128) {
        self.in_flight[i] += amount;
        self.flux += 1;
        let p = call(&self.config.mandate.tokens[i], "ft_transfer", json!({"receiver_id": to, "amount": U128(amount), "memo": "plinth redemption"}), 1, GAS_FT_TRANSFER);
        then_self(p, "on_payout", json!({"account_id": to, "token_index": i as u8, "amount": U128(amount)}), GAS_CALLBACK);
    }

    #[private]
    pub fn on_payout(&mut self, account_id: AccountId, token_index: u8, amount: U128) {
        let i = token_index as usize;
        self.in_flight[i] -= amount.0;
        self.flux += 1;
        if !promise_ok() {
            // Becomes claimable; the redeemer can `claim` it later.
            let mut v = self.owed.get(&account_id).cloned().unwrap_or_else(|| vec![0; self.held.len()]);
            v[i] += amount.0;
            self.owed.insert(account_id.clone(), v);
            self.owed_total[i] += amount.0;
            event("payout_failed", json!({"account_id": account_id, "token": self.config.mandate.tokens[i], "amount": amount}));
        }
    }

    #[private]
    pub fn on_registered(&mut self, token_index: u8) {
        self.registered[token_index as usize] = promise_ok();
    }

    /// What of token i the fund's balance must cover: holdings, claimable failed payouts, payouts
    /// in flight, and joiners' baskets.
    fn accounted(&self, i: usize) -> u128 {
        self.held[i] + self.owed_total[i] + self.in_flight[i] + self.basket_total[i]
    }

    /// Account balance above its storage cost.
    fn raw_free_near(&self) -> u128 {
        env::account_balance().as_yoctonear().saturating_sub(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear())
    }

    /// NEAR the fund may spend on storage: excludes a stake's NEAR in transit and stranded NEAR.
    fn free_near(&self) -> u128 {
        self.raw_free_near().saturating_sub(self.near_in_flight + self.stranded_near)
    }

    // ------------------------------------------------------------------ views

    pub fn get_fund(&self) -> FundView {
        let now = now_seconds();
        let m = &self.config.mandate;
        FundView {
            config: self.config.clone(),
            held: m.tokens.iter().cloned().zip(self.held.iter().map(|h| U128(*h))).collect(),
            total_shares: U128(self.total_shares),
            total_subscribed: U128(self.total_subscribed),
            subscription_open: now < m.subscription_closes_at,
            trading_open: now >= m.subscription_closes_at,
            pending: self.pending.map(|id| self.trades[id as u32].clone()),
            trades: self.trades.len() as u64,
            rejections: self.rejections.len(),
            last_trade_at: self.last_trade_at,
            near_available_for_registrations: U128(self.free_near().saturating_sub(NEAR_RESERVE)),
            in_flight_payouts: self.in_flight.iter().map(|x| U128(*x)).collect(),
            registered: self.registered.clone(),
            trades_today: if now / 86_400 == self.trade_day { self.trades_today } else { 0 },
            fee_accrued_at: self.fee_accrued_at / 1_000_000_000,
            stranded_near: U128(self.stranded_near),
            operator_shares: U128(self.shares.get(&self.config.operator).copied().unwrap_or(0)),
            version: VERSION.to_string(),
            owed_total: self.owed_total.iter().map(|x| U128(*x)).collect(),
            basket_total: self.basket_total.iter().map(|x| U128(*x)).collect(),
            near_free: U128(self.free_near()),
            strategy_started: self.strategy_started,
            max_daily_cost_bps: (m.max_trade_bps as u64 * m.max_cost_bps as u64 * m.max_trades_per_day as u64 / 10_000).min(10_000) as u32,
        }
    }

    pub fn get_shares(&self, account_id: AccountId) -> U128 {
        U128(self.shares.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_owed(&self, account_id: AccountId) -> Vec<U128> {
        self.owed.get(&account_id).map(|v| v.iter().map(|x| U128(*x)).collect()).unwrap_or_default()
    }

    pub fn get_basket(&self, account_id: AccountId) -> Option<Vec<U128>> {
        self.baskets.get(&account_id).map(|v| v.iter().map(|x| U128(*x)).collect())
    }

    pub fn get_trades(&self, from: u64, limit: u64) -> Vec<Trade> {
        (from..from.saturating_add(limit).min(self.trades.len() as u64)).map(|i| self.trades[i as u32].clone()).collect()
    }

    pub fn get_rejections(&self, from: u32, limit: u32) -> Vec<Rejection> {
        (from..from.saturating_add(limit).min(self.rejections.len())).map(|i| self.rejections[i].clone()).collect()
    }
}

#[cfg(test)]
mod tests;
