//! Verifying NEAR Intents 1Click quotes on-chain.
//!
//! 1Click signs every quote with its manager key. The signed message is
//! `base58(sha256(stable_json({...signedRequestFields, ...signedQuoteFields, timestamp})))`
//! (docs.near-intents.org → 1Click API → Verify Quote Signatures, and
//! `@defuse-protocol/one-click-sdk-typescript` `verifyQuoteSignature`). For a live (non-dry) quote
//! the signed fields include `depositAddress` and `quote.deadline`, so an operator cannot swap in
//! its own deposit address without breaking the signature.
//!
//! The message rebuild is adapted from Standing Order (same author), where it is tested against a
//! real live quote.

use near_sdk::serde_json::{self, Value};
use near_sdk::{env, AccountId};

/// 1Click manager public key (ed25519, base58) as shipped in the official SDK.
pub const ONE_CLICK_MANAGER_PUB_KEY: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/// The fields of a verified quote the fund relies on.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedQuote {
    pub deposit_address: AccountId,
    pub origin_asset: String,
    pub destination_asset: String,
    /// `quoteRequest.amount`, which must equal `quote.amountIn` (checked here).
    pub amount_in: u128,
    pub amount_out: u128,
    pub min_amount_out: u128,
    /// 1Click's own USD marks, in micro-USD (6 decimals, truncated).
    pub amount_in_usd_micros: u128,
    pub amount_out_usd_micros: u128,
    pub refund_fee: u128,
    pub recipient: String,
    pub refund_to: String,
    pub refund_type: String,
    /// When the deposit address stops accepting deposits (signed `quote.deadline`), Unix seconds.
    pub deadline_seconds: u64,
    /// When 1Click issued the quote (signed `timestamp`), Unix seconds.
    pub issued_seconds: u64,
    /// The signed `customRecipientMsg`: with it 1Click delivers by `ft_transfer_call` with this msg.
    pub custom_recipient_msg: Option<String>,
    /// A signed field the fund does not handle (a deposit memo, or virtual-chain routing), if any.
    pub unsupported_field: Option<String>,
}

/// Verify the signature on a raw 1Click quote response (`quoteRequest`, `quote`, `timestamp`,
/// `signature`) and extract the fields the fund needs. Returns a readable reason on failure.
pub fn verify_quote(raw: &str, public_key: &[u8; 32]) -> Result<VerifiedQuote, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("quote is not valid JSON: {e}"))?;
    let req = v.get("quoteRequest").ok_or("quote missing quoteRequest")?;
    let quote = v.get("quote").ok_or("quote missing quote")?;
    let timestamp = v.get("timestamp").and_then(Value::as_str).ok_or("quote missing timestamp")?;
    let signature = v.get("signature").and_then(Value::as_str).ok_or("quote missing signature")?;
    if req.get("dry").and_then(Value::as_bool) != Some(false) {
        return Err("quote must be a live (non-dry) quote".into());
    }
    for (key, expected) in [("swapType", "EXACT_INPUT"), ("depositType", "ORIGIN_CHAIN"), ("recipientType", "DESTINATION_CHAIN")] {
        if req.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(format!("quoteRequest.{key} must be {expected}"));
        }
    }

    let message = signed_message(req, quote, timestamp)?;
    let sig_bytes = bs58::decode(signature.strip_prefix("ed25519:").unwrap_or(signature))
        .into_vec()
        .map_err(|_| "signature is not base58")?;
    let sig: [u8; 64] = sig_bytes.try_into().map_err(|_| "signature must be 64 bytes")?;
    if !env::ed25519_verify(&sig, message.as_bytes(), public_key) {
        return Err("quote signature does not verify against the 1Click key".into());
    }

    let s = |obj: &Value, key: &str| -> Result<String, String> {
        obj.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("quote missing {key}"))
    };
    let u = |obj: &Value, key: &str| -> Result<u128, String> {
        s(obj, key)?.parse::<u128>().map_err(|_| format!("quote field {key} is not an integer string"))
    };
    let usd = |obj: &Value, key: &str| -> Result<u128, String> { parse_usd_micros(&s(obj, key)?).ok_or_else(|| format!("quote field {key} is not a decimal")) };
    let deposit_address: AccountId = s(quote, "depositAddress")?.parse().map_err(|_| "depositAddress is not a NEAR account")?;
    let amount_in = u(req, "amount")?;
    if u(quote, "amountIn")? != amount_in {
        return Err("quote.amountIn differs from quoteRequest.amount".into());
    }
    let refund_fee = match quote.get("refundFee") {
        None | Some(Value::Null) => 0,
        Some(_) => u(quote, "refundFee")?,
    };
    Ok(VerifiedQuote {
        deposit_address,
        origin_asset: s(req, "originAsset")?,
        destination_asset: s(req, "destinationAsset")?,
        amount_in,
        amount_out: u(quote, "amountOut")?,
        min_amount_out: u(quote, "minAmountOut")?,
        amount_in_usd_micros: usd(quote, "amountInUsd")?,
        amount_out_usd_micros: usd(quote, "amountOutUsd")?,
        refund_fee,
        recipient: s(req, "recipient")?,
        refund_to: s(req, "refundTo")?,
        refund_type: s(req, "refundType")?,
        // In a live quote `quote.deadline` overrides the request's (JS spread), so this is the
        // signed one. Never trust `quoteRequest.deadline` for anything.
        deadline_seconds: parse_rfc3339_seconds(&s(quote, "deadline")?).ok_or("quote deadline is not RFC 3339")?,
        issued_seconds: parse_rfc3339_seconds(timestamp).ok_or("quote timestamp is not RFC 3339")?,
        custom_recipient_msg: req.get("customRecipientMsg").filter(|v| is_truthy(v)).and_then(Value::as_str).map(str::to_string),
        unsupported_field: [("depositMemo", quote), ("virtualChainRecipient", req), ("virtualChainRefundRecipient", req)]
            .iter()
            .find(|(k, obj)| obj.get(*k).map(is_truthy).unwrap_or(false))
            .map(|(k, _)| k.to_string()),
    })
}

