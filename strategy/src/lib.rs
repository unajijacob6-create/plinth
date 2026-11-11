//! Plinth strategy v1 (testnet): keep a two-token fund near 50% / 50% by USD value.
//!
//! Pure logic lives here so it can be tested natively against the fund contract's own verifier.
//! `main.rs` only reads stdin, fetches the NEAR price over HTTPS and prints the Decision.
//!
//! TESTNET STAND-IN: there is no 1Click on testnet, so this program builds the quote itself and
//! signs it with an ed25519 key compiled into the wasm. The wasm is public, so that key is public
//! too: it stands in for 1Click's manager key only for a testnet demo, never on mainnet.
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// 32-byte seed of the testnet stand-in signer (kept outside the source tree, mode 0600).
const SIGNER_SEED: &[u8; 32] = include_bytes!("../../.keys/strategy-signer.seed");

pub const TARGET_BPS: u128 = 5_000;
/// Rebalance only when the heavier side is above this share of the fund.
pub const BAND_BPS: u128 = 5_500;
/// Use this share of the mandate's per-trade cap, to stay clear of rounding.
pub const CAP_USE_PCT: u128 = 95;
/// Output is priced 0.3% under the mark; the floor is another 0.5% under that.
pub const HAIRCUT_BPS: u128 = 30;
pub const SLIPPAGE_BPS: u128 = 50;
const USD_DECIMALS: u32 = 6;
const NEAR_DECIMALS: u32 = 24;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub fn hold(reason: impl Into<String>) -> Value {
    json!({"action": "hold", "reason": reason.into()})
}

pub fn public_key() -> String {
    let key = SigningKey::from_bytes(SIGNER_SEED);
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

/// Find wNEAR's USD price in the 1Click token list (`GET /v0/tokens`: an array of
/// `{"assetId":"nep141:wrap.near","symbol":"wNEAR","price":3.59,...}`), as micro-USD per NEAR.
pub fn near_price_micros(tokens_json: &str) -> Result<u128, String> {
    let v: Value = serde_json::from_str(tokens_json).map_err(|e| format!("token list is not JSON: {e}"))?;
    let list = v.as_array().ok_or("token list is not an array")?;
    let entry = list
        .iter()
        .find(|t| t.get("assetId").and_then(Value::as_str) == Some("nep141:wrap.near"))
        .ok_or("token list has no nep141:wrap.near")?;
    let price = entry.get("price").ok_or("wNEAR has no price")?;
    let text = match price {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return Err("wNEAR price is not a number".into()),
    };
    let micros = parse_micros(&text).ok_or_else(|| format!("wNEAR price {text} is not a plain decimal"))?;
    // A sanity band, so a broken feed cannot drive a trade.
    if !(10_000..=1_000_000_000).contains(&micros) {
        return Err(format!("wNEAR price {text} is outside $0.01..$1000"));
    }
    Ok(micros)
}

/// "3.59" -> 3_590_000. Extra decimals are truncated. None for anything but a plain decimal.
fn parse_micros(s: &str) -> Option<u128> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut f: String = frac.chars().take(6).collect();
    while f.len() < 6 {
        f.push('0');
    }
    int.parse::<u128>().ok()?.checked_mul(1_000_000)?.checked_add(f.parse::<u128>().ok()?)
}

/// floor(a * b / c) without overflow for the sizes used here; None on overflow or c == 0.
fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    if let Some(p) = a.checked_mul(b) {
        return Some(p / c);
    }
    // a * b overflowed: split a = q*c + r.
    let (q, r) = (a / c, a % c);
    q.checked_mul(b)?.checked_add(r.checked_mul(b)? / c)
}

fn bps(part: u128, total: u128) -> u128 {
    mul_div(part, 10_000, total).unwrap_or(0)
}

fn pct(b: u128) -> String {
    format!("{}.{:02}%", b / 100, b % 100)
}

/// Units -> decimal string with `decimals` places, trailing zeros trimmed (at least one kept).
pub fn format_units(amount: u128, decimals: u32) -> String {
    let base = 10u128.pow(decimals);
    let frac = format!("{:0width$}", amount % base, width = decimals as usize);
    let frac = frac.trim_end_matches('0');
    format!("{}.{}", amount / base, if frac.is_empty() { "0" } else { frac })
}

fn usd_string(micros: u128) -> String {
    format!("{}.{:06}", micros / 1_000_000, micros % 1_000_000)
}

/// Unix seconds -> "YYYY-MM-DDTHH:MM:SS.000Z" (Howard Hinnant's civil_from_days).
pub fn iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
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

