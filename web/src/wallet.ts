// Testnet wallet connection (HOT near-connect: works with MyNearWallet, Meteor, HOT, Intear and others).
import { NearConnector } from "@hot-labs/near-connect";

export const NETWORK = "testnet" as const;
let connector: NearConnector | null = null;
let wallet: any = null;
let account = "";
const listeners: ((a: string) => void)[] = [];

const conn = () => (connector ??= new NearConnector({ network: NETWORK }));
const set = (a: string) => {
  account = a;
  listeners.forEach((f) => f(a));
};

export function onAccount(f: (a: string) => void) {
  listeners.push(f);
  f(account);
}

export async function restore() {
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

/** Send one or more function calls; consecutive calls to the same receiver go in one transaction. */
export async function send(calls: Call[]): Promise<any[]> {
  if (!wallet) await signIn();
  const txs: { receiverId: string; actions: any[] }[] = [];
  for (const c of calls) {
    const action = { type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: c.gas ?? "100000000000000", deposit: c.deposit ?? "0" } };
    const last = txs[txs.length - 1];
    if (last && last.receiverId === c.receiverId) last.actions.push(action);
    else txs.push({ receiverId: c.receiverId, actions: [action] });
  }
  if (txs.length === 1) return [await wallet.signAndSendTransaction(txs[0])];
  return wallet.signAndSendTransactions({ transactions: txs });
}

export const currentAccount = () => account;