/// Rebuild the exact string 1Click signs: base58(sha256(json)) with the SDK's field subset, keys
/// sorted, compact, and optional fields dropped when JS would treat them as falsy.
pub fn signed_message(req: &Value, quote: &Value, timestamp: &str) -> Result<String, String> {
    let dry = req.get("dry").and_then(Value::as_bool).unwrap_or(true);
    // JS `{...request, ...quote, timestamp}`: later keys override earlier ones (e.g. `deadline`).
    let mut fields: std::collections::BTreeMap<&str, Value> = std::collections::BTreeMap::new();
    let mut push = |key: &'static str, val: Option<&Value>| {
        if let Some(v) = val {
            if !v.is_null() {
                fields.insert(key, v.clone());
            }
        }
    };
    for key in ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] {
        push(key, req.get(key));
    }
    for key in ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"] {
        if let Some(v) = req.get(key) {
            if is_truthy(v) {
                push(key, Some(v));
            }
        }
    }
    for key in ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"] {
        push(key, quote.get(key));
    }
    if !dry {
        for key in ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"] {
            if let Some(v) = quote.get(key) {
                if is_truthy(v) {
                    push(key, Some(v));
                }
            }
        }
    }
    push("timestamp", Some(&Value::String(timestamp.to_string())));

    let mut json = String::from("{");
    for (i, (k, v)) in fields.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&serde_json::to_string(k).map_err(|e| e.to_string())?);
        json.push(':');
        json.push_str(&serde_json::to_string(v).map_err(|e| e.to_string())?);
    }
    json.push('}');
    Ok(bs58::encode(env::sha256(json.as_bytes())).into_string())
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// "2.998482000000" → 2_998_482 (micro-USD, extra decimals truncated). None if not a plain
/// non-negative decimal.
pub fn parse_usd_micros(s: &str) -> Option<u128> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut f = frac.chars().take(6).collect::<String>();
    while f.len() < 6 {
        f.push('0');
    }
    int.parse::<u128>().ok()?.checked_mul(1_000_000)?.checked_add(f.parse::<u128>().ok()?)
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff]Z` into Unix seconds. UTC only, which is what 1Click emits.
pub fn parse_rfc3339_seconds(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day) = (d.next()?.parse::<i64>().ok()?, d.next()?.parse::<u32>().ok()?, d.next()?.parse::<u32>().ok()?);
    let time = time.split('.').next()?;
    let mut t = time.split(':');
    let (hh, mm, ss) = (t.next()?.parse::<u64>().ok()?, t.next()?.parse::<u64>().ok()?, t.next()?.parse::<u64>().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn decode_public_key(s: &str) -> Option<[u8; 32]> {
    let raw = s.strip_prefix("ed25519:").unwrap_or(s);
    bs58::decode(raw).into_vec().ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: &str = include_str!("../tests/fixtures/quote_live.json");
    const DRY: &str = include_str!("../tests/fixtures/quote_dry.json");

    fn key() -> [u8; 32] {
        decode_public_key(ONE_CLICK_MANAGER_PUB_KEY).unwrap()
    }

    #[test]
    fn real_live_quote_verifies_and_extracts_signed_fields() {
        let q = verify_quote(LIVE, &key()).expect("live fixture should verify");
        assert_eq!(q.deposit_address.as_str(), "702bb1cdf6e6d1f80776679b6e0f2745226efd76cda7563fe0f45ee1d1929d87");
        assert_eq!((q.amount_in, q.amount_out, q.min_amount_out, q.refund_fee), (3_000_000, 2_997_248, 2_967_275, 4528));
        assert_eq!((q.amount_in_usd_micros, q.amount_out_usd_micros), (2_998_482, 2_995_731));
        assert_eq!(q.refund_to, "dev1.near");
        assert_eq!(q.refund_type, "ORIGIN_CHAIN");
        assert_eq!(q.deadline_seconds, parse_rfc3339_seconds("2026-11-12T06:00:00.000Z").unwrap());
        assert_eq!(q.issued_seconds, parse_rfc3339_seconds("2026-11-08T20:25:36.811Z").unwrap());
        assert!(q.custom_recipient_msg.is_none());
    }

    #[test]
    fn dry_quotes_are_refused() {
        assert!(verify_quote(DRY, &key()).unwrap_err().contains("live"));
    }

    #[test]
    fn every_signed_field_the_fund_uses_is_covered_by_the_signature() {
        for (from, to) in [
            ("702bb1cdf6e6d1f80776679b6e0f2745226efd76cda7563fe0f45ee1d1929d87", "attacker.near"),
            ("\"amount\":\"3000000\"", "\"amount\":\"30000000\""),
            ("\"minAmountOut\":\"2967275\"", "\"minAmountOut\":\"2967276\""),
            ("\"amountOutUsd\":\"2.995731392512\"", "\"amountOutUsd\":\"2.995731392513\""),
            ("\"refundTo\":\"dev1.near\"", "\"refundTo\":\"evil.near\""),
            ("\"deadline\":\"2026-11-12T06:00:00.000Z\"", "\"deadline\":\"2026-11-30T06:00:00.000Z\""),
            ("\"timestamp\":\"2026-11-08T20:25:36.811Z\"", "\"timestamp\":\"2026-11-10T20:25:36.811Z\""),
            ("\"refundFee\":\"4528\"", "\"refundFee\":\"1\""),
        ] {
            let tampered = LIVE.replacen(from, to, 1);
            assert_ne!(tampered, LIVE, "fixture must contain {from}");
            assert!(verify_quote(&tampered, &key()).is_err(), "editing {from} must break the signature");
        }
    }

    #[test]
    fn wrong_key_fails() {
        assert!(verify_quote(LIVE, &[7u8; 32]).unwrap_err().contains("does not verify"));
    }

    #[test]
    fn usd_parsing() {
        assert_eq!(parse_usd_micros("2.998482000000"), Some(2_998_482));
        assert_eq!(parse_usd_micros("10"), Some(10_000_000));
        assert_eq!(parse_usd_micros("0.1"), Some(100_000));
        assert_eq!(parse_usd_micros("1.9999999"), Some(1_999_999));
        for bad in ["", "-1", "1e5", "1.2.3", ".5", "abc"] {
            assert_eq!(parse_usd_micros(bad), None, "{bad}");
        }
    }

    #[test]
    fn rfc3339_parsing() {
        assert_eq!(parse_rfc3339_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_seconds("2026-11-08T20:25:36.811Z"), Some(1_794_169_536));
        assert!(parse_rfc3339_seconds("2026-11-08 20:25:36").is_none());
        assert!(parse_rfc3339_seconds("2026-13-08T20:25:36Z").is_none());
    }
}
