// npm run smoke:open: the same calls the website buttons send, against the open testnet fund
// (data/open-fund.json, release 0.3): get 100 test pUSD, join, exit part in kind. Uses
// alice.<parent> from the demo.
//   - while the subscription window is open: join with 10 pUSD (ft_transfer_call, msg "");
//   - after it closed (the fund is open-ended): join in kind for 10,000,000 shares: open_basket,
//     push every token the fund holds in the fund's proportions (msg "basket"), join_in_kind,
//     withdraw_basket.
// Then redeem 4,000,000 shares in kind.
import fs from "node:fs";
import { actions } from "near-api-js";
process.env.NEAR_NETWORK = "testnet";
const { view, send, call, returned, chainSeconds, TGAS, explorer, txHash } = await import("./lib/near.ts");
const { ROOT, fundState, requireRelease03 } = await import("./lib/fund.ts");
const { basketAmounts } = await import("./lib/basket.ts");

const PARENT = process.env.PLINTH_PARENT ?? "plinthfund.testnet";
const FUND: string = JSON.parse(fs.readFileSync(`${ROOT}/data/open-fund.json`, "utf8")).fund;
const TOK = `pusd.${PARENT}`, WRAP = "wrap.testnet", ME = `alice.${PARENT}`;
const STORAGE = 1_250_000_000_000_000_000_000n;
const done = (label: string, r: any) => (console.log(label, explorer(txHash(r))), r);
const bal = async (token: string) => BigInt(await view<string>(token, "ft_balance_of", { account_id: ME }));

const f = await fundState(FUND);
requireRelease03(f, FUND);
const tokens = f.config.mandate.tokens;
done("faucet (storage_deposit + mint)", await send(ME, TOK, [actions.functionCall("storage_deposit", { account_id: ME }, TGAS(30), STORAGE), actions.functionCall("mint", { account_id: ME, amount: "100000000" }, TGAS(30), 0n)]));
// Registered on every token the fund holds, so an in-kind exit can pay all of them.
for (const token of tokens) {
  if (token !== TOK && (await view(token, "storage_balance_of", { account_id: ME })) === null) done(`register on ${token}`, await call(ME, token, "storage_deposit", { registration_only: true }, { deposit: STORAGE, gas: 30 }));
}

if ((await chainSeconds()) < f.config.mandate.subscription_closes_at) {
  const r = done("join 10 pUSD", await call(ME, TOK, "ft_transfer_call", { receiver_id: FUND, amount: "10000000", msg: "" }, { deposit: 1n, gas: 150 }));
  if (returned<string>(r) !== "10000000") throw new Error(`the fund kept ${returned(r)} of the 10000000 sent (outside its subscription limits?)`);
} else {
  if (!f.config.mandate.open_ended) throw new Error(`${FUND}: the subscription window is closed and the fund does not take in-kind joins`);
  if (f.pending) throw new Error(`${FUND}: trade ${f.pending.id} is in flight; join when it has settled`);
  if (BigInt(f.stranded_near ?? "0") > 0n) throw new Error(`${FUND}: NEAR from a failed stake is waiting to be wrapped (rewrap_stranded); join after that`);
  if ((f.joins_blocked_until ?? 0) >= (await chainSeconds())) throw new Error(`${FUND}: in-kind joins are blocked until ${new Date(f.joins_blocked_until! * 1000).toISOString()} (a written-off trade can still be refunded)`);
  const want = 10_000_000n;
  const amounts = basketAmounts(f.held.map(([, v]) => BigInt(v)), BigInt(f.total_shares!), want);
  for (const [i, token] of tokens.entries()) {
    if (amounts[i] === 0n) continue;
    const have = await bal(token);
    if (have >= amounts[i]) continue;
    if (token === WRAP) done("wrap NEAR", await call(ME, WRAP, "near_deposit", {}, { deposit: amounts[i] - have, gas: 30 }));
    else if (token === TOK) done("mint test pUSD", await call(ME, TOK, "mint", { account_id: ME, amount: String(amounts[i] - have) }, { gas: 30 }));
    else throw new Error(`an in-kind join for ${want} shares needs ${amounts[i]} of ${token}; ${ME} holds ${have}`);
  }
  done("open_basket", await call(ME, FUND, "open_basket", {}, { deposit: 5_000_000_000_000_000_000_000n, gas: 30 }));
  for (const [i, token] of tokens.entries()) {
    if (amounts[i] > 0n) done(`basket ${amounts[i]} ${token}`, await call(ME, token, "ft_transfer_call", { receiver_id: FUND, amount: String(amounts[i]), msg: "basket" }, { deposit: 1n, gas: 150 }));
  }
  console.log("basket", await view(FUND, "get_basket", { account_id: ME }));
  console.log("shares minted", returned(done("join_in_kind", await call(ME, FUND, "join_in_kind", { min_shares: String(want) }))));
  done("withdraw_basket (what the join did not take)", await call(ME, FUND, "withdraw_basket", {}, { gas: 150 }));
}
console.log("shares", await view(FUND, "get_shares", { account_id: ME }));
const before = await Promise.all(tokens.map(bal));
done("exit 4 shares", await call(ME, FUND, "redeem", { shares: "4000000" }, { gas: 200 }));
const after = await Promise.all(tokens.map(bal));
console.log("received", tokens.map((t, i) => `${after[i] - before[i]} ${t}`).join(", "), "shares now", await view(FUND, "get_shares", { account_id: ME }));
const end = await fundState(FUND);
console.log("fund held", JSON.stringify(end.held), "total_subscribed", end.total_subscribed);
