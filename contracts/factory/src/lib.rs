//! Plinth factory: anyone creates a fund with one call.
//!
//! The fund code is published once as a NEP-591 global contract **by hash**: the chain stores the
//! bytes under their sha256 and nobody, not even the publisher, can change what that hash runs.
//! `create_fund` makes `<name>.<factory>` in a single receipt: CreateAccount, Transfer,
//! UseGlobalContract(hash), FunctionCall `new(config)`. There is no AddKey, so the fund has no
//! access key from its first block, and the factory keeps no power over it: it only remembers the
//! fund's name for the list.
//!
//! The factory itself is deployed without keys. The hash it uses is fixed at `new`.

use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise};

/// NEAR a new fund must start with, besides its token registrations: its own state storage and the
/// registrations of 1Click deposit addresses (0.00125 NEAR per trade).
pub const MIN_FUND_NEAR: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR
const GAS_NEW: Gas = Gas::from_tgas(150);
const GAS_ON_CREATED: Gas = Gas::from_tgas(20);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct FundEntry {
    pub account_id: AccountId,
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
    /// Attach at least 0.5 NEAR plus `storage_deposit` for each token; all of it goes to the fund.
    /// If the fund cannot be created (name taken, config refused) the NEAR is sent back.
    #[payable]
    pub fn create_fund(&mut self, name: String, config: Value) -> Promise {
        require!(
            (2..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-') && !name.ends_with('-'),
            "name: 2 to 32 of a-z, 0-9 and -"
        );
        let fund: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("name does not make a valid account"));
        let tokens = config["mandate"]["tokens"].as_array().map(|t| t.len() as u128).unwrap_or(0);
        let per: u128 = config["storage_deposit"].as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("config.storage_deposit is missing"));
        let registrations = per.checked_mul(tokens).unwrap_or_else(|| env::panic_str("overflow"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(tokens > 0, "config.mandate.tokens is missing");
        require!(deposit >= MIN_FUND_NEAR.saturating_add(registrations), "attach at least 0.5 NEAR plus storage_deposit for each token");
        let creator = env::predecessor_account_id();
        Promise::new(fund.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(deposit - registrations))
            .use_global_contract(CryptoHash::from(self.code_hash))
            .function_call("new".to_string(), json!({ "config": config }).to_string().into_bytes(), NearToken::from_yoctonear(registrations), GAS_NEW)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CREATED).on_created(fund, creator, U128(deposit)))
    }

    #[private]
    pub fn on_created(&mut self, fund: AccountId, creator: AccountId, deposit: U128) -> Option<AccountId> {
        if env::promise_results_count() == 1 && env::promise_result_checked(0, 1_024).is_ok() {
            let entry = FundEntry { account_id: fund.clone(), creator, created_at: env::block_timestamp() / 1_000_000_000 };
            env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "plinth-factory", "version": "1.0.0", "event": "fund_created", "data": [&entry]})));
            self.funds.push(entry);
            Some(fund)
        } else {
            // Nothing was created: the attached NEAR came back to the factory; return it.
            Promise::new(creator).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            None
        }
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
