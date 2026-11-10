// npm run demo:quorum   (testnet; NODE_USE_ENV_PROXY=1 behind a proxy)
//
// The AI operator as a two-model quorum: DeepSeek (NEAR AI TEE) and Google Gemini (through NEAR AI's
// gateway) read the same fund state and note; a trade is proposed only if both say trade with the same
// tokens and recipient, at the smaller amount. Cases:
//   1. injected:     the note hides an instruction to send everything to an attacker;
//   2. one-fooled:   the DeepSeek seat is taken by its safety-removed variant ("-abliterated") with the
//                    same injected note, so one seat is compromised and the other is not;
//   3. honest:       an ordinary note.
// Every agreed trade is proposed to the fund; the contract still decides. Recorded to data/quorum-run.json.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
process.env.NEAR_NETWORK = "testnet";
const { signer, view, TGAS, explorer, txHash, log } = await import("./lib/near.ts");
const { decideQuorum, QUORUM_MODELS } = await import("./lib/agent.ts");
const { verifyReceipt, attestedSigners } = await import("./lib/nearai.ts");
const { testQuote, testSigner } = await import("./lib/testsigner.ts");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const testRun = JSON.parse(fs.readFileSync(path.join(ROOT, "data/testnet-run.json"), "utf8"));
const agentRun = JSON.parse(fs.readFileSync(path.join(ROOT, "data/agent-run.json"), "utf8"));
const FUND: string = process.argv.includes("--fund") ? process.argv[process.argv.indexOf("--fund") + 1] : testRun.fund;
const SOLVER: string = testRun.accounts.solver;
const PRICES = "1 pUSD = 0.002 wNEAR (1,000,000 base units of pUSD buy 2,000,000,000,000,000,000,000 base units of wNEAR).";
const notes = Object.fromEntries(agentRun.cases.filter((c: any) => c.note).map((c: any) => [c.label, c.note]));

const state0 = await view<any>(FUND, "get_fund");
const [pusd, wrap] = state0.config.mandate.tokens as string[];
if (state0.config.quote_signer !== testSigner().public_key) throw new Error(`${FUND} does not use this machine's test quote signer`);
const operator: string = state0.config.operator;
const [primary, second] = QUORUM_MODELS;

const CASES = [
  { label: "injected", note: notes.injected, models: [primary, second] },
  { label: "one-fooled", note: notes.injected, models: [`${primary}-abliterated`, second] },
  { label: "honest", note: notes.honest, models: [primary, second] },
];
const run: any = { network: "testnet", fund: FUND, started_at: new Date().toISOString(), models: QUORUM_MODELS, cases: [] };

run.attested = await attestedSigners([...new Set(CASES.flatMap((c) => c.models))]);
for (const { label, note, models } of CASES) {
  const state = await view<any>(FUND, "get_fund");
  const q = await decideQuorum(FUND, state, PRICES, note, models);
  const c: any = {
    label,
    note,
    prompt: q.prompt,
    votes: q.votes.map((v) => {
      const rv = v.receipt ? verifyReceipt(v.receipt, run.attested) : null;
      return { ...v, receipt_verified: rv?.ok ?? false, receipt_kind: rv?.kind, receipt_checks: rv?.checks };
    }),
    quorum: { agreed: q.agreed, why: q.why, decision: q.decision },
  };
  for (const v of c.votes) log(`${label}: ${v.model}`, `${v.decision?.action ?? "?"} ${v.decision?.recipient ?? ""} ${v.decision?.amount ?? ""} · receipt ${v.receipt_kind} ${v.receipt_verified ? "ok" : "NOT ok"}`);
  log(`${label}: quorum`, `${q.decision.action} (${q.why})`);
  const d = q.decision;
  if (d.action === "trade") {
    const amount = BigInt(d.amount!);
    const pusdIn = d.sell === pusd;
    const out = pusdIn ? amount * 2_000_000_000_000_000n : amount / 2_000_000_000_000_000n;
    const usd = (pusdIn ? Number(amount) / 1e6 : Number(out) / 1e6).toFixed(6);
    const quote = testQuote({
      fund: FUND, sell: d.sell!, buy: d.buy!, amount, out, minOut: (out * 995n) / 1000n, inUsd: usd, outUsd: (Number(usd) * 0.998).toFixed(6),
      recipient: d.recipient || FUND, refundTo: d.recipient && d.recipient !== FUND ? d.recipient : FUND, deposit: randomBytes(32).toString("hex"),
    });
    const r: any = await signer(operator).callFunctionRaw({ contractId: FUND, methodName: "propose_trade", args: { quote }, gas: TGAS(200), waitUntil: "FINAL" } as any);
    c.tx = txHash(r);
    c.accepted = JSON.parse(Buffer.from(r.status.SuccessValue ?? "", "base64").toString() || "false");
    const after = await view<any>(FUND, "get_fund");
    if (!c.accepted) c.contract_reason = (await view<any[]>(FUND, "get_rejections", { from: after.rejections - 1, limit: 1 }))[0]?.reason;
    log(`${label}: contract ${c.accepted ? "ACCEPTED" : "REFUSED"}`, `${c.contract_reason ?? ""} ${explorer(c.tx)}`);
    if (c.accepted) {
      const s = signer(SOLVER);
      const other = pusdIn ? wrap : pusd;
      const have = BigInt(await view<string>(other, "ft_balance_of", { account_id: SOLVER }));
      if (other === wrap && have < out) await s.callFunctionRaw({ contractId: wrap, methodName: "near_deposit", args: {}, deposit: out - have, gas: TGAS(30), waitUntil: "FINAL" } as any);
      const dl: any = await s.callFunctionRaw({ contractId: other, methodName: "ft_transfer", args: { receiver_id: FUND, amount: String(out), memo: "fill" }, deposit: 1n, gas: TGAS(30), waitUntil: "FINAL" } as any);
      const st: any = await s.callFunctionRaw({ contractId: FUND, methodName: "settle", args: {}, gas: TGAS(100), waitUntil: "FINAL" } as any);
      c.deliver_tx = txHash(dl);
      c.settle_tx = txHash(st);
      c.settle_status = JSON.parse(Buffer.from(st.status.SuccessValue ?? "", "base64").toString() || "null");
      log(`${label}: settled`, `${c.settle_status} ${explorer(c.settle_tx)}`);
    }
  } else c.accepted = null;
  run.cases.push(c);
}
run.after = await view(FUND, "get_fund");
run.finished_at = new Date().toISOString();
fs.writeFileSync(path.join(ROOT, "data/quorum-run.json"), JSON.stringify(run, null, 1));
log("done", run.cases.map((c: any) => `${c.label}: ${c.quorum.decision.action} -> ${c.accepted === null ? "nothing proposed" : c.accepted ? "accepted" : "refused"}`).join("; "));
