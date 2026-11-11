// Creating and reading release 0.3 funds. A fund is created by the factory contract
// (contracts/factory): `create_fund` makes `<name>.<factory>` in one receipt with no AddKey, running
// the fund code published once as a global contract by hash.
import fs from "node:fs";
import path from "node:path";
import { NETWORK, accessKeyCount, accountExists, accountView, call, chainSeconds, eventsOf, explorer, formatNear, globalCode, log, returned, txHash, view, type Network } from "./near.ts";
import { creationDeposit, normaliseConfig, relayAccount, validateConfig, validateFundName, type Config } from "./config.ts";
import { hashToBase58, type ReleasesFile } from "./classify.ts";
import type { FundState, TradeView } from "./oneclick.ts";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const RELEASES_FILE = path.join(ROOT, "data/releases.json");

export const readReleases = (): ReleasesFile => JSON.parse(fs.readFileSync(RELEASES_FILE, "utf8"));

/** The factory that creates funds on `network`: `override`, else data/releases.json `factories`. */
export function factoryFor(network: Network = NETWORK, override?: string): string {
  const f = override ?? readReleases().factories?.[network];
  if (!f) throw new Error(`no factory for ${network}: data/releases.json has no factories.${network}. Deploy one with \`npm run factory:deploy\` or pass --factory <account>.`);
  return f;
}

export const fundState = (fund: string) => view<FundState>(fund, "get_fund");

/** The tools speak release 0.3 only (pushed trade output, no settle). Earlier funds are history. */
export function requireRelease03(s: FundState, fund: string): void {
  if (!s.version?.startsWith("0.3")) throw new Error(`${fund} reports version ${s.version ?? "(none: release 0.1 or 0.2)"}; these tools drive release 0.3 funds only. Depositors of an earlier fund can still redeem.`);
}

export const tradeById = async (fund: string, id: number): Promise<TradeView | undefined> => (await view<TradeView[]>(fund, "get_trades", { from: id, limit: 1 }))[0];

export interface Created {
  fund: string;
  /** The fund's refund relay, `<name>-r.<factory>`, created in the same call. */
  relay: string;
  factory: string;
  tx: string;
  /** The code hash the factory gives every fund (base58). */
  code_hash: string;
  /** NEAR attached in total (the fund's NEAR, its token registrations, the factory's list fee), yocto. */
  attached: string;
  access_keys: number;
  registered: boolean[];
  version: string | undefined;
}

/** Create `<name>.<factory>` through `factory.create_fund`, paid by `from`, and check the result:
 *  no access keys, the factory's code hash, registered on every token. `near` (yocto) is what the
 *  fund starts with (at least 0.5 NEAR); the relay's 0.03 NEAR, both accounts' registrations and the
 *  factory's 0.003 NEAR list fee are added. */
export async function createFund(o: { from: string; factory: string; name: string; config: Config; near: bigint }): Promise<Created> {
  const fund = `${o.name}.${o.factory}`;
  const config = normaliseConfig(o.config);
  const problems = [...validateFundName(o.name, o.factory), ...validateConfig(config, fund, await chainSeconds())];
  if (problems.length) throw new Error(`the fund would be refused:\n  - ${problems.join("\n  - ")}`);
  const { total } = creationDeposit(config, o.near);
  const codeHash = await view<string>(o.factory, "get_code_hash").catch((e) => {
    throw new Error(`${o.factory} is not a Plinth factory on ${NETWORK} (get_code_hash: ${(e as Error).message})`);
  });
  if (!(await globalCode(codeHash))) throw new Error(`the factory's fund code ${codeHash} is not published on ${NETWORK} (view_global_contract_code): no fund can be created yet`);
  const relay = relayAccount(o.name, o.factory);
  for (const id of [fund, relay]) if (await accountExists(id)) throw new Error(`${id} already exists; pick another --name`);

  const r = await call(o.from, o.factory, "create_fund", { name: o.name, config }, { deposit: total, gas: 300 });
  const tx = txHash(r);
  if (returned<string>(r) !== fund) {
    // The fund's `new` refused the config, or one of the two accounts could not be made: nothing is
    // listed and the factory sends back the NEAR of whatever failed.
    throw new Error(`the factory did not create ${fund} with its relay; of the ${formatNear(total)} NEAR attached, the part for whatever failed is sent back to ${o.from}. ${explorer(tx)}`);
  }
  const acct = await accountView(fund);
  const access_keys = await accessKeyCount(fund);
  const s = await fundState(fund);
  if (access_keys !== 0) throw new Error(`${fund} has ${access_keys} access keys; expected none`);
  // The relay: keyless, the same pinned code, serving this fund, and the one the fund will accept.
  const relayAcct = await accountView(relay);
  const relayKeys = await accessKeyCount(relay);
  const serves = await view<string>(relay, "relay_fund");
  if (relayKeys !== 0 || hashToBase58(relayAcct.global_contract_hash) !== codeHash || serves !== fund || s.config.refund_relay !== relay) {
    throw new Error(`${fund}'s refund relay ${relay} is not as intended: ${relayKeys} access keys, code ${relayAcct.global_contract_hash}, serves ${serves}, fund config names ${s.config.refund_relay}`);
  }
  if (hashToBase58(acct.global_contract_hash) !== codeHash) throw new Error(`${fund} does not run the factory's code ${codeHash} (account view: ${JSON.stringify(acct)})`);
  const missing = (s.registered ?? []).flatMap((ok, i) => (ok ? [] : [s.config.mandate.tokens[i]]));
  if (missing.length) log("WARNING", `the fund's registration failed on ${missing.join(", ")}; anyone can retry with register({token_index})`);
  return { fund, relay, factory: o.factory, tx, code_hash: codeHash, attached: String(total), access_keys, registered: s.registered ?? [], version: s.version };
}

/** The fund's refund relay, as the fund reports it. */
export function relayOf(s: FundState, fund: string): string {
  if (!s.config.refund_relay) throw new Error(`${fund} reports no refund relay`);
  return s.config.refund_relay;
}

/** The fund's own events (`standard: "plinth"`) a transaction emitted, in order. */
export const plinthEvents = (r: unknown) => eventsOf(r).filter((e) => e.standard === "plinth");

/** Wait until the chain time passes `untilS` (the subscription window closing, a cooldown). */
export async function waitForChainTime(untilS: number, pollMs = 3000): Promise<void> {
  while ((await chainSeconds()) < untilS) await new Promise((r) => setTimeout(r, pollMs));
}
