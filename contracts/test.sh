#!/usr/bin/env bash
# Build Plinth and its factory, prove the fund wasm cannot change code or keys, and run the unit,
# sandbox, regression and factory tests.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
command -v cargo-near >/dev/null || { echo "cargo-near is required: https://github.com/near/cargo-near" >&2; exit 1; }
cargo near build non-reproducible-wasm --locked --manifest-path plinth/Cargo.toml
cargo near build non-reproducible-wasm --locked --manifest-path mock-ft/Cargo.toml
cargo near build non-reproducible-wasm --locked --manifest-path factory/Cargo.toml
node --test wasm-reach.test.cjs
node check-wasm.cjs target/near/plinth/plinth.wasm
sha256sum target/near/plinth/plinth.wasm
cargo test --locked -p plinth --lib
# The sandbox node wants 65535 open files; on capped containers preload a shim that clamps it.
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt 65535 ]; then
  [ -f target/librlimit_shim.so ] || cc -shared -fPIC -O2 -o target/librlimit_shim.so sandbox-rlimit-shim.c -ldl
  export LD_PRELOAD="$DIR/target/librlimit_shim.so"
fi
cargo test --locked -p plinth --test sandbox -- --nocapture
# The accounting bug of releases 0.1/0.2 as regression tests, the balance invariant, random steps.
cargo test --locked -p plinth --test regression -- --nocapture
cargo test --locked -p plinth-factory --test factory -- --nocapture
echo "plinth: all checks passed"
