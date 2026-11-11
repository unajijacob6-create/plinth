//! The factory on a local NEAR node: the fund code is published once as a global contract by
//! hash; `create_fund` makes a keyless fund that runs that hash; a bad config sends the NEAR back.
//! Build first: `bash contracts/test.sh`.

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PLINTH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/plinth/plinth.wasm");
const FACTORY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/plinth_factory/plinth_factory.wasm");
const MOCK_FT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/mock_ft/mock_ft.wasm");
const STORAGE: u128 = 1_250_000_000_000_000_000_000;

fn config(tokens: Vec<String>, op: &AccountId, close: u64) -> Value {
    json!({
        "mandate": {
            "tokens": tokens, "max_trade_bps": 2500, "max_cost_bps": 100,
            "min_seconds_between_trades": 660, "max_trades_per_day": 6, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000000", "open_ended": true,
        },
        "operator": op,
        "quote_signer": "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
        "storage_deposit": STORAGE.to_string(),
    })
}

async fn balance(t: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(t.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json::<String>()?.parse()?)
}

#[tokio::test]
async fn factory_creates_keyless_funds_from_the_published_hash() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let code = std::fs::read(PLINTH)?;
    let hash: [u8; 32] = Sha256::digest(&code).into();
    let hash_b58 = bs58::encode(hash).into_string();

    // Publish the fund code as a global contract by hash (burns ~10x its storage cost, once).
    let publisher: Account = root.create_subaccount("publisher").initial_balance(NearToken::from_near(60)).transact().await?.into_result()?;
    let pubc = publisher.deploy(&std::fs::read(MOCK_FT)?).await?.into_result()?;
    let before = publisher.view_account().await?.balance;
    let r = pubc.call("publish_global").args(code.clone()).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let burnt = before.as_yoctonear() - publisher.view_account().await?.balance.as_yoctonear();
    println!("publishing {} bytes as a global contract cost {:.3} NEAR", code.len(), burnt as f64 / 1e24);

    // The factory, keyless, with the hash fixed.
    let usdc_acc = root.create_subaccount("usdc").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let usdc = usdc_acc.deploy(&std::fs::read(MOCK_FT)?).await?.into_result()?;
    usdc.call("new").transact().await?.into_result()?;
    let factory_id: AccountId = format!("funds.{}", root.id()).parse()?;
    let r = root.batch(&factory_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(FACTORY)?)
        .call(near_workspaces::operations::Function::new("new").args_json(json!({"code_hash": hash_b58})).gas(Gas::from_tgas(30)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(worker.view_access_keys(&factory_id).await?.is_empty(), "the factory has no keys");

    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    alice.call(usdc.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_yoctonear(STORAGE)).transact().await?.into_result()?;
    root.call(usdc.id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "50000000"})).transact().await?.into_result()?;
    let close = worker.view_block().await?.timestamp() / 1_000_000_000 + 3600;

    // Alice launches a fund with one call and 1 NEAR.
    let r = alice.call(&factory_id, "create_fund").args_json(json!({"name": "alpha", "config": config(vec![usdc.id().to_string()], alice.id(), close)}))
        .deposit(NearToken::from_near(1)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    println!("create_fund burnt {} TGas", r.total_gas_burnt.as_tgas());
    let fund_id: AccountId = format!("alpha.{factory_id}").parse()?;
    assert_eq!(r.json::<Option<AccountId>>()?, Some(fund_id.clone()));
    assert!(worker.view_access_keys(&fund_id).await?.is_empty(), "the fund has no keys");
    let acct = worker.view_account(&fund_id).await?;
    assert_eq!(acct.contract_state, near_workspaces::ContractState::GlobalHash(near_workspaces::CryptoHash(hash)), "the fund runs the published hash, not its own copy of the code");
    println!("a fund uses {} bytes of storage ({} NEAR locked) instead of {} bytes of its own code", acct.storage_usage, acct.storage_usage as f64 / 1e5, code.len());
    assert!(acct.storage_usage < 5_000);
    let funds: Value = worker.view(&factory_id, "get_funds").args_json(json!({"from": 0, "limit": 10})).await?.json()?;
    assert_eq!(funds[0]["account_id"], fund_id.as_str());
    assert_eq!(funds[0]["creator"], alice.id().as_str());

    // It is a working fund: subscribe and leave.
    let v: Value = worker.view(&fund_id, "get_fund").await?.json()?;
    assert_eq!(v["version"], "0.3.0");
    assert_eq!(v["registered"][0], true);
    alice.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": "50000000", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    alice.call(&fund_id, "redeem").args_json(json!({"shares": "20000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    assert_eq!(balance(&usdc, alice.id()).await?, 20_000_000);

    // A taken name, and a config the fund refuses: nothing is created and the NEAR comes back.
    for (name, cfg) in [("alpha", config(vec![usdc.id().to_string()], alice.id(), close)), ("beta", config(vec![usdc.id().to_string()], alice.id(), 1))] {
        let before = alice.view_account().await?.balance.as_yoctonear();
        let r = alice.call(&factory_id, "create_fund").args_json(json!({"name": name, "config": cfg})).deposit(NearToken::from_near(1)).gas(Gas::from_tgas(300)).transact().await?;
        assert!(r.is_success(), "{:?}", r.failures());
        assert_eq!(r.json::<Option<AccountId>>()?, None, "{name}: not created");
        let diff = before.abs_diff(alice.view_account().await?.balance.as_yoctonear());
        assert!(diff < NearToken::from_millinear(50).as_yoctonear(), "{name}: the 1 NEAR came back (balance moved by {diff}, gas only)");
    }
    assert_eq!(worker.view(&factory_id, "fund_count").await?.json::<u32>()?, 1);
    // Too little NEAR is refused outright.
    let r = alice.call(&factory_id, "create_fund").args_json(json!({"name": "gamma", "config": config(vec![usdc.id().to_string()], alice.id(), close)})).deposit(NearToken::from_millinear(100)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure());
    Ok(())
}
