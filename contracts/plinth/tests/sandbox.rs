//! Plinth end to end on a local NEAR node (near-sandbox 2.14), with real NEP-141 token contracts
//! that enforce storage registration (mock-ft) and a test 1Click signing key:
//!   - the fund is created keyless in one transaction (CreateAccount, Transfer, DeployContract,
//!     FunctionCall new) and has zero access keys;
//!   - two depositors subscribe; a hostile quote (output to someone else) is refused and recorded;
//!   - a quote inside the mandate is sent: the fund registers the (unregistered) deposit address and
//!     transfers to it in one receipt; a "solver" plays 1Click and delivers the output; the output is pushed with the trade's message and settles it;
//!   - a depositor redeems in kind; an unregistered redeemer's payout stays owed and is claimable.
//! Build first: `bash contracts/test.sh` (or cargo near build for plinth and mock-ft).

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

/// In these tests a fund `fund.<root>` names `relay.<root>` as its refund relay (refunds are
/// exercised in tests/regression.rs, where the relay account really exists).
fn relay_of(fund: &AccountId) -> AccountId {
    fund.as_str().replacen("fund.", "relay.", 1).parse().unwrap()
}

/// A live 1Click-shaped quote signed with the test key, using the contract's own message rule.
fn quote(sell: &AccountId, buy: &AccountId, amount: u128, out: u128, min_out: u128, recipient: &AccountId, deposit: &str, issued: u64, trade_id: u64) -> String {
    let req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": format!("nep141:{sell}"), "depositType": "ORIGIN_CHAIN", "destinationAsset": format!("nep141:{buy}"),
        "amount": amount.to_string(), "refundTo": relay_of(recipient), "refundType": "ORIGIN_CHAIN", "recipient": recipient,
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

#[tokio::test]
async fn keyless_fund_end_to_end() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let wnear = token(&worker, &root, "wnear").await?;
    let mk = |n: &'static str| root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact();
    let alice = mk("alice").await?.into_result()?;
    let bob = mk("bob").await?.into_result()?;
    let carol = mk("carol").await?.into_result()?;
    let operator = mk("operator").await?.into_result()?;
    let solver = mk("solver").await?.into_result()?;
    for a in [&alice, &bob, &carol, &solver] {
        register(a, &usdc).await?;
    }
    for a in [&alice, &solver] {
        register(a, &wnear).await?;
    }
    for a in [&alice, &bob, &carol] {
        root.call(usdc.id(), "mint").args_json(json!({"account_id": a.id(), "amount": "100000000"})).transact().await?.into_result()?;
    }
    root.call(wnear.id(), "mint").args_json(json!({"account_id": solver.id(), "amount": "5000000000000000000000000"})).transact().await?.into_result()?;

    // ---- keyless creation in one transaction
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 12;
    let config = json!({
        "mandate": {
            "tokens": [usdc.id(), wnear.id()], "max_trade_bps": 2500, "max_cost_bps": 100,
            "min_seconds_between_trades": 660, "max_trades_per_day": 6, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000",
        },
        "operator": operator.id(),
        "quote_signer": format!("ed25519:{}", bs58::encode(sk().verifying_key().to_bytes()).into_string()),
        "storage_deposit": STORAGE.as_yoctonear().to_string(),
        "refund_relay": format!("relay.{}", root.id()),
    });
    let r = root
        .batch(&fund_id)
        .create_account()
        .transfer(NearToken::from_near(5))
        .deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": config})).deposit(NearToken::from_millinear(10)).gas(Gas::from_tgas(100)))
        .transact()
        .await?;
    assert!(r.is_success(), "keyless create failed: {:?}", r.failures());
    let keys = worker.view_access_keys(&fund_id).await?;
    assert!(keys.is_empty(), "the fund must have no access keys, has {}", keys.len());
    println!("fund {fund_id}: 0 access keys");

    // ---- subscribe
    for (who, amt) in [(&alice, "60000000"), (&bob, "40000000")] {
        let r = who
            .call(usdc.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": fund_id, "amount": amt, "msg": ""}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(150))
            .transact()
            .await?;
        assert!(r.is_success(), "{:?}", r.failures());
    }
    let v = fund_view(&worker, &fund_id).await?;
    assert_eq!(v["total_shares"], "100000000");
    assert_eq!(balance(&usdc, &fund_id).await?, 100_000_000);

    // ---- wait for the window to close
    while now_s(&worker).await? < close {
        worker.fast_forward(10).await?;
    }
    let now = now_s(&worker).await?;

    // ---- a hostile quote: output to the operator. Refused and recorded, nothing moves.
    let deposit = "d".repeat(64);
    let evil = quote(usdc.id(), wnear.id(), 10_000_000, 2_700_000_000_000_000_000_000_000, 2_690_000_000_000_000_000_000_000, operator.id(), &deposit, now, 0);
    let ok: bool = operator.call(&fund_id, "propose_trade").args_json(json!({"quote": evil})).gas(Gas::from_tgas(150)).transact().await?.json()?;
    assert!(!ok);
    let rej: Value = worker.view(&fund_id, "get_rejections").args_json(json!({"from": 0, "limit": 5})).await?.json()?;
    assert!(rej[0]["reason"].as_str().unwrap().contains("deliver to this fund"), "{rej}");
    assert_eq!(balance(&usdc, &fund_id).await?, 100_000_000);

    // ---- someone else cannot propose
    let r = alice.call(&fund_id, "propose_trade").args_json(json!({"quote": "{}"})).gas(Gas::from_tgas(50)).transact().await?;
    assert!(r.is_failure());

    // ---- a trade inside the mandate: the deposit address is not registered on the token
    let good = quote(usdc.id(), wnear.id(), 10_000_000, 2_700_000_000_000_000_000_000_000, 2_690_000_000_000_000_000_000_000, &fund_id, &deposit, now, 0);
    let r = operator.call(&fund_id, "propose_trade").args_json(json!({"quote": good})).gas(Gas::from_tgas(200)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.json::<bool>()?);
    let dep: AccountId = deposit.parse()?;
    assert_eq!(balance(&usdc, &dep).await?, 10_000_000, "the input reached the deposit address");
    let v = fund_view(&worker, &fund_id).await?;
    assert_eq!(v["pending"]["status"], "Sent");
    assert_eq!(v["held"][0][1], "90000000");

    // Nothing can close the trade from a balance read: a refund check is not even allowed yet.
    let r = carol.call(&fund_id, "settle_refund").args_json(json!({"trade_id": 0})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.is_failure());

    // ---- "1Click" delivers the output the way the signed quote says: ft_transfer_call with the
    // trade's message. The trade settles in that call; nobody has to do anything.
    let out: u128 = 2_695_000_000_000_000_000_000_000;
    let r = solver
        .call(wnear.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": fund_id, "amount": out.to_string(), "msg": "trade:0"}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    println!("output delivery (ft_transfer_call + settle) burnt {} TGas", r.total_gas_burnt.as_tgas());
    assert_eq!(balance(&wnear, solver.id()).await?, NearToken::from_near(5).as_yoctonear() - out, "the fund kept all of it");
    let _ = &carol;
    let v = fund_view(&worker, &fund_id).await?;
    assert!(v["pending"].is_null());
    assert_eq!(v["held"][1][1], out.to_string());

    // ---- alice (60%, registered on both tokens) redeems everything, in kind
    let a_usdc = balance(&usdc, alice.id()).await?;
    alice.call(&fund_id, "redeem").args_json(json!({"shares": "60000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    assert_eq!(balance(&usdc, alice.id()).await? - a_usdc, 54_000_000);
    assert_eq!(balance(&wnear, alice.id()).await?, out * 60 / 100);

    // ---- bob is not registered on wNEAR: his wNEAR stays owed, then he registers and claims
    bob.call(&fund_id, "redeem").args_json(json!({"shares": "40000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let owed: Vec<String> = worker.view(&fund_id, "get_owed").args_json(json!({"account_id": bob.id()})).await?.json()?;
    assert_eq!(owed, vec!["0".to_string(), (out - out * 60 / 100).to_string()]);
    register(&bob, &wnear).await?;
    bob.call(&fund_id, "claim").args_json(json!({})).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    assert_eq!(balance(&wnear, bob.id()).await?, out - out * 60 / 100);
    let owed: Vec<String> = worker.view(&fund_id, "get_owed").args_json(json!({"account_id": bob.id()})).await?.json()?;
    assert!(owed.is_empty());

    // The fund is empty and still keyless.
    let v = fund_view(&worker, &fund_id).await?;
    assert_eq!(v["total_shares"], "0");
    assert_eq!((balance(&usdc, &fund_id).await?, balance(&wnear, &fund_id).await?), (0, 0));
    assert!(worker.view_access_keys(&fund_id).await?.is_empty());
    Ok(())
}


async fn plain_fund(worker: &Worker<near_workspaces::network::Sandbox>, root: &Account, tokens: &[&Contract]) -> anyhow::Result<AccountId> {
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(worker).await? + 3600;
    let config = json!({
        "mandate": {
            "tokens": tokens.iter().map(|t| t.id().to_string()).collect::<Vec<_>>(), "max_trade_bps": 2500, "max_cost_bps": 100,
            "min_seconds_between_trades": 660, "max_trades_per_day": 6, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000000",
        },
        "operator": root.id(),
        "quote_signer": "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
        "storage_deposit": STORAGE.as_yoctonear().to_string(),
        "refund_relay": format!("relay.{}", root.id()),
    });
    let r = root.batch(&fund_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": config})).deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(200)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    Ok(fund_id)
}

/// Audit C1 regression (the auditor's PoC, now asserting the safe outcome): redeem followed by
/// claims in the same transaction pays the redeemer exactly once, and others can still exit.
#[tokio::test]
async fn audit_c1_redeem_then_claims_pays_once() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let mallory = root.create_subaccount("mallory").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    for a in [&alice, &mallory] {
        register(a, &usdc).await?;
    }
    root.call(usdc.id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "90000000"})).transact().await?.into_result()?;
    root.call(usdc.id(), "mint").args_json(json!({"account_id": mallory.id(), "amount": "10000000"})).transact().await?.into_result()?;
    let fund = plain_fund(&worker, &root, &[&usdc]).await?;
    for (who, amt) in [(&alice, "90000000"), (&mallory, "10000000")] {
        who.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund, "amount": amt, "msg": ""}))
            .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    }
    let before = balance(&usdc, mallory.id()).await?;
    let r = mallory.batch(&fund)
        .call(Function::new("redeem").args_json(json!({"shares": "10000000"})).gas(Gas::from_tgas(60)))
        .call(Function::new("claim").args_json(json!({})).gas(Gas::from_tgas(60)))
        .call(Function::new("claim").args_json(json!({})).gas(Gas::from_tgas(60)))
        .transact().await?;
    assert!(r.is_failure(), "claim with nothing owed must fail");
    // The whole batch reverted (claim panicked), so Mallory still has her shares; redeem alone:
    let r = mallory.call(&fund, "redeem").args_json(json!({"shares": "10000000"})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let r = mallory.call(&fund, "claim").args_json(json!({})).gas(Gas::from_tgas(60)).transact().await?;
    assert!(r.is_failure());
    assert_eq!(balance(&usdc, mallory.id()).await? - before, 10_000_000);
    alice.call(&fund, "redeem").args_json(json!({"shares": "90000000"})).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    assert_eq!(balance(&usdc, alice.id()).await?, 90_000_000);
    assert_eq!(balance(&usdc, &fund).await?, 0);
    Ok(())
}

/// Audit H1 regression: with the maximum 4 tokens all held, one redemption pays all of them.
#[tokio::test]
async fn audit_h1_four_token_redeem_fits_in_one_transaction() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mut toks = vec![];
    for i in 0..4 {
        toks.push(token(&worker, &root, &format!("t{i}")).await?);
    }
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let donor = root.create_subaccount("donor").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    for t in &toks {
        register(&alice, t).await?;
        register(&donor, t).await?;
    }
    root.call(toks[0].id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "100000000"})).transact().await?.into_result()?;
    let refs: Vec<&Contract> = toks.iter().collect();
    let fund = plain_fund(&worker, &root, &refs).await?;
    alice.call(toks[0].id(), "ft_transfer_call").args_json(json!({"receiver_id": fund, "amount": "100000000", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    for (i, t) in toks.iter().enumerate().skip(1) {
        root.call(t.id(), "mint").args_json(json!({"account_id": donor.id(), "amount": "1000"})).transact().await?.into_result()?;
        let _ = i;
        donor.call(t.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund, "amount": "1000", "msg": "donate"})).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    let r = alice.call(&fund, "redeem").args_json(json!({"shares": "100000000"})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    println!("4-token redeem burnt {} TGas", r.total_gas_burnt.as_tgas());
    for (i, t) in toks.iter().enumerate() {
        assert_eq!(balance(t, alice.id()).await?, if i == 0 { 100_000_000 } else { 1000 });
    }
    Ok(())
}

/// Earning, end to end on a local node: the fund holds wNEAR, the operator stakes 2 of it into a
/// liquid-staking token at par (unwrap -> price -> deposit_and_stake), anyone settles, a depositor
/// exits with stNEAR in kind, and the operator's management fee shares accrue.
#[tokio::test]
async fn stake_idle_end_to_end_and_management_fee() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let wnear = token(&worker, &root, "wnear").await?;
    let lst_acc = root.create_subaccount("stnear").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let stnear = lst_acc.deploy(&std::fs::read(MOCK_FT)?).await?.into_result()?;
    stnear.call("new_staking").args_json(json!({"price": "1500000000000000000000000"})).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let operator = root.create_subaccount("operator").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let donor = root.create_subaccount("donor").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    for t in [&usdc, &wnear, &stnear] {
        register(&alice, t).await?;
    }
    register(&donor, &wnear).await?;
    root.call(usdc.id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "100000000"})).transact().await?.into_result()?;

    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 12;
    let config = json!({
        "mandate": {
            "tokens": [usdc.id(), wnear.id(), stnear.id()], "max_trade_bps": 2500, "max_cost_bps": 100,
            "min_seconds_between_trades": 660, "max_trades_per_day": 6, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000",
            "management_fee_bps": 200,
            "staking": {"wrap_index": 1, "lst_index": 2, "price_method": "get_st_near_price", "min_stake": "1000000000000000000000000", "max_price_slippage_bps": 50},
        },
        "operator": operator.id(),
        "quote_signer": "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
        "storage_deposit": STORAGE.as_yoctonear().to_string(),
        "refund_relay": format!("relay.{}", root.id()),
    });
    let r = root.batch(&fund_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": config})).deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(200)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    alice.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": "100000000", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    // 8 wNEAR are donated to the fund (pushed with ft_transfer_call, so they are counted).
    donor.call(wnear.id(), "near_deposit").deposit(NearToken::from_near(8)).transact().await?.into_result()?;
    donor.call(wnear.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": NearToken::from_near(8).as_yoctonear().to_string(), "msg": "donate"}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    while now_s(&worker).await? < close {
        worker.fast_forward(10).await?;
    }

    let two = NearToken::from_near(2).as_yoctonear();
    let r = operator.call(&fund_id, "stake_idle").args_json(json!({"amount": two.to_string()})).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.json::<bool>()?);
    let v = fund_view(&worker, &fund_id).await?;
    assert!(v["pending"].is_null(), "the stake settles in its own callback: {v}");
    let minted: u128 = two * 2 / 3; // price 1.5
    assert_eq!(balance(&stnear, &fund_id).await?, minted);
    assert_eq!(balance(&wnear, &fund_id).await?, NearToken::from_near(6).as_yoctonear());
    let trades: Value = worker.view(&fund_id, "get_trades").args_json(json!({"from": 0, "limit": 5})).await?.json()?;
    assert_eq!(trades[0]["status"], "Settled", "{trades}");
    assert_eq!(v["held"][2][1], minted.to_string(), "counted from what deposit_and_stake returned");
    // A stake over the size cap (30% of 6 wNEAR) is refused on chain.
    let r: bool = operator.call(&fund_id, "stake_idle").args_json(json!({"amount": NearToken::from_near(2).as_yoctonear().to_string()})).gas(Gas::from_tgas(300)).transact().await?.json()?;
    assert!(!r);

    // The fee: the operator has accrued shares since the window closed (2%/yr of 100 pUSD is
    // about 0.06 shares a second, so let some time pass).
    worker.fast_forward(200).await?;
    operator.call(&fund_id, "accrue").transact().await?.into_result()?;
    let v = fund_view(&worker, &fund_id).await?;
    let op: u128 = v["operator_shares"].as_str().unwrap().parse()?;
    assert!(op > 0, "operator fee shares accrued");
    println!("operator fee shares after {}s: {op}", now_s(&worker).await? - close);

    // Alice exits with her share of every token, stNEAR included.
    alice.call(&fund_id, "redeem").args_json(json!({"shares": "100000000"})).gas(Gas::from_tgas(250)).transact().await?.into_result()?;
    let got_st = balance(&stnear, alice.id()).await?;
    assert!(got_st > 0 && got_st < minted, "alice got {got_st} stNEAR (less than all: the operator owns fee shares)");
    println!("alice got {} USDC units, {} wNEAR, {} stNEAR", balance(&usdc, alice.id()).await?, balance(&wnear, alice.id()).await?, got_st);
    Ok(())
}
