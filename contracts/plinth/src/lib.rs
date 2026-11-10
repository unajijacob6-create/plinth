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
//! One trade is in flight at a time. Output (or a 1Click refund) arrives as a plain `ft_transfer`,
//! which does not call the fund, so anyone can call `settle()`; it reads the fund's token balances
//! and closes the trade.

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

/// Whether the single promise this callback waits on succeeded, whatever it returned.
fn promise_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 16_384).is_ok()
}

/// a * b / d with a 256-bit intermediate; None if d is 0 or the result does not fit in u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
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
    Some(q)
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
}

/// The rules, fixed at launch.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    /// NEP-141 tokens the fund may hold, deposit and trade. `tokens[0]` is the base token
    /// (subscriptions are in it). At most 8.
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
}

/// How the fund stakes wNEAR: `tokens[wrap_index]` must be a wNEAR contract (`near_withdraw`,
/// `near_deposit`) and `tokens[lst_index]` a liquid-staking token that mints for attached NEAR
/// (`deposit_and_stake`) and reports its price in yocto-NEAR per 1e24 units (`price_method`, e.g.
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
    /// Filled when the trade closes: what came back of each token.
    pub received_out: U128,
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
    /// Count of resolved payouts; a balance read is ignored if a payout resolved meanwhile.
    payouts_resolved: u64,
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
            payouts_resolved: 0,
            registered: vec![false; n],
            trade_day: 0,
            trades_today: 0,
            fee_accrued_at: 0,
            stranded_near: 0,
            near_in_flight: 0,
            used_deposit_addresses: LookupSet::new(StorageKey::UsedDepositAddresses),
            trades: Vector::new(StorageKey::Trades),
            pending: None,
            last_trade_at: 0,
            rejections: Vector::new(StorageKey::Rejections),
        }
    }

    // ------------------------------------------------------------------ subscribe

    /// NEP-141 receiver. Subscriptions: `ft_transfer_call` of the base token to the fund while
    /// the subscription window is open, any `msg`. Everything else is returned.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = msg;
        let token = env::predecessor_account_id();
        let m = &self.config.mandate;
        if token != m.tokens[0] {
            // Not the base token (or not a token at all): hand it back. Outputs of trades arrive
            // by plain ft_transfer, not here.
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
        // Before trading starts the fund holds only base units it accounts for, 1 share each.
        let s = self.shares.get(&sender_id).copied().unwrap_or(0);
        self.shares.insert(sender_id.clone(), s + amount.0);
        self.total_shares += amount.0;
        self.total_subscribed += amount.0;
        self.held[0] += amount.0;
        event("subscribed", json!({"account_id": sender_id, "amount": amount, "shares": amount}));
        U128(0)
    }

    // ------------------------------------------------------------------ trade

    /// Operator only. Propose a swap with a live 1Click quote (the full JSON response). Returns
    /// true when the trade was sent. A quote that breaks the mandate is refused and recorded
    /// (with its reason) instead of panicking, so refusals are visible on chain.
    pub fn propose_trade(&mut self, quote: String) -> bool {
        require!(env::predecessor_account_id() == self.config.operator, "only the operator can propose trades");
        self.accrue_fee();
        match self.check_trade(&quote) {
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
    /// then anyone `settle`s once the minted tokens show in the fund's balance. Counts as a trade for
    /// the size cap, cooldown and daily limit. If staking fails the NEAR is wrapped back.
    pub fn stake_idle(&mut self, amount: U128) -> bool {
        require!(env::predecessor_account_id() == self.config.operator, "only the operator can stake");
        let r = self.config.mandate.staking.clone().unwrap_or_else(|| env::panic_str("this fund has no staking route"));
        self.accrue_fee();
        let (w, l) = (r.wrap_index as usize, r.lst_index as usize);
        let why = self.check_timing().err().or_else(|| {
            let held = self.held[w];
            if amount.0 < r.min_stake.0 {
                Some(format!("stake of {} is below the minimum {}", amount.0, r.min_stake.0))
            } else if amount.0.checked_mul(10_000).map_or(true, |x| x > held * self.config.mandate.max_trade_bps as u128) {
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
        if promise_ok() {
            let mut t = self.trades[trade_id as u32].clone();
            t.status = TradeStatus::Sent; // anyone can now `settle` it against the minted balance
            self.trades.replace(trade_id as u32, t);
            self.near_in_flight = 0;
        } else {
            self.rewrap(trade_id);
        }
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
        let w = self.config.mandate.staking.as_ref().map(|r| r.wrap_index as usize).unwrap_or(0);
        let p = call(&self.config.mandate.tokens[w], "near_deposit", json!({}), amount, GAS_WRAP);
        then_self(p, "on_rewrapped", json!({"trade_id": u64::MAX, "amount": U128(amount)}), GAS_CALLBACK);
    }

    /// Anyone, a day after a stake was sent and still `Sending` (a callback ran out of gas or
    /// balance): close it as failed. If its NEAR is in the account it becomes `stranded_near`, which
    /// `rewrap_stranded` wraps back; if it reached the staking contract, `absorb` counts what was
    /// minted. Trading can then continue.
    pub fn recover_stuck_stake(&mut self) {
        let id = self.pending.unwrap_or_else(|| env::panic_str("no trade in flight"));
        let mut t = self.trades[id as u32].clone();
        require!(t.stake && t.status == TradeStatus::Sending, "no stake is stuck");
        require!(now_seconds() > t.sent_at + STUCK_STAKE_SECONDS, "too early to recover this stake");
        let present = self.raw_free_near().saturating_sub(self.stranded_near) >= t.amount_in.0;
        self.near_in_flight = 0;
        if present {
            self.stranded_near += t.amount_in.0;
        }
        t.status = TradeStatus::Failed;
        t.closed_at = Some(now_seconds());
        self.pending = None;
        event("stake_recovered", json!({"trade_id": id, "stranded": present}));
        self.trades.replace(id as u32, t);
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
        if q.has_custom_recipient_msg {
            return fail("customRecipientMsg is not allowed".into());
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
        if q.amount_in.checked_mul(10_000).map_or(true, |x| x > held * m.max_trade_bps as u128) {
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
        if promise_ok() {
            t.status = TradeStatus::Sent;
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

    /// Anyone. Read the fund's balance of the two tokens of the trade in flight and close it if
    /// the output (at least `min_out`) or a refund (at least `amount_in - refund_fee`) arrived.
    pub fn settle(&mut self) {
        let id = self.pending.unwrap_or_else(|| env::panic_str("no trade in flight"));
        let t = &self.trades[id as u32];
        require!(t.status == TradeStatus::Sent, "the trade is still being sent");
        let tokens = &self.config.mandate.tokens;
        let me = env::current_account_id();
        let p1 = call(&tokens[t.buy as usize], "ft_balance_of", json!({"account_id": me}), 0, GAS_FT_BALANCE);
        let p2 = call(&tokens[t.sell as usize], "ft_balance_of", json!({"account_id": me}), 0, GAS_FT_BALANCE);
        let both = env::promise_and(&[p1, p2]);
        env::promise_return(then_self(both, "on_settle", json!({"trade_id": id, "payouts_resolved": self.payouts_resolved}), GAS_CALLBACK));
    }

    #[private]
    pub fn on_settle(
        &mut self,
        trade_id: u64,
        payouts_resolved: u64,
        #[callback_result] buy_balance: Result<U128, PromiseError>,
        #[callback_result] sell_balance: Result<U128, PromiseError>,
    ) -> TradeStatus {
        let mut t = self.trades[trade_id as u32].clone();
        if self.pending != Some(trade_id) || t.status != TradeStatus::Sent {
            return t.status; // closed by a concurrent settle
        }
        if payouts_resolved != self.payouts_resolved {
            env::log_str("a payout resolved while balances were read; settle again");
            return t.status;
        }
        let (Ok(buy_bal), Ok(sell_bal)) = (buy_balance, sell_balance) else {
            env::log_str("could not read balances; try again");
            return t.status;
        };
        let (b, s) = (t.buy as usize, t.sell as usize);
        let out = buy_bal.0.saturating_sub(self.accounted(b));
        let back = sell_bal.0.saturating_sub(self.accounted(s));
        let refund_floor = t.amount_in.0.saturating_sub(t.refund_fee.0);
        let status = if out >= t.min_out.0 {
            TradeStatus::Settled
        } else if back >= refund_floor && back > 0 {
            TradeStatus::Refunded
        } else {
            env::log_str(&format!("trade {trade_id} not settled yet: {out} of {} out, {back} back", t.min_out.0));
            return t.status;
        };
        // Everything above what the fund accounts for is the fund's (output, refund, excess
        // refunds, or donations).
        self.held[b] += out;
        self.held[s] += back;
        t.received_out = U128(out);
        t.received_refund = U128(back);
        t.status = status.clone();
        t.closed_at = Some(now_seconds());
        self.pending = None;
        event("trade_closed", json!({"trade": &t}));
        self.trades.replace(trade_id as u32, t);
        status
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

    /// Anyone, with no trade in flight: count tokens that reached the fund outside a trade
    /// (donations, late refunds of an abandoned trade) as the fund's.
    pub fn absorb(&mut self, token_index: u8) {
        require!(self.pending.is_none(), "settle the trade in flight first");
        let token = self.config.mandate.tokens.get(token_index as usize).unwrap_or_else(|| env::panic_str("no such token")).clone();
        let p = call(&token, "ft_balance_of", json!({"account_id": env::current_account_id()}), 0, GAS_FT_BALANCE);
        env::promise_return(then_self(p, "on_absorb", json!({"token_index": token_index, "payouts_resolved": self.payouts_resolved}), GAS_CALLBACK));
    }

    #[private]
    pub fn on_absorb(&mut self, token_index: u8, payouts_resolved: u64, #[callback_result] balance: Result<U128, PromiseError>) -> U128 {
        let i = token_index as usize;
        let Ok(bal) = balance else { return U128(0) };
        if self.pending.is_some() || payouts_resolved != self.payouts_resolved {
            return U128(0);
        }
        let extra = bal.0.saturating_sub(self.accounted(i));
        self.held[i] += extra;
        if extra > 0 {
            event("absorbed", json!({"token": self.config.mandate.tokens[i], "amount": U128(extra)}));
        }
        U128(extra)
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
        self.shares.insert(who.clone(), mine - shares.0);
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

    /// Retry payouts of a redemption whose transfer failed (e.g. after registering on the token).
    pub fn claim(&mut self) {
        let who = env::predecessor_account_id();
        let owed = self.owed.remove(&who).unwrap_or_else(|| env::panic_str("nothing owed"));
        for (i, amount) in owed.into_iter().enumerate() {
            if amount > 0 {
                // Out of the claimable set before paying: a second claim finds nothing until this
                // payout fails again.
                self.owed_total[i] -= amount;
                self.pay(who.clone(), i, amount);
            }
        }
    }

    /// Payouts in flight are tracked per token only, never as claimable, so they can be paid once.
    fn pay(&mut self, to: AccountId, i: usize, amount: u128) {
        self.in_flight[i] += amount;
        let p = call(&self.config.mandate.tokens[i], "ft_transfer", json!({"receiver_id": to, "amount": U128(amount), "memo": "plinth redemption"}), 1, GAS_FT_TRANSFER);
        then_self(p, "on_payout", json!({"account_id": to, "token_index": i as u8, "amount": U128(amount)}), GAS_CALLBACK);
    }

    #[private]
    pub fn on_payout(&mut self, account_id: AccountId, token_index: u8, amount: U128) {
        let i = token_index as usize;
        self.in_flight[i] -= amount.0;
        self.payouts_resolved += 1;
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

    /// What of token i the fund's balance must cover besides new arrivals: holdings, claimable
    /// failed payouts, and payouts in flight.
    fn accounted(&self, i: usize) -> u128 {
        self.held[i] + self.owed_total[i] + self.in_flight[i]
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
        }
    }

    pub fn get_shares(&self, account_id: AccountId) -> U128 {
        U128(self.shares.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_owed(&self, account_id: AccountId) -> Vec<U128> {
        self.owed.get(&account_id).map(|v| v.iter().map(|x| U128(*x)).collect()).unwrap_or_default()
    }

    pub fn get_trades(&self, from: u64, limit: u64) -> Vec<Trade> {
        (from..(from + limit).min(self.trades.len() as u64)).map(|i| self.trades[i as u32].clone()).collect()
    }

    pub fn get_rejections(&self, from: u32, limit: u32) -> Vec<Rejection> {
        (from..(from + limit).min(self.rejections.len())).map(|i| self.rejections[i].clone()).collect()
    }
}

#[cfg(test)]
mod tests;
