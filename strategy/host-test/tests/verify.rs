//! The strategy's trade Decisions, verified with `plinth::quote::verify_quote` (the contract's
//! own code, `env::ed25519_verify` and `env::sha256` from near-sdk's unit-testing host).
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use plinth_strategy_v1 as s;
use serde_json::{json, Value};

const NOW: u64 = 1_794_350_000;
/// The fund's refund relay, as the fund passes it in `refund_to`.
const RELAY: &str = "relay.fund.testnet";

fn input(fund: &str, held: [&str; 2], trade_id: u64, max_trade_bps: u64, max_cost_bps: u64) -> String {
    json!({"fund": fund, "refund_to": RELAY, "now": NOW, "next_trade_id": trade_id, "tokens": ["usdc.testnet", "wrap.testnet"], "held": held,
           "total_shares": "74000000", "max_trade_bps": max_trade_bps, "max_cost_bps": max_cost_bps, "staking": null})
    .to_string()
}

fn key() -> [u8; 32] {
    plinth::quote::decode_public_key(&s::public_key()).unwrap()
}

fn verified(d: &Value) -> (plinth::quote::VerifiedQuote, String) {
    testing_env!(VMContextBuilder::new().build());
    assert_eq!(d["action"], "trade", "{d}");
    let raw = d["quote"].as_str().unwrap().to_string();
    let q = plinth::quote::verify_quote(&raw, &key()).expect("the contract's verifier must accept the strategy's quote");
    // The contract's rule (lib.rs check_trade): recipient == fund && refundTo == the refund relay.
    let input_fund = serde_json::from_str::<Value>(&raw).unwrap()["quoteRequest"]["recipient"].as_str().unwrap().to_string();
    assert_eq!(q.recipient, input_fund);
    assert_eq!(q.refund_to, RELAY, "refundTo must be the relay given in the input");
    assert_ne!(q.refund_to, q.recipient);
    assert_eq!(q.refund_type, "ORIGIN_CHAIN");
    (q, raw)
}

#[test]
fn stable_heavy_fund_sells_stable_and_the_contract_verifier_accepts_it() {
    let d = s::decide(&input("fund.testnet", ["60000000", "4000000000000000000000000"], 3, 2500, 100), 3_590_000);
    let (q, raw) = verified(&d);
    assert_eq!(q.origin_asset, "nep141:usdc.testnet");
    assert_eq!(q.destination_asset, "nep141:wrap.testnet");
    // 60 USD vs 14.36 USD: the excess is 22.82, the cap is 95% of 25% of 60 = 14.25.
    assert_eq!(q.amount_in, 14_250_000);
    assert!(q.amount_in <= 60_000_000 * 2500 / 10_000);
    assert_eq!((q.recipient.as_str(), q.refund_to.as_str(), q.refund_type.as_str()), ("fund.testnet", RELAY, "ORIGIN_CHAIN"));
    assert_eq!(q.custom_recipient_msg.as_deref(), Some("trade:3"));
    assert!(q.unsupported_field.is_none());
    assert_eq!(q.issued_seconds, NOW);
    assert_eq!(q.deadline_seconds, NOW + 86_400);
    assert!(q.min_amount_out > 0 && q.min_amount_out <= q.amount_out);
    let cost = plinth::cost_bps(&q).unwrap();
    assert!(cost <= 100, "cost {cost} bps");
    assert_eq!(q.deposit_address.as_str().len(), 64);

    // The guest's copy of the message rule gives the same string as the contract's.
    let v: Value = serde_json::from_str(&raw).unwrap();
    let ts = v["timestamp"].as_str().unwrap();
    assert_eq!(s::signed_message(&v["quoteRequest"], &v["quote"], ts).unwrap(), plinth::quote::signed_message(&v["quoteRequest"], &v["quote"], ts).unwrap());
}

#[test]
fn near_heavy_fund_sells_wnear() {
    let d = s::decide(&input("fund.testnet", ["10000000", "20000000000000000000000000"], 0, 2500, 100), 3_590_000);
    let (q, _) = verified(&d);
    assert_eq!(q.origin_asset, "nep141:wrap.testnet");
    assert_eq!(q.destination_asset, "nep141:usdc.testnet");
    assert_eq!(q.amount_in, 20_000_000_000_000_000_000_000_000u128 * 2500 / 10_000 * 95 / 100);
    assert!(plinth::cost_bps(&q).unwrap() <= 100);
}

