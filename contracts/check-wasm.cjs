"use strict";
// Plinth's immutability check: no exported method may reach any host call that changes code,
// keys, staking or deletes the account. Today the wasm imports none of them at all; the call graph
// check also covers a future build that links one in but never calls it. Over-approximates indirect calls and fails closed on unknown opcodes.
const fs = require("fs");
const { analyze } = require("./wasm-reach.cjs");
const FORBIDDEN = /deploy|use_global_contract|add_key|delete_key|delete_account|stake|state_init/;
let failed = false;
for (const file of process.argv.slice(2)) {
  const a = analyze(fs.readFileSync(file));
  const forbidden = a.importFuncNames.filter((n) => FORBIDDEN.test(n));
  console.log(`${file}: ${forbidden.length} code/key-changing host functions imported`);
  for (const imp of forbidden) {
    const r = a.exportsReaching(imp);
    console.log(`  ${imp}: reached by ${r.join(" ") || "(nothing)"}`);
    if (r.length) failed = true;
  }
  if (a.exports.contract_source_metadata === undefined) { console.error("  FAIL: no contract_source_metadata"); failed = true; }
}
if (failed) { console.error("FAIL: an export can reach a code/key-changing host call"); process.exit(1); }
console.log("ok: no export can change code, keys, stake or delete the account");