/// The string 1Click signs. Copied from the fund contract (`plinth::quote::signed_message`), with
/// `env::sha256` replaced by the `sha2` crate: base58(sha256(json)) over the SDK's field subset,
/// keys sorted, compact, optional fields dropped when JS would treat them as falsy.
pub fn signed_message(req: &Value, quote: &Value, timestamp: &str) -> Result<String, String> {
    let dry = req.get("dry").and_then(Value::as_bool).unwrap_or(true);
    let mut fields: BTreeMap<&str, Value> = BTreeMap::new();
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
    Ok(bs58::encode(Sha256::digest(json.as_bytes())).into_string())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// The fund's input, checked. Built before any network call, so a bad input costs no HTTP request.
#[derive(Debug, Clone, PartialEq)]
pub struct Input {
    pub fund: String,
    /// The fund's refund relay: where a failed swap's refund goes (`quoteRequest.refundTo`).
    pub refund_to: String,
    pub now: u64,
    pub trade_id: u64,
    pub tokens: [String; 2],
    pub held: [u128; 2],
    pub max_trade_bps: u128,
    pub max_cost_bps: u128,
}

/// NEAR's account id rule: 2..=64 of a-z 0-9, with single `-` `_` `.` separators inside.
pub fn is_account_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 64 {
        return false;
    }
    let mut last_sep = true;
    for &c in b {
        let sep = matches!(c, b'-' | b'_' | b'.');
        if sep {
            if last_sep {
                return false;
            }
        } else if !(c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return false;
        }
        last_sep = sep;
    }
    !last_sep
}

/// Parse and check the fund's stdin JSON. The error is the reason for a hold.
pub fn parse_input(input_json: &str) -> Result<Input, String> {
    let input: Value = serde_json::from_str(input_json).map_err(|e| format!("input is not JSON: {e}"))?;
    let fund = input.get("fund").and_then(Value::as_str).ok_or("input has no fund")?;
    if !is_account_id(fund) {
        return Err("input fund is not a valid account id".into());
    }
    let refund_to = input.get("refund_to").and_then(Value::as_str).ok_or("input has no refund_to (the fund's refund relay)")?;
    if !is_account_id(refund_to) {
        return Err("input refund_to is not a valid account id".into());
    }
    if refund_to == fund {
        return Err("input refund_to must be the fund's refund relay, not the fund itself".into());
    }
    let now = input.get("now").and_then(Value::as_u64).ok_or("input has no now")?;
    let trade_id = input.get("next_trade_id").and_then(Value::as_u64).ok_or("input has no next_trade_id")?;
    let token_list = input.get("tokens").and_then(Value::as_array).ok_or("input has no tokens")?;
    let held_list = input.get("held").and_then(Value::as_array).ok_or("input has no held")?;
    if token_list.len() != 2 || held_list.len() != 2 {
        return Err(format!("this strategy handles two-token funds (USD stable, wNEAR); this fund lists {}", token_list.len()));
    }
    let token = |i: usize| token_list[i].as_str().filter(|t| is_account_id(t)).map(str::to_string).ok_or("tokens is not a list of account ids");
    let amount = |i: usize| held_list[i].as_str().and_then(|s| s.parse::<u128>().ok()).ok_or("held is not a list of integer strings");
    let max_trade_bps = input.get("max_trade_bps").and_then(Value::as_u64).ok_or("input has no max_trade_bps")? as u128;
    let max_cost_bps = input.get("max_cost_bps").and_then(Value::as_u64).ok_or("input has no max_cost_bps")? as u128;
    Ok(Input { fund: fund.to_string(), refund_to: refund_to.to_string(), now, trade_id, tokens: [token(0)?, token(1)?], held: [amount(0)?, amount(1)?], max_trade_bps, max_cost_bps })
}

/// The Decision for this input at this NEAR price. Never panics; every problem is a hold.
pub fn decide(input_json: &str, near_price_micros: u128) -> Value {
    match parse_input(input_json).and_then(|i| decide_parsed(&i, near_price_micros)) {
        Ok(v) => v,
        Err(reason) => hold(reason),
    }
}