#[test]
fn uncapped_trade_goes_to_the_middle() {
    // 56 / 44: the excess (6 USD) is under the cap, so the whole excess is sold.
    let d = s::decide(&input("fund.testnet", ["56000000", "44000000000000000000000000"], 1, 2500, 150), 1_000_000);
    let (q, _) = verified(&d);
    assert_eq!(q.amount_in, 6_000_000);
}

#[test]
fn any_tampering_breaks_the_signature() {
    let d = s::decide(&input("fund.testnet", ["60000000", "4000000000000000000000000"], 3, 2500, 100), 3_590_000);
    let (_, raw) = verified(&d);
    for (from, to) in [("\"amount\":\"14250000\"", "\"amount\":\"14250001\""), ("fund.testnet", "evil.testnet"), ("trade:3", "trade:4")] {
        let t = raw.replace(from, to);
        assert_ne!(t, raw);
        assert!(plinth::quote::verify_quote(&t, &key()).is_err());
    }
    assert!(plinth::quote::verify_quote(&raw, &[7u8; 32]).is_err());
}

#[test]
fn a_sweep_of_holdings_and_prices_always_verifies_and_fits_the_mandate() {
    let mut n = 0;
    for price in [10_000u128, 987_654, 3_590_000, 12_345_678, 999_999_999] {
        for usd in [1u128, 999, 1_000_000, 60_000_000, 123_456_789_012, 5_000_000_000_000_000] {
            for near in [1u128, 10u128.pow(18), 4 * 10u128.pow(24), 777_777_777_777_777_777_777_777_777, 10u128.pow(33)] {
                for (cap, cost) in [(1u64, 100u64), (2500, 100), (10_000, 150)] {
                    let d = s::decide(&input("a-fund.plinth.testnet", [&usd.to_string(), &near.to_string()], 7, cap, cost), price);
                    if d["action"] == "trade" {
                        let (q, _) = verified(&d);
                        let sell_held = if q.origin_asset == "nep141:usdc.testnet" { usd } else { near };
                        assert!(q.amount_in > 0 && q.amount_in <= sell_held * cap as u128 / 10_000, "over the cap: {d}");
                        assert!(q.min_amount_out > 0 && q.min_amount_out <= q.amount_out);
                        assert!(plinth::cost_bps(&q).unwrap() <= cost as u128, "{d}");
                        n += 1;
                    } else {
                        assert_eq!(d["action"], "hold");
                        assert!(d["reason"].as_str().unwrap().len() > 5);
                    }
                }
            }
        }
    }
    assert!(n > 50, "only {n} trades in the sweep");
}

#[test]
fn holds() {
    // Inside the band.
    let d = s::decide(&input("fund.testnet", ["50000000", "14000000000000000000000000"], 0, 2500, 100), 3_590_000);
    assert_eq!(d["action"], "hold");
    assert!(d["reason"].as_str().unwrap().contains("weights 49.87% stable / 50.12% wNEAR"), "{d}");
    // Three tokens, garbage, a mandate tighter than this strategy's quote.
    let three = json!({"fund":"f.testnet","refund_to":RELAY,"now":NOW,"next_trade_id":0,"tokens":["a","b","c"],"held":["1","2","3"],"total_shares":"1","max_trade_bps":2500,"max_cost_bps":100,"staking":null}).to_string();
    for (inp, price) in [(three, 3_590_000u128), ("not json".to_string(), 3_590_000), ("{}".to_string(), 3_590_000), (input("f.testnet", ["60000000", "0"], 0, 2500, 50), 3_590_000), (input("f.testnet", ["0", "0"], 0, 2500, 100), 3_590_000), (input("f.testnet", ["60000000", "0"], 0, 2500, 100), 0)] {
        let d = s::decide(&inp, price);
        assert_eq!(d["action"], "hold", "{d}");
    }
}

