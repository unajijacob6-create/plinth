//! Plinth factory: anyone creates a fund with one call.
//!
//! The fund code is published once as a NEP-591 global contract **by hash**: the chain stores the
//! bytes under their sha256 and nobody, not even the publisher, can change what that hash runs.
//! `create_fund` makes two accounts, each in a single receipt (CreateAccount, Transfer,
//! UseGlobalContract(hash), FunctionCall): the fund `<name>.<factory>` (`new(config)`) and its
//! refund relay `<name>-r.<factory>` (`relay_init`), which runs the same code in relay mode and can
//! only hand refunds to that fund. There is no AddKey, so neither has an access key from its first
//! block, and the factory keeps no power over them: it only remembers the fund's name for the list.
//!
//! The factory itself is deployed without keys. The hash it uses is fixed at `new`.

use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise};

/// NEAR a new fund must start with, besides its token registrations: its own state storage and the
/// registrations of 1Click deposit addresses (0.00125 NEAR per trade).
pub const MIN_FUND_NEAR: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR
/// NEAR the refund relay starts with (its own small storage and the 1 yocto each hand-over costs).
pub const RELAY_NEAR: u128 = 30_000_000_000_000_000_000_000; // 0.03 NEAR
const GAS_RELAY_INIT: Gas = Gas::from_tgas(60);
/// Kept by the factory from each creation to pay for the fund's line in its list (the factory has
/// no keys, so nobody can top it up on its behalf later except by sending it NEAR).
pub const LIST_FEE: u128 = 3_000_000_000_000_000_000_000; // 0.003 NEAR
const GAS_NEW: Gas = Gas::from_tgas(150);
const GAS_ON_CREATED: Gas = Gas::from_tgas(20);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct FundEntry {
    pub account_id: AccountId,
    /// The fund's refund relay, created with it.
    pub relay: AccountId,
    pub creator: AccountId,
    pub created_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    code_hash: Base58CryptoHash,
    funds: Vector<FundEntry>,
}

#[near]
impl Factory {
    /// `code_hash`: sha256 (base58) of the published fund code every fund will run.
    #[init]
    pub fn new(code_hash: Base58CryptoHash) -> Self {
        Self { code_hash, funds: Vector::new(b"f") }
    }

    /// Create the keyless fund `<name>.<this factory>` with `config` (the fund's `new` argument).
    /// Attach at least 0.533 NEAR plus twice `storage_deposit` for each token: 0.03 NEAR and one set
    /// of registrations go to the fund's refund relay, 0.003 NEAR stays with the factory for the
    /// fund's line in its list, and the rest goes to the fund.
    /// If the fund cannot be created (name taken, config refused) the NEAR is sent back.
    #[payable]
    pub fn create_fund(&mut self, name: String, config: Value) -> Promise {
        require!(
            (2..=30).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-') && !name.ends_with('-'),
            "name: 2 to 30 of a-z, 0-9 and -"
        );
        let me = env::current_account_id();
        let fund: AccountId = format!("{name}.{me}").parse().unwrap_or_else(|_| env::panic_str("name does not make a valid account"));
        let relay: AccountId = format!("{name}-r.{me}").parse().unwrap_or_else(|_| env::panic_str("name does not make a valid account"));
        let mut config = config;
        require!(config.is_object(), "config must be an object");
        let tokens = config["mandate"]["tokens"].as_array().cloned().unwrap_or_default();
        let n = tokens.len() as u128;
        let per: u128 = config["storage_deposit"].as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("config.storage_deposit is missing"));
        let registrations = per.checked_mul(n).unwrap_or_else(|| env::panic_str("overflow"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(n > 0, "config.mandate.tokens is missing");
        let fixed = MIN_FUND_NEAR + RELAY_NEAR + LIST_FEE;
        require!(deposit >= fixed.saturating_add(registrations.saturating_mul(2)), "attach at least 0.533 NEAR plus twice storage_deposit for each token");
        // The relay is always the one made here, whatever the caller wrote.
        config["refund_relay"] = json!(relay);
        let creator = env::predecessor_account_id();
        let hash = CryptoHash::from(self.code_hash);
        let make_relay = Promise::new(relay.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(RELAY_NEAR))
            .use_global_contract(hash)
            .function_call(
                "relay_init".to_string(),
                json!({ "fund": fund, "tokens": tokens, "storage_deposit": per.to_string() }).to_string().into_bytes(),
                NearToken::from_yoctonear(registrations),
                GAS_RELAY_INIT,
            );
        let fund_near = deposit - registrations * 2 - RELAY_NEAR - LIST_FEE;
        let make_fund = Promise::new(fund.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(fund_near))
            .use_global_contract(hash)
            .function_call("new".to_string(), json!({ "config": config }).to_string().into_bytes(), NearToken::from_yoctonear(registrations), GAS_NEW);
        make_relay.and(make_fund).then(Self::ext(me).with_static_gas(GAS_ON_CREATED).on_created(
            fund,
            relay,
            creator,
            U128(RELAY_NEAR + registrations),
            U128(fund_near + registrations),
        ))
    }

    /// Both accounts must exist for the fund to be listed. Whatever was not created had its NEAR
    /// come back to the factory, and goes back to the creator.
    #[private]
    pub fn on_created(&mut self, fund: AccountId, relay: AccountId, creator: AccountId, relay_cost: U128, fund_cost: U128) -> Option<AccountId> {
        let ok = |i: u64| env::promise_results_count() == 2 && env::promise_result_checked(i, 1_024).is_ok();
        let (relay_ok, fund_ok) = (ok(0), ok(1));
        if relay_ok && fund_ok {
            let entry = FundEntry { account_id: fund.clone(), relay, creator, created_at: env::block_timestamp() / 1_000_000_000 };
            env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "plinth-factory", "version": "1.0.0", "event": "fund_created", "data": [&entry]})));
            self.funds.push(entry);
            return Some(fund);
        }
        let mut back = LIST_FEE;
        if !relay_ok {
            back += relay_cost.0;
        }
        if !fund_ok {
            back += fund_cost.0;
        }
        Promise::new(creator).transfer(NearToken::from_yoctonear(back)).detach();
        None
    }

    pub fn get_code_hash(&self) -> Base58CryptoHash {
        self.code_hash
    }

    pub fn fund_count(&self) -> u32 {
        self.funds.len()
    }

    /// Funds in creation order.
    pub fn get_funds(&self, from: u32, limit: u32) -> Vec<FundEntry> {
        (from..from.saturating_add(limit).min(self.funds.len())).map(|i| self.funds[i].clone()).collect()
    }
}
