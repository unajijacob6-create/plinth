//! Minimal NEP-141 + NEP-145 token for Plinth's sandbox tests. Like real tokens (USDC on NEAR,
//! wrap.near), a transfer to an account that is not storage-registered fails, so the tests catch
//! the "unregistered 1Click deposit address" trap.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const STORAGE: u128 = 1_250_000_000_000_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    balances: LookupMap<AccountId, u128>,
    /// Liquid-staking mode: yocto-NEAR per 1e24 units (0 = not a staking token).
    price: u128,
}

#[near]
impl Token {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b"), price: 0 }
    }

    /// Liquid-staking test token: `deposit_and_stake` mints attached / price.
    #[init]
    pub fn new_staking(price: U128) -> Self {
        Self { balances: LookupMap::new(b"b"), price: price.0 }
    }

    // ---- wNEAR behaviour (wrap.near): near_deposit / near_withdraw

    #[payable]
    pub fn near_deposit(&mut self) {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let b = *self.balances.get(&who).unwrap_or_else(|| env::panic_str("not registered"));
        self.balances.insert(who, b + amount);
    }

    #[payable]
    pub fn near_withdraw(&mut self, amount: U128) -> Promise {
        require!(env::attached_deposit().as_yoctonear() == 1, "requires 1 yoctoNEAR");
        let who = env::predecessor_account_id();
        let b = *self.balances.get(&who).unwrap_or_else(|| env::panic_str("not registered"));
        require!(b >= amount.0, "not enough balance");
        self.balances.insert(who.clone(), b - amount.0);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---- liquid-staking behaviour (Meta Pool style): deposit_and_stake / get_st_near_price

    #[payable]
    pub fn deposit_and_stake(&mut self) {
        require!(self.price > 0, "not a staking token");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= 1_000_000_000_000_000_000_000_000, "minimum deposit is 1 NEAR");
        let who = env::predecessor_account_id();
        let b = self.balances.get(&who).copied().unwrap_or(0);
        let minted = amount * 1_000_000 / (self.price / 1_000_000_000_000_000_000);
        self.balances.insert(who, b + minted);
    }

    pub fn get_st_near_price(&self) -> U128 {
        U128(self.price)
    }

    /// Test helper: credit a registered account.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let b = *self.balances.get(&account_id).unwrap_or_else(|| env::panic_str("not registered"));
        self.balances.insert(account_id, b + amount.0);
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> near_sdk::serde_json::Value {
        let _ = registration_only;
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let dep = env::attached_deposit().as_yoctonear();
        if self.balances.get(&who).is_none() {
            require!(dep >= STORAGE, "attach 0.00125 NEAR");
            self.balances.insert(who.clone(), 0);
            if dep > STORAGE {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(dep - STORAGE)).detach();
            }
        } else if dep > 0 {
            Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(dep)).detach();
        }
        near_sdk::serde_json::json!({"total": U128(STORAGE), "available": U128(0)})
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<near_sdk::serde_json::Value> {
        self.balances.get(&account_id).map(|_| near_sdk::serde_json::json!({"total": U128(STORAGE), "available": U128(0)}))
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(env::attached_deposit().as_yoctonear() == 1, "requires 1 yoctoNEAR");
        let _ = memo;
        self.move_tokens(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> Promise {
        require!(env::attached_deposit().as_yoctonear() == 1, "requires 1 yoctoNEAR");
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        Promise::new(receiver_id.clone())
            .function_call(
                "ft_on_transfer",
                near_sdk::serde_json::json!({"sender_id": sender, "amount": amount, "msg": msg}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(60),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "ft_resolve_transfer",
                near_sdk::serde_json::json!({"sender_id": sender, "receiver_id": receiver_id, "amount": amount}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            ))
    }

    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let rb = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let back = unused.min(rb);
            self.balances.insert(receiver_id, rb - back);
            let sb = self.balances.get(&sender_id).copied().unwrap_or(0);
            self.balances.insert(sender_id, sb + back);
            return U128(amount.0 - back);
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        let fb = *self.balances.get(from).unwrap_or_else(|| env::panic_str("sender not registered"));
        require!(fb >= amount, "not enough balance");
        let tb = *self.balances.get(to).unwrap_or_else(|| env::panic_str(&format!("The account {to} is not registered")));
        self.balances.insert(from.clone(), fb - amount);
        self.balances.insert(to.clone(), tb + amount);
    }
}

// Silence unused warning for PromiseOrValue in some builds.
#[allow(dead_code)]
fn _unused(_: PromiseOrValue<U128>) {}
