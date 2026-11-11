// Testnet only: NEAR Intents 1Click has no testnet, so a local test key signs quotes in exactly
// 1Click's format (same fields, same signed-message rule). A fund created with this key's public
// key as `quote_signer` is labelled as a test fund by `npm run verify` and on the website.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { signedMessage, tradeMsg } from "./oneclick.ts";

const file = path.join(os.homedir(), ".near-credentials", "testnet", "plinth-test-quote-signer.json");

export function testSigner(): { secret_hex: string; public_key: string } {
  if (!fs.existsSync(file)) {
    const sk = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ secret_hex: sk.toString("hex"), public_key: `ed25519:${bs58.encode(ed25519.getPublicKey(sk))}` }), { mode: 0o600 });
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const iso = (s: number) => new Date(s * 1000).toISOString();

export interface TestQuote {
  fund: string;
  /** The fund's `get_fund().trades` when the quote is made: the id of the trade it will become. */
  tradeId: number;
  sell: string;
  buy: string;
  amount: bigint;
  out: bigint;
  minOut: bigint;
  inUsd: string;
  outUsd: string;
  /** Default: the fund. Anything else is refused by the contract (used to show exactly that). */
  recipient?: string;
  refundTo?: string;
  /** Leave the delivery message out or change it, to show the contract refusing it. Default `trade:<tradeId>`. */
  customRecipientMsg?: string | null;
  deposit: string;
  /** Sign with this key (64 hex characters) instead of the machine's test signer file. */
  secretHex?: string;
  /** Unix seconds the quote is dated (default: 5 s ago). */
  issuedAt?: number;
}

/** A live 1Click-format quote response (JSON text) signed by the test key. */
export function testQuote(o: TestQuote): string {
  const now = o.issuedAt ?? Math.floor(Date.now() / 1000) - 5;
  const msg = o.customRecipientMsg === undefined ? tradeMsg(o.tradeId) : o.customRecipientMsg;
  const req: any = {
    dry: false, depositMode: "SIMPLE", swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: `nep141:${o.sell}`, depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${o.buy}`, amount: String(o.amount), refundTo: o.refundTo ?? o.fund, refundType: "ORIGIN_CHAIN", recipient: o.recipient ?? o.fund,
    recipientType: "DESTINATION_CHAIN", deadline: iso(now + 600), quoteWaitingTimeMs: 0,
    ...(msg === null ? {} : { customRecipientMsg: msg }),
  };
  const q: any = {
    amountIn: String(o.amount), amountInFormatted: "", amountInUsd: o.inUsd, minAmountIn: String(o.amount), amountOut: String(o.out), amountOutFormatted: "",
    amountOutUsd: o.outUsd, minAmountOut: String(o.minOut), timeEstimate: 20, refundFee: "4500", deadline: iso(now + 3 * 86400), timeWhenInactive: iso(now + 3 * 86400), depositAddress: o.deposit,
  };
  const ts = iso(now);
  const sig = ed25519.sign(new TextEncoder().encode(signedMessage(req, q, ts)), Buffer.from(o.secretHex ?? testSigner().secret_hex, "hex"));
  return JSON.stringify({ quote: q, quoteRequest: req, timestamp: ts, signature: `ed25519:${bs58.encode(sig)}` });
}
