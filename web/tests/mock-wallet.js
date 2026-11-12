// A stand-in for the wallet library, injected by the smoke test before the page loads. It signs
// nothing and sends nothing: it records what the page asked for and answers like a wallet would.
(() => {
  const M = (window.__mock ??= { account: "alice.plinthfund.testnet", signedIn: true, batch: false, txs: [], calls: 0, delay: 0 });
  const record = async (txs) => {
    M.calls++;
    M.txs.push(JSON.parse(JSON.stringify(txs)));
    if (window.__mockSent) await window.__mockSent();
    if (M.delay) await new Promise((r) => setTimeout(r, M.delay));
    if (M.reject) throw new Error("User rejected the request");
    return txs.map((t, i) => ({ transaction: { hash: `MOCKHASH${M.calls}${i}` }, status: { SuccessValue: M.successValue ?? "" }, receipts_outcome: [] }));
  };
  const wallet = () => ({
    manifest: { name: "test wallet", features: { signAndSendTransaction: true, signAndSendTransactions: !!M.batch } },
    async getAccounts() {
      return [{ accountId: M.account }];
    },
    async signAndSendTransaction(tx) {
      return (await record([tx]))[0];
    },
    async signAndSendTransactions({ transactions }) {
      return record(transactions);
    },
  });
  class NearConnector {
    constructor() {
      this.h = {};
    }
    on(ev, cb) {
      (this.h[ev] ??= []).push(cb);
    }
    async wallet() {
      if (!M.signedIn) throw new Error("not signed in");
      return wallet();
    }
    async connect() {
      M.signedIn = true;
      return wallet();
    }
    async disconnect() {
      M.signedIn = false;
    }
  }
  window.__PLINTH_TEST_WALLET__ = { NearConnector };
})();