/// The Decision for an already checked input.
pub fn decide_parsed(input: &Input, price: u128) -> Result<Value, String> {
    let Input { fund, refund_to, now, trade_id, tokens, held, max_trade_bps, max_cost_bps } = input;
    let (now, trade_id, max_trade_bps, max_cost_bps) = (*now, *trade_id, *max_trade_bps, *max_cost_bps);
    if price == 0 {
        return Err("no NEAR price".into());
    }

    // USD value of each side in micro-USD: token0 is a $1 stable with 6 decimals, token1 is wNEAR.
    let v0 = held[0];
    let v1 = mul_div(held[1], price, ONE_NEAR).ok_or("holdings too large to value")?;
    let total = v0.checked_add(v1).ok_or("holdings too large to value")?;
    if total == 0 {
        return Err("the fund holds nothing".into());
    }
    let (w0, w1) = (bps(v0, total), bps(v1, total));
    let weights = format!("weights {} stable / {} wNEAR at NEAR ${}", pct(w0), pct(w1), usd_string(price));
    let sell = if w0 > BAND_BPS {
        0
    } else if w1 > BAND_BPS {
        1
    } else {
        return Ok(hold(format!("within the band: {weights}; rebalance only above {}", pct(BAND_BPS))));
    };
    let buy = 1 - sell;

    // Sell the excess over 50%, capped at 95% of what the mandate allows in one trade.
    let excess_usd = [v0, v1][sell] - total / 2;
    let wanted = if sell == 0 { excess_usd } else { mul_div(excess_usd, ONE_NEAR, price).ok_or("amount overflow")? };
    let cap = mul_div(mul_div(held[sell], max_trade_bps, 10_000).ok_or("cap overflow")?, CAP_USE_PCT, 100).ok_or("cap overflow")?;
    let amount_in = wanted.min(cap).min(held[sell]);
    if amount_in == 0 {
        return Err(format!("nothing to sell inside the mandate's cap: {weights}"));
    }

    // Price the output off the mark, 0.3% under it; the floor is 0.5% under the quoted output.
    let (in_usd, mark_out) = if sell == 0 {
        (amount_in, mul_div(amount_in, ONE_NEAR, price).ok_or("amount overflow")?)
    } else {
        let usd = mul_div(amount_in, price, ONE_NEAR).ok_or("amount overflow")?;
        (usd, usd)
    };
    let amount_out = mul_div(mark_out, 10_000 - HAIRCUT_BPS, 10_000).ok_or("amount overflow")?;
    let min_out = mul_div(amount_out, 10_000 - SLIPPAGE_BPS, 10_000).ok_or("amount overflow")?;
    let out_usd = if sell == 0 { mul_div(amount_out, price, ONE_NEAR).ok_or("amount overflow")? } else { amount_out };
    if in_usd == 0 || amount_out == 0 || min_out == 0 {
        return Err(format!("the trade would be dust: {weights}"));
    }
    // The contract's own cost rule (lib.rs `cost_bps`): refuse here what it would refuse there.
    let worst_out_usd = mul_div(out_usd, min_out, amount_out).ok_or("amount overflow")?;
    let cost = mul_div(in_usd.saturating_sub(worst_out_usd), 10_000, in_usd).ok_or("amount overflow")?;
    if cost > max_cost_bps {
        return Err(format!("this strategy's quote costs {cost} bps all-in; the mandate allows {max_cost_bps}"));
    }

    let (dec_in, dec_out) = if sell == 0 { (USD_DECIMALS, NEAR_DECIMALS) } else { (NEAR_DECIMALS, USD_DECIMALS) };
    // On testnet nobody fills the swap: the input is simply parked at this implicit account.
    let deposit_address = hex(&Sha256::digest(format!("plinth-strategy-deposit:{fund}:{trade_id}").as_bytes()));
    let req = json!({
        "dry": false, "depositMode": "SIMPLE", "swapType": "EXACT_INPUT", "slippageTolerance": SLIPPAGE_BPS as u64,
        "originAsset": format!("nep141:{}", tokens[sell]), "depositType": "ORIGIN_CHAIN",
        "destinationAsset": format!("nep141:{}", tokens[buy]),
        "amount": amount_in.to_string(), "refundTo": refund_to, "refundType": "ORIGIN_CHAIN", "recipient": fund,
        "recipientType": "DESTINATION_CHAIN", "deadline": iso(now + 600), "quoteWaitingTimeMs": 0,
        "customRecipientMsg": format!("trade:{trade_id}"),
    });
    let quote = json!({
        "amountIn": amount_in.to_string(), "amountInFormatted": format_units(amount_in, dec_in), "amountInUsd": usd_string(in_usd),
        "minAmountIn": amount_in.to_string(),
        "amountOut": amount_out.to_string(), "amountOutFormatted": format_units(amount_out, dec_out), "amountOutUsd": usd_string(out_usd),
        "minAmountOut": min_out.to_string(),
        "timeEstimate": 20, "refundFee": "0", "deadline": iso(now + 86_400), "timeWhenInactive": iso(now + 86_400),
        "depositAddress": deposit_address,
    });
    let timestamp = iso(now);
    let message = signed_message(&req, &quote, &timestamp)?;
    let signature = SigningKey::from_bytes(SIGNER_SEED).sign(message.as_bytes());
    let raw = json!({
        "quote": quote, "quoteRequest": req, "timestamp": timestamp,
        "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()),
    });
    Ok(json!({"action": "trade", "quote": raw.to_string()}))
}
