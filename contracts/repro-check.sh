#!/usr/bin/env bash
# Rebuild every reproducible release in data/releases.json from its recorded commit, inside the
# pinned Docker image, and compare the hash with the one on record. Anyone can run this; CI does.
#   bash contracts/repro-check.sh            # every reproducible release
#   bash contracts/repro-check.sh <hash>     # one release, by its base58 hash
# Needs: docker, cargo-near 0.23, git history that includes the release commits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v cargo-near >/dev/null || { echo "cargo-near is required: https://github.com/near/cargo-near" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
want="${1:-}"
checked=0
failed=0
for hash in $(node -p "Object.entries(require('./data/releases.json').releases).filter(([h,r])=>r.reproducible).map(([h])=>h).join(' ')"); do
  [ -n "$want" ] && [ "$want" != "$hash" ] && continue
  commit=$(node -p "require('./data/releases.json').releases['$hash'].commit")
  version=$(node -p "require('./data/releases.json').releases['$hash'].version")
  dir="$(mktemp -d)"
  git worktree add -q --detach "$dir" "$commit"
  echo "release $version: rebuilding commit $commit in the pinned image..."
  if ! (cd "$dir/contracts" && cargo near build reproducible-wasm --manifest-path plinth/Cargo.toml >"$dir/build.log" 2>&1); then
    tail -40 "$dir/build.log" >&2
    echo "release $version: the build failed" >&2
    failed=$((failed + 1))
  else
    got=$(node -e "const b=require('fs').readFileSync('$dir/contracts/target/near/plinth/plinth.wasm');const h=require('crypto').createHash('sha256').update(b).digest();const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+h.toString('hex')),s='';while(n>0n){s=A[Number(n%58n)]+s;n/=58n}for(const x of h){if(x!==0)break;s='1'+s}console.log(s)")
    if [ "$got" = "$hash" ]; then
      echo "release $version: rebuilt bytes hash to $hash, as recorded"
    else
      echo "release $version: MISMATCH: rebuilt $got, recorded $hash" >&2
      failed=$((failed + 1))
    fi
  fi
  checked=$((checked + 1))
  git worktree remove --force "$dir"
done
[ "$checked" -gt 0 ] || { echo "no reproducible release found in data/releases.json${want:+ matching $want}" >&2; exit 1; }
[ "$failed" -eq 0 ] && echo "repro-check: $checked release(s) reproduced" || { echo "repro-check: $failed of $checked failed" >&2; exit 1; }