#[test]
fn price_feed_parsing() {
    let ok = r#"[{"assetId":"nep141:other","price":1},{"assetId":"nep141:wrap.near","decimals":24,"symbol":"wNEAR","price":3.59}]"#;
    assert_eq!(s::near_price_micros(ok).unwrap(), 3_590_000);
    for bad in ["", "{}", "[]", r#"[{"assetId":"nep141:wrap.near"}]"#, r#"[{"assetId":"nep141:wrap.near","price":0}]"#, r#"[{"assetId":"nep141:wrap.near","price":1e9}]"#, r#"[{"assetId":"nep141:wrap.near","price":null}]"#] {
        assert!(s::near_price_micros(bad).is_err(), "{bad}");
    }
}

#[test]
fn timestamps_round_trip_through_the_contract_parser() {
    for t in [0u64, 951_782_400, 1_794_169_536, NOW, 4_102_444_799] {
        assert_eq!(plinth::quote::parse_rfc3339_seconds(&s::iso(t)), Some(t), "{}", s::iso(t));
    }
    assert_eq!(s::iso(1_794_169_536), "2026-11-08T20:25:36.000Z");
}

/// Decisions returned by OutLayer on testnet (saved by tools/06-v1.mjs), run through the
/// contract's verifier. Skips files that are holds.
#[test]
fn live_outlayer_decisions_verify() {
    testing_env!(VMContextBuilder::new().build());
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../evidence");
    let mut trades = 0;
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("v1-") && name.ends_with(".decision.json")) {
            continue;
        }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
        if d["action"] != "trade" {
            println!("{name}: {}", d);
            continue;
        }
        let q = plinth::quote::verify_quote(d["quote"].as_str().unwrap(), &key()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let cost = plinth::cost_bps(&q).unwrap();
        println!("{name}: VERIFIED {} {} -> {} out {} min {} cost {} bps msg {:?} deposit {}", q.amount_in, q.origin_asset, q.destination_asset, q.amount_out, q.min_amount_out, cost, q.custom_recipient_msg, q.deposit_address);
        assert!(cost <= 100);
        assert_eq!(q.recipient, "proxy.plinth-ol-spike-mwb6xcaj.testnet");
        assert_eq!(q.refund_to, "relay.proxy.plinth-ol-spike-mwb6xcaj.testnet");
        trades += 1;
    }
    assert!(trades >= 2, "expected the live trade decisions, found {trades}");
}

#[test]
fn refund_to_is_required_and_must_be_a_separate_valid_account() {
    let good: Value = serde_json::from_str(&input("fund.testnet", ["60000000", "4000000000000000000000000"], 3, 2500, 100)).unwrap();
    assert_eq!(s::decide(&good.to_string(), 3_590_000)["action"], "trade");
    let with = |v: Option<Value>| {
        let mut i = good.clone();
        match v {
            Some(v) => i["refund_to"] = v,
            None => {
                i.as_object_mut().unwrap().remove("refund_to");
            }
        }
        s::decide(&i.to_string(), 3_590_000)
    };
    let d = with(None);
    assert_eq!(d["action"], "hold");
    assert!(d["reason"].as_str().unwrap().contains("no refund_to"), "{d}");
    for bad in [json!(null), json!(7), json!(""), json!("a"), json!("Relay.testnet"), json!("relay..testnet"), json!(".relay.testnet"), json!("relay.testnet."), json!("re lay.testnet"), json!("x".repeat(65))] {
        let d = with(Some(bad.clone()));
        assert_eq!(d["action"], "hold", "{bad}");
        assert!(d["reason"].as_str().unwrap().contains("refund_to"), "{d}");
    }
    // The fund itself is not a relay: the contract refuses such a quote, so the program never builds one.
    let d = with(Some(json!("fund.testnet")));
    assert_eq!(d["action"], "hold");
    assert!(d["reason"].as_str().unwrap().contains("not the fund itself"), "{d}");
    // parse_input is what main.rs calls before any HTTP request.
    assert!(s::parse_input("not json").is_err());
    assert_eq!(s::parse_input(&good.to_string()).unwrap().refund_to, RELAY);
    for (id, ok) in [("a.b", true), ("ab", true), ("a", false), ("a_b-c.d1", true), ("A.b", false), ("a--b", false), ("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", true)] {
        assert_eq!(s::is_account_id(id), ok, "{id}");
    }
}
