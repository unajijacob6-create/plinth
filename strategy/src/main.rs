//! OutLayer entry point (wasm32-wasip2): stdin = the fund's input JSON, stdout = one Decision JSON.
use std::io::{self, Read, Write};

const TOKENS_URL: &str = "https://1click.chaindefuser.com/v0/tokens";

#[cfg(target_os = "wasi")]
fn fetch_tokens() -> Result<String, String> {
    use std::time::Duration;
    let resp = wasi_http_client::Client::new()
        .get(TOKENS_URL)
        .connect_timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("price request failed: {e:?}"))?;
    let status = resp.status();
    if status != 200 {
        return Err(format!("price request returned HTTP {status}"));
    }
    let body = resp.body().map_err(|e| format!("price response unreadable: {e:?}"))?;
    String::from_utf8(body).map_err(|_| "price response is not UTF-8".to_string())
}

#[cfg(not(target_os = "wasi"))]
fn fetch_tokens() -> Result<String, String> {
    // Native runs (tests, debugging): the token list comes from a file.
    let path = std::env::var("TOKENS_FILE").map_err(|_| format!("native build: set TOKENS_FILE to a saved copy of {TOKENS_URL}"))?;
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn main() {
    let mut raw = String::new();
    let decision = match io::stdin().read_to_string(&mut raw) {
        Err(e) => plinth_strategy_v1::hold(format!("cannot read input: {e}")),
        // The input is checked first: a bad one is a hold without any network call.
        Ok(_) => match plinth_strategy_v1::parse_input(&raw) {
            Err(reason) => plinth_strategy_v1::hold(reason),
            Ok(input) => match fetch_tokens().and_then(|t| plinth_strategy_v1::near_price_micros(&t)) {
                Ok(price) => plinth_strategy_v1::decide_parsed(&input, price).unwrap_or_else(plinth_strategy_v1::hold),
                Err(e) => plinth_strategy_v1::hold(format!("no NEAR price, so no trade: {e}")),
            },
        },
    };
    let mut out = io::stdout();
    let _ = out.write_all(decision.to_string().as_bytes());
    let _ = out.flush();
}
