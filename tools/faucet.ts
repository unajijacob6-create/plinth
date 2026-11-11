// Testnet only: top an account up from the public testnet faucet (each faucet account brings 10 NEAR).
//   npm run faucet -- <account.testnet> <NEAR wanted in total>
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { actions } from "near-api-js";
import { NEAR, NETWORK, formatNear, rpc, signer, txHash } from "./lib/near.ts";

if (NETWORK !== "testnet") throw new Error("the faucet exists on testnet only");
const [target, wantStr] = process.argv.slice(2);
if (!target || !wantStr) throw new Error("usage: npm run faucet -- <account.testnet> <NEAR wanted in total>");
const want = NEAR(Number(wantStr));
const balance = async (id: string) => BigInt((await rpc<any>("query", { request_type: "view_account", finality: "final", account_id: id })).amount);

while ((await balance(target)) < want) {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `plinth-faucet-${Date.now().toString(36)}.testnet`;
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`the testnet faucet refused: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const dir = path.join(process.env.HOME ?? "", ".near-credentials", "testnet");
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  for (let i = 0; i < 30 && !(await balance(id).catch(() => 0n)); i++) await new Promise((res) => setTimeout(res, 1000));
  const sent = await signer(id).signAndSendTransaction({ receiverId: target, actions: [actions.transfer(NEAR(9.9))], waitUntil: "FINAL", throwOnFailure: true } as any);
  console.log(`${id} -> ${target}: 9.9 NEAR (${txHash(sent)}); ${target} now has ${formatNear(await balance(target))} NEAR`);
}
console.log(`${target} has ${formatNear(await balance(target))} NEAR`);
