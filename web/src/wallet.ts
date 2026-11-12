// Testnet wallet connection (HOT near-connect; the selector lists the wallets it supports).
// The wallet library is loaded only when it is needed, so it never holds up reading the chain.
import type { NearConnector } from "@hot-labs/near-connect";

export const NETWORK = "testnet" as const;
let connector: Promise<NearConnector> | null = null;
let wallet: any = null;
let account = "";
const listeners: ((a: string) => void)[] = [];

const conn = () =>
  // Test builds only (VITE_PLINTH_TEST_WALLET=1, set by CI's smoke-test build): the smoke test supplies a
  // stand-in wallet here (web/tests/mock-wallet.js). The published site is built without it, so the
  // check below is compiled out and nothing on the live site can swap the wallet.
  (connector ??= (import.meta.env.VITE_PLINTH_TEST_WALLET === "1" && (window as any).__PLINTH_TEST_WALLET__ ? Promise.resolve((window as any).__PLINTH_TEST_WALLET__) : import("@hot-labs/near-connect")).then(({ NearConnector }) => {
    const c = new NearConnector({ network: NETWORK });
    c.on("wallet:signIn", async (p: any) => {
      wallet = p.wallet;
      set(p.accounts?.[0]?.accountId ?? "");
    });
    c.on("wallet:signOut", () => {
      wallet = null;
      set("");
    });
    return c;
  }));
const set = (a: string) => {
  if (a === account) return;
  account = a;
  listeners.forEach((f) => f(a));
};

export function onAccount(f: (a: string) => void) {
  listeners.push(f);
}

let restored: Promise<void> | null = null;
/** Pick up a wallet that is still signed in from an earlier visit. Safe to call more than once. */
export function restore(): Promise<void> {
  return (restored ??= (async () => {
    try {
      const c = await conn();
      const w = await c.wallet();
      if (w) {
        wallet = w;
        set((await w.getAccounts())?.[0]?.accountId ?? "");
      }
    } catch {
      /* not signed in, or the wallet library could not load: the page works read-only */
    }
  })());
}

export class ChainFailure extends Error {}

/** The person closed or refused the wallet prompt. A failure on chain is never a cancel. */
export const isCancel = (e: unknown) => !(e instanceof ChainFailure) && /user (rejected|denied|cancel+ed)|rejected (the|by the) (request|user)|request (was )?(rejected|cancel+ed)|cancel+ed by (the )?user|closed the (modal|window|popup)|modal (was )?closed|popup (was )?closed/i.test(String((e as any)?.message ?? e));

export async function signIn(): Promise<string> {
  const w = await (await conn()).connect();
  wallet = w;
  set((await w.getAccounts())?.[0]?.accountId ?? "");
  return account;
}

export async function signOut() {
  if (wallet) await (await conn()).disconnect(wallet);
  wallet = null;
  set("");
}

export interface Call {
  receiverId: string;
  methodName: string;
  args: object;
  deposit?: string;
  gas?: string;
}

/** True when the connected wallet says it can approve several transactions in one go. */
export const canBatch = (): boolean => wallet?.manifest?.features?.signAndSendTransactions === true;

/**
 * The contract's own words for why a transaction failed. Only the transaction's own result counts:
 * a redeem whose payout to you bounced is still a successful redeem (the amount becomes owed).
 */
function failureOf(outcome: any): string | null {
  const status = outcome?.status ?? outcome?.final_execution_status;
  const f = status && typeof status === "object" ? status.Failure : undefined;
  if (!f) return null;
  const text = JSON.stringify(f);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/) ?? text.match(/"ExecutionError":"([^"\\]+)/);
  return m ? m[1] : "the transaction failed on chain";
}

export interface Sent {
  /** Transaction hashes, in order, when the wallet returned them. */
  hashes: string[];
  /** What the last call returned, decoded, when it returned something readable. */
  value: unknown;
}
/** Thrown when some of several transactions went through before one failed or was refused. */
export class PartlySent extends Error {
  constructor(
    public cause: unknown,
    public done: number,
    public hashes: string[],
  ) {
    super(String((cause as any)?.message ?? cause));
  }
}

const hashOf = (o: any) => o?.transaction?.hash ?? o?.transaction_outcome?.id;

/**
 * Send one or more function calls; consecutive calls to the same receiver go in one transaction.
 * Several transactions are approved in one go only when the wallet says it can; otherwise they are
 * sent one by one, in order. Throws ChainFailure (with the contract's reason) when a transaction
 * failed, and PartlySent when an earlier one had already gone through.
 */
export async function send(calls: Call[]): Promise<Sent> {
  if (!wallet) await signIn();
  const txs: { receiverId: string; actions: any[] }[] = [];
  for (const c of calls) {
    const action = { type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: c.gas ?? "100000000000000", deposit: c.deposit ?? "0" } };
    const last = txs[txs.length - 1];
    if (last && last.receiverId === c.receiverId) last.actions.push(action);
    else txs.push({ receiverId: c.receiverId, actions: [action] });
  }
  const outcomes: any[] = [];
  if (txs.length > 1 && canBatch()) {
    const raw = await wallet.signAndSendTransactions({ transactions: txs });
    outcomes.push(...(Array.isArray(raw) ? raw : [raw]));
    for (const o of outcomes) {
      const why = failureOf(o);
      if (why) throw new ChainFailure(why);
    }
  } else {
    for (const tx of txs) {
      try {
        const o = await wallet.signAndSendTransaction(tx);
        const why = failureOf(o);
        if (why) throw new ChainFailure(why);
        outcomes.push(o);
      } catch (e) {
        if (outcomes.length) throw new PartlySent(e, outcomes.length, outcomes.map(hashOf).filter((h) => typeof h === "string"));
        throw e;
      }
    }
  }
  const hashes = outcomes.map(hashOf).filter((h) => typeof h === "string");
  let value: unknown;
  try {
    const sv = outcomes[outcomes.length - 1]?.status?.SuccessValue;
    if (typeof sv === "string" && sv) value = JSON.parse(atob(sv));
  } catch {
    value = undefined;
  }
  return { hashes, value };
}

export const currentAccount = () => account;
