// Testnet wallet connection (HOT near-connect; the selector lists the wallets it supports).
import { NearConnector } from "@hot-labs/near-connect";

export const NETWORK = "testnet" as const;
let connector: NearConnector | null = null;
let wallet: any = null;
let account = "";
const listeners: ((a: string) => void)[] = [];

const conn = () => (connector ??= new NearConnector({ network: NETWORK }));
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
    const c = conn();
    c.on("wallet:signIn", async (p: any) => {
      wallet = p.wallet;
      set(p.accounts?.[0]?.accountId ?? "");
    });
    c.on("wallet:signOut", () => {
      wallet = null;
      set("");
    });
    try {
      const w = await c.wallet();
      if (w) {
        wallet = w;
        set((await w.getAccounts())?.[0]?.accountId ?? "");
      }
    } catch {
      /* not signed in */
    }
  })());
}

export const isCancel = (e: unknown) => /reject|cancel|closed|denied/i.test(String((e as any)?.message ?? e));

export async function signIn(): Promise<string> {
  const w = await conn().connect();
  wallet = w;
  set((await w.getAccounts())?.[0]?.accountId ?? "");
  return account;
}

export async function signOut() {
  if (wallet) await conn().disconnect(wallet);
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

/** The contract's own words for why a transaction failed, when the wallet handed the result back. */
function failureOf(outcome: any): string | null {
  const f = outcome?.status?.Failure ?? outcome?.final_execution_status?.Failure;
  const receipts: any[] = outcome?.receipts_outcome ?? [];
  const inner = receipts.map((r) => r?.outcome?.status?.Failure).find(Boolean);
  const any = f ?? inner;
  if (!any) return null;
  const text = JSON.stringify(any);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/) ?? text.match(/"ExecutionError":"([^"\\]+)/);
  return m ? m[1] : "the transaction failed on chain";
}

export class ChainFailure extends Error {}

export interface Sent {
  /** Transaction hashes, in order, when the wallet returned them. */
  hashes: string[];
  /** What the last call returned, decoded, when it returned something readable. */
  value: unknown;
}

/**
 * Send one or more function calls; consecutive calls to the same receiver go in one transaction.
 * Throws ChainFailure (with the contract's reason) when a transaction was sent and failed.
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
  const raw = txs.length === 1 ? [await wallet.signAndSendTransaction(txs[0])] : await wallet.signAndSendTransactions({ transactions: txs });
  const outcomes: any[] = Array.isArray(raw) ? raw : [raw];
  for (const o of outcomes) {
    const why = failureOf(o);
    if (why) throw new ChainFailure(why);
  }
  const hashes = outcomes.map((o) => o?.transaction?.hash ?? o?.transaction_outcome?.id).filter((h) => typeof h === "string");
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
