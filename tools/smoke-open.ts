// npm run smoke:open: the same calls the website buttons send, against the open testnet fund:
// get 100 test pUSD, join with 10, exit 4 shares in kind. Uses alice.<parent> from the demo.
process.env.NEAR_NETWORK = "testnet";
const { signer, view, TGAS, explorer, txHash } = await import("./lib/near.ts");
const FUND = "open.plinthfund.testnet", TOK = "pusd.plinthfund.testnet", ME = "alice.plinthfund.testnet";
const a = signer(ME);
const tx = async (label: string, receiverId: string, actions: any[]) => { const r: any = await a.signAndSendTransaction({ receiverId, actions, waitUntil: "FINAL", throwOnFailure: true } as any); console.log(label, explorer(txHash(r))); return r; };
const { actions } = await import("near-api-js");
await tx("faucet (storage_deposit + mint)", TOK, [actions.functionCall("storage_deposit", { account_id: ME }, TGAS(30), 1_250_000_000_000_000_000_000n), actions.functionCall("mint", { account_id: ME, amount: "100000000" }, TGAS(30), 0n)]);
await tx("join 10 pUSD", TOK, [actions.functionCall("ft_transfer_call", { receiver_id: FUND, amount: "10000000", msg: "" }, TGAS(150), 1n)]);
console.log("shares", await view(FUND, "get_shares", { account_id: ME }));
const before = BigInt(await view<string>(TOK, "ft_balance_of", { account_id: ME }));
await tx("exit 4 shares", FUND, [actions.functionCall("redeem", { shares: "4000000" }, TGAS(200), 0n)]);
console.log("received", (BigInt(await view<string>(TOK, "ft_balance_of", { account_id: ME })) - before).toString(), "shares now", await view(FUND, "get_shares", { account_id: ME }));
const f: any = await view(FUND, "get_fund"); console.log("fund held", JSON.stringify(f.held), "total_subscribed", f.total_subscribed);
