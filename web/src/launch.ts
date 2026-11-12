// "Launch a fund": a form that builds a fund's rules, checks them the way the contract will, and
// asks the factory to create the fund from the connected wallet.
import { view, account, settle, factoryOf, isAccountId, isEd25519Key, shortAccount, short, explorer, ONECLICK_KEY } from "./chain.ts";
import { UserError } from "./app.ts";
import { currentAccount, onAccount, signIn, send, isCancel } from "./wallet.ts";
import { loadMeta, readMeta, symbol, dec, units, parseUnits, pctOf, hasMeta } from "./tokens.ts";

const NET = "testnet" as const;
const MIN_FUND_NEAR = 5n * 10n ** 23n; // 0.5 NEAR, fixed by the factory
const RELAY_NEAR = 3n * 10n ** 22n; // 0.03 NEAR, what the fund's refund account starts with
const LIST_FEE = 3n * 10n ** 21n; // 0.003 NEAR, kept by the factory for its list of funds
const WNEAR = "wrap.testnet";
const DEFAULT_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Testnet tokens offered by name. Each one was read from the chain; the hint says what it is. */
const KNOWN: { id: string; hint: string }[] = [
  { id: "pusd.plinthfund.testnet", hint: "test dollar, free from the faucet above" },
  { id: "wrap.testnet", hint: "wrapped NEAR" },
  { id: "meta-v2.pool.testnet", hint: "staked NEAR from Meta Pool" },
  { id: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", hint: "testnet USDC" },
];

/** The program a manager-less testnet fund runs, when the repository has published one. */
export interface StrategyFile {
  outlayer: string;
  wasm_url: string;
  wasm_hash: string;
  max_instructions: number;
  max_execution_seconds: number;
  exclusive: boolean;
  quote_signer: string;
}
// Read only if the file exists: the page must build and work without it.
const file = Object.values(import.meta.glob("../../data/strategy-testnet.json", { eager: true, import: "default" }))[0] as any;
// The file keeps the mandate's strategy object under `strategy`, with the stand-in signer beside it.
const found = file && typeof file.strategy === "object" && file.strategy ? { ...file.strategy, quote_signer: file.quote_signer } : file;
/** The same checks the contract makes on a strategy, so a bad file disables the option instead of failing a launch. */
const strategyValid = (x: any): x is StrategyFile =>
  !!x &&
  typeof x === "object" &&
  typeof x.outlayer === "string" &&
  isAccountId(x.outlayer) &&
  typeof x.wasm_url === "string" &&
  x.wasm_url.startsWith("https://") &&
  x.wasm_url.length <= 512 &&
  typeof x.wasm_hash === "string" &&
  /^[0-9a-f]{64}$/.test(x.wasm_hash) &&
  Number.isSafeInteger(x.max_instructions) &&
  x.max_instructions > 0 &&
  Number.isInteger(x.max_execution_seconds) &&
  x.max_execution_seconds >= 1 &&
  x.max_execution_seconds <= 120 &&
  x.exclusive === true &&
  typeof x.quote_signer === "string" &&
  isEd25519Key(x.quote_signer);
export const STRATEGY: StrategyFile | null = strategyValid(found) ? found : null;

interface Values {
  name: string;
  base: string;
  others: string[];
  custom: string;
  trade: string;
  cost: string;
  perDay: string;
  gap: string;
  closes: string;
  min: string;
  max: string;
  fee: string;
  openEnded: boolean;
  manager: "me" | "other" | "none";
  operator: string;
  signer: string;
}
type Field = "name" | "tokens" | "custom" | "trade" | "cost" | "perDay" | "gap" | "closes" | "min" | "max" | "fee" | "operator" | "signer";

/** "1.5" percent to hundredths of a percent; null if it is not a number with at most two decimals. */
function hundredths(text: string): number | null {
  const v = parseUnits(text, 2);
  return v === null || v > 1_000_000n ? null : Number(v);
}
const whole = (text: string): number | null => (/^\d{1,10}$/.test(text.trim()) ? Number(text.trim()) : null);

export interface Built {
  errors: Partial<Record<Field, string>>;
  tokens: string[];
  config: any | null;
  fundId: string | null;
}

/** Everything the contract and the factory check before creating a fund, checked here first. */
export function build(v: Values, me: string, factory: string | null, customOk: boolean | null, storage: bigint, nowSeconds: number): Built {
  const errors: Built["errors"] = {};
  const name = v.name.trim();
  if (!/^[a-z0-9-]{2,30}$/.test(name) || name.startsWith("-") || name.endsWith("-")) errors.name = "Use 2 to 30 lowercase letters, digits or dashes. It cannot start or end with a dash.";
  const fundId = factory && !errors.name ? `${name}.${factory}` : null;
  if (!errors.name && !isAccountId(name)) errors.name = "Use letters and digits, with single dashes between them.";
  if (fundId && (fundId.length + 2 > 64 || !isAccountId(fundId) || !isAccountId(fundId.replace(".", "-r.")))) errors.name = errors.name ?? "That name does not make a valid account under the factory.";
  const custom = v.custom.trim().toLowerCase();
  const tokens = [v.base, ...v.others.filter((t) => t !== v.base), ...(custom ? [custom] : [])];
  if (tokens.length > 4) errors.tokens = "A fund holds at most 4 tokens, the base token included.";
  if (custom) {
    if (!isAccountId(custom)) errors.custom = "That is not a valid account name.";
    else if (tokens.indexOf(custom) !== tokens.length - 1) errors.custom = "That token is already selected.";
    else if (fundId && custom === fundId) errors.custom = "A fund cannot hold itself.";
    else if (customOk === false) errors.custom = "That account does not answer like a token, so the fund could not hold it.";
  }
  const trade = hundredths(v.trade);
  if (trade === null || trade < 1 || trade > 10_000) errors.trade = "Enter a percent from 0.01 to 100, with at most two decimals.";
  const cost = hundredths(v.cost);
  if (cost === null || cost > 10_000) errors.cost = "Enter a percent from 0 to 100, with at most two decimals.";
  const perDay = whole(v.perDay);
  if (perDay === null || perDay < 1 || perDay > 4_294_967_295) errors.perDay = "Enter a whole number, 1 or more.";
  const gap = whole(v.gap);
  if (gap === null || gap < 11 || gap > 525_600) errors.gap = "Enter whole minutes, 11 or more. Exits need a quiet moment between trades.";
  const closes = v.closes ? Math.floor(new Date(v.closes).getTime() / 1000) : NaN;
  if (!Number.isFinite(closes)) errors.closes = "Pick a date and time.";
  else if (closes < nowSeconds + 300) errors.closes = "The join window must end at least 5 minutes from now.";
  const d = dec(v.base);
  const min = parseUnits(v.min, d);
  const max = parseUnits(v.max, d);
  const cap = 2n ** 128n - 1n;
  if (min === null || min === 0n || min > cap) errors.min = `Enter an amount above zero, with at most ${d} decimal places.`;
  if (max === null || max === 0n || max > cap) errors.max = `Enter an amount above zero, with at most ${d} decimal places.`;
  else if (min !== null && min > max) errors.max = "This cannot be less than the smallest deposit.";
  const fee = hundredths(v.fee);
  if (fee === null || fee > 200) errors.fee = "Enter a percent from 0 to 2, with at most two decimals.";
  const operator = v.manager === "other" ? v.operator.trim().toLowerCase() : me;
  const signer = v.signer.trim();
  if (v.manager === "none") {
    // The published program balances a dollar token against wNEAR and nothing else.
    if (!STRATEGY) errors.tokens = "The program for funds without a manager is not published yet.";
    else if (!errors.tokens && (tokens.length !== 2 || tokens[1] !== WNEAR || !hasMeta(tokens[0]) || dec(tokens[0]) !== 6)) errors.tokens = "A fund without a manager needs exactly two tokens: a dollar token with 6 decimal places as the base, and wNEAR.";
  } else if (signer && !isEd25519Key(signer)) errors.signer = "That is not a signing key. Leave this empty to use NEAR Intents 1Click.";
  if (v.manager === "other") {
    if (!operator || !isAccountId(operator)) errors.operator = "Enter the manager's account name.";
    else if (fundId && operator === fundId) errors.operator = "The fund cannot manage itself.";
  }
  const ok = Object.keys(errors).length === 0 && !!operator && customOk !== false && (!custom || customOk === true);
  const config = ok
    ? {
        mandate: {
          tokens,
          max_trade_bps: trade,
          max_cost_bps: cost,
          min_seconds_between_trades: gap! * 60,
          max_trades_per_day: perDay,
          max_quote_age_seconds: 300,
          min_deadline_margin_seconds: 600,
          subscription_closes_at: closes,
          min_subscription: min!.toString(),
          max_total_subscriptions: max!.toString(),
          management_fee_bps: fee,
          open_ended: v.openEnded,
          ...(v.manager === "none" && STRATEGY
            ? { strategy: { outlayer: STRATEGY.outlayer, wasm_url: STRATEGY.wasm_url, wasm_hash: STRATEGY.wasm_hash, max_instructions: STRATEGY.max_instructions, max_execution_seconds: STRATEGY.max_execution_seconds, exclusive: true } }
            : {}),
        },
        operator,
        quote_signer: v.manager === "none" && STRATEGY ? STRATEGY.quote_signer : signer || ONECLICK_KEY,
        storage_deposit: storage.toString(),
      }
    : null;
  return { errors, tokens, config, fundId };
}

const localStamp = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export function mountLaunch(onCreated: (id: string) => void) {
  const root = document.getElementById("launch-form") as HTMLFormElement | null;
  if (!root) return;
  const factory = factoryOf(NET);
  const base0 = KNOWN[0].id;
  const tokenLabel = (t: string) => symbol(t);
  root.innerHTML = `
    <ol class="lprog" aria-label="Steps">
      ${["Name and tokens", "Trading rules", "Joining", "Manager and fee", "Review and launch"].map((t, i) => `<li><button type="button" data-go="${i}"><span class="lp-n" aria-hidden="true">${i + 1}</span><span class="lp-t">${t}</span></button></li>`).join("")}
    </ol>
    <div class="lstage">
      <fieldset class="lstep" data-step="0">
        <legend><span class="ls-n">Step 1 of 5</span>Name and tokens</legend>
        <div class="field"><label for="l-name">Fund name</label><input id="l-name" name="name" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="30" placeholder="my-fund" aria-describedby="l-name-h l-name-e" /><p class="hint" id="l-name-h">Becomes the fund's account. Lowercase letters, digits and dashes.</p><p class="err" id="l-name-e" role="alert"></p></div>
        <div class="field"><label for="l-base">Base token</label><select id="l-base" name="base" aria-describedby="l-base-h">${KNOWN.map((t) => `<option value="${t.id}">${esc(tokenLabel(t.id))}: ${esc(t.hint)}</option>`).join("")}</select><p class="hint" id="l-base-h">People join with this token during the join window.</p></div>
        <div class="field" role="group" aria-labelledby="l-others-l"><span class="label" id="l-others-l">Other tokens the fund may hold (up to 3)</span><div class="checks" id="l-others"></div>
          <label for="l-custom" class="sub-label">Another token, by account name (optional)</label><input id="l-custom" name="custom" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="token.testnet" aria-describedby="l-custom-e l-tokens-e" /><p class="hint" id="l-custom-ok"></p><p class="err" id="l-custom-e" role="alert"></p><p class="err" id="l-tokens-e" role="alert"></p></div>
      </fieldset>
      <fieldset class="lstep" data-step="1" hidden>
        <legend><span class="ls-n">Step 2 of 5</span>Trading rules</legend>
        <div class="pair">
          <div class="field"><label for="l-trade">Largest trade</label><div class="with-unit"><input id="l-trade" name="trade" inputmode="decimal" value="25" aria-describedby="l-trade-h l-trade-e" /><span>%</span></div><p class="hint" id="l-trade-h">Of the fund's holding of the token sold.</p><p class="err" id="l-trade-e" role="alert"></p></div>
          <div class="field"><label for="l-cost">Cost cap per trade</label><div class="with-unit"><input id="l-cost" name="cost" inputmode="decimal" value="1" aria-describedby="l-cost-h l-cost-e" /><span>%</span></div><p class="hint" id="l-cost-h">The most a trade may lose to fees and price.</p><p class="err" id="l-cost-e" role="alert"></p></div>
          <div class="field"><label for="l-perday">Trades per day</label><input id="l-perday" name="perDay" inputmode="numeric" value="6" aria-describedby="l-perday-e" /><p class="err" id="l-perday-e" role="alert"></p></div>
          <div class="field"><label for="l-gap">Minutes between trades</label><input id="l-gap" name="gap" inputmode="numeric" value="11" aria-describedby="l-gap-h l-gap-e" /><p class="hint" id="l-gap-h">At least 11.</p><p class="err" id="l-gap-e" role="alert"></p></div>
        </div>
      </fieldset>
      <fieldset class="lstep" data-step="2" hidden>
        <legend><span class="ls-n">Step 3 of 5</span>Joining</legend>
        <div class="field"><label for="l-closes">Join window ends</label><input id="l-closes" name="closes" type="datetime-local" aria-describedby="l-closes-h l-closes-e" /><p class="hint" id="l-closes-h">Your local time. Trading starts when the window ends.</p><p class="err" id="l-closes-e" role="alert"></p></div>
        <div class="pair">
          <div class="field"><label for="l-min">Smallest deposit</label><div class="with-unit"><input id="l-min" name="min" inputmode="decimal" value="1" aria-describedby="l-min-e" /><span data-base></span></div><p class="err" id="l-min-e" role="alert"></p></div>
          <div class="field"><label for="l-max">Most the fund accepts in total</label><div class="with-unit"><input id="l-max" name="max" inputmode="decimal" value="10000" aria-describedby="l-max-e" /><span data-base></span></div><p class="err" id="l-max-e" role="alert"></p></div>
        </div>
        <label class="check"><input type="checkbox" id="l-open" name="openEnded" checked /><span>Open to in-kind joins after the window<small>Later joiners add every token the fund holds, in its proportions. No price is used.</small></span></label>
      </fieldset>
      <fieldset class="lstep" data-step="3" hidden>
        <legend><span class="ls-n">Step 4 of 5</span>Manager and fee</legend>
        <div class="radios" role="radiogroup" aria-label="Who proposes trades">
          <label class="check"><input type="radio" name="manager" value="me" checked /><span>I manage it<small id="l-me">The connected account proposes trades. It can do nothing else.</small></span></label>
          <label class="check"><input type="radio" name="manager" value="other" /><span>Another account manages it</span></label>
          <div class="field" id="l-op-wrap" hidden><label for="l-operator" class="sub-label">Manager's account</label><input id="l-operator" name="operator" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="manager.testnet" aria-describedby="l-operator-e" /><p class="err" id="l-operator-e" role="alert"></p></div>
          <label class="check ${STRATEGY ? "" : "off"}"><input type="radio" name="manager" value="none" ${STRATEGY ? "" : "disabled"} aria-describedby="l-none-h" /><span>No manager: run a strategy<small id="l-none-h">${
            STRATEGY
              ? `Anyone can ask a fixed program for a proposal. It keeps a two-token fund near half and half by value, using the NEAR price from 1Click's public list, and only trades when one side is above 55%. Needs a dollar token with 6 decimal places as the base, and wNEAR. You only receive the fee.`
              : "Not available yet. The program a manager-less fund runs has not been published for testnet, and a fund's program can never be changed after launch."
          }</small></span></label>
        </div>
        <p class="err" id="l-mgr-e" role="alert"></p>
        <div class="field" id="l-signer-wrap"><label for="l-signer">Test signer key (optional)</label><input id="l-signer" name="signer" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="l-signer-h l-signer-e" /><p class="hint" id="l-signer-h">Leave empty to accept only quotes signed by NEAR Intents 1Click. 1Click does not run on testnet, so to trade here a fund needs a stand-in signer: paste its public key. The fund's card will say so.</p><p class="err" id="l-signer-e" role="alert"></p></div>
        <div class="field"><label for="l-fee">Yearly fee</label><div class="with-unit"><input id="l-fee" name="fee" inputmode="decimal" value="1" aria-describedby="l-fee-h l-fee-e" /><span>%</span></div><p class="hint" id="l-fee-h">From 0 to 2. Paid to the manager in new shares. There is no other fee.</p><p class="err" id="l-fee-e" role="alert"></p></div>
      </fieldset>
      <section class="lstep review" data-step="4" hidden aria-labelledby="l-review-h">
        <h3 class="legend" id="l-review-h"><span class="ls-n">Step 5 of 5</span>Review and launch</h3>
        <div class="summary" aria-live="polite">
          <p class="summary-h">What you are about to create</p>
          <div id="l-summary"></div>
          <div class="actions"><button class="btn primary" type="submit" id="l-submit"></button></div>
          <p class="status small" id="l-status" role="status"></p>
        </div>
      </section>
    </div>
    <div class="lnav">
      <button type="button" class="btn ghost sm" id="l-back">← Back</button>
      <p class="ln-count" id="l-count">Step 1 of 5</p>
      <button type="button" class="btn primary sm" id="l-next">Next <span class="arr" aria-hidden="true">→</span></button>
    </div>`;

  const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => root.querySelector(`#${id}`) as T;
  const touched = new Set<Field>();
  let submitted = false;
  let busy = false;
  /** null: not checked yet (or no custom token); true/false: what the chain said. */
  let customOk: boolean | null = null;
  let customChecked = "";
  let storage = DEFAULT_STORAGE;
  $("l-closes").value = localStamp(Date.now() + 7 * 86_400_000);

  const read = (): Values => {
    const fd = new FormData(root);
    return {
      name: String(fd.get("name") ?? ""),
      base: String(fd.get("base") ?? base0),
      others: fd.getAll("others").map(String),
      custom: String(fd.get("custom") ?? ""),
      trade: String(fd.get("trade") ?? ""),
      cost: String(fd.get("cost") ?? ""),
      perDay: String(fd.get("perDay") ?? ""),
      gap: String(fd.get("gap") ?? ""),
      closes: String(fd.get("closes") ?? ""),
      min: String(fd.get("min") ?? ""),
      max: String(fd.get("max") ?? ""),
      fee: String(fd.get("fee") ?? ""),
      openEnded: fd.get("openEnded") === "on",
      manager: fd.get("manager") === "other" ? "other" : fd.get("manager") === "none" && STRATEGY ? "none" : "me",
      operator: String(fd.get("operator") ?? ""),
      signer: String(fd.get("signer") ?? ""),
    };
  };

  /** What the factory asks for: the fund, its refund account, the list fee, and both accounts' token set-up. */
  const totalCost = (n: number) => MIN_FUND_NEAR + RELAY_NEAR + LIST_FEE + storage * BigInt(2 * n);
  const paintOthers = () => {
    const v = read();
    $<HTMLElement>("l-others").innerHTML = KNOWN.filter((t) => t.id !== v.base)
      .map((t) => `<label class="check"><input type="checkbox" name="others" value="${t.id}" ${v.others.includes(t.id) ? "checked" : ""} /><span>${esc(tokenLabel(t.id))}<small>${esc(t.hint)}</small></span></label>`)
      .join("");
    root.querySelectorAll("[data-base]").forEach((e) => (e.textContent = symbol(v.base)));
  };

  const ERR_IDS: Record<Field, [string, string]> = { name: ["l-name", "l-name-e"], tokens: ["l-custom", "l-tokens-e"], custom: ["l-custom", "l-custom-e"], trade: ["l-trade", "l-trade-e"], cost: ["l-cost", "l-cost-e"], perDay: ["l-perday", "l-perday-e"], gap: ["l-gap", "l-gap-e"], closes: ["l-closes", "l-closes-e"], min: ["l-min", "l-min-e"], max: ["l-max", "l-max-e"], fee: ["l-fee", "l-fee-e"], operator: ["l-operator", "l-operator-e"], signer: ["l-signer", "l-signer-e"] };

  function paint(): Built {
    const v = read();
    const me = currentAccount();
    const b = build(v, me, factory, customOk, storage, Math.floor(Date.now() / 1000));
    for (const [field, [inputId, errId]] of Object.entries(ERR_IDS) as [Field, [string, string]][]) {
      const show = (submitted || touched.has(field)) && b.errors[field];
      $<HTMLElement>(errId).textContent = show ? b.errors[field]! : "";
      if (field !== "tokens") $(inputId).setAttribute("aria-invalid", show ? "true" : "false");
    }
    $<HTMLElement>("l-op-wrap").hidden = v.manager !== "other";
    $<HTMLElement>("l-mgr-e").textContent = v.manager === "none" && b.errors.tokens ? b.errors.tokens : "";
    $<HTMLElement>("l-signer-wrap").hidden = v.manager === "none";
    $<HTMLElement>("l-me").textContent = me ? `${shortAccount(me)} proposes trades. It can do nothing else.` : "The account you connect proposes trades. It can do nothing else.";
    const custom = v.custom.trim().toLowerCase();
    $<HTMLElement>("l-custom-ok").textContent = custom && customOk === true && customChecked === custom ? `Found on chain: ${symbol(custom)}, ${dec(custom)} decimal places.` : custom && customOk === null && isAccountId(custom) ? "Checking this token on chain…" : "";

    // ---- plain-language summary, from the same numbers that will be sent
    const n = b.tokens.length;
    const cost = totalCost(n);
    const trade = hundredths(v.trade), costCap = hundredths(v.cost), perDay = whole(v.perDay), gap = whole(v.gap), fee = hundredths(v.fee);
    const closes = v.closes ? new Date(v.closes) : null;
    const d = dec(v.base);
    const min = parseUnits(v.min, d), max = parseUnits(v.max, d);
    const worst = trade !== null && costCap !== null && perDay !== null ? Math.min(10_000, Math.floor((trade * costCap * perDay) / 10_000)) : null;
    const operator = v.manager === "other" ? v.operator.trim().toLowerCase() : me;
    const who = operator && isAccountId(operator) ? esc(shortAccount(operator)) : v.manager === "other" ? "The manager" : "The account you connect";
    const feeWords = fee !== null && !b.errors.fee ? (fee > 0 ? `${pctOf(fee)} of the fund a year, in new shares` : "") : "";
    const names = b.tokens.map((t) => (hasMeta(t) ? symbol(t) : shortAccount(t)));
    const lines = [
      `<li><b>${b.fundId ? esc(shortAccount(b.fundId)) : v.name.trim() && !b.errors.name ? esc(v.name.trim()) : "Your fund"}</b> holds and trades only ${esc(names.join(", "))}.</li>`,
      closes && !b.errors.closes ? `<li>People join with ${esc(symbol(v.base))} until ${esc(closes.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }))}, your time. ${v.openEnded ? "After that, new people can still join by adding every token the fund holds, in its proportions." : "After that the fund takes no new joiners."}</li>` : "",
      min !== null && max !== null && !b.errors.min && !b.errors.max ? `<li>Deposits start at ${esc(units(min, d, 6))} ${esc(symbol(v.base))}. The fund accepts ${esc(units(max, d, 6))} ${esc(symbol(v.base))} in total.</li>` : "",
      trade !== null && costCap !== null && perDay !== null && gap !== null && !b.errors.trade && !b.errors.cost && !b.errors.perDay && !b.errors.gap
        ? `<li>One trade moves at most ${pctOf(trade)} of a holding and costs at most ${pctOf(costCap)}. At most ${perDay} ${perDay === 1 ? "trade" : "trades"} a day, ${gap} minutes apart. The most trading can cost a holding in one day: ${pctOf(worst!)}.</li>`
        : "",
      v.manager === "none" && STRATEGY
        ? `<li>No manager. Anyone can ask a fixed program (fingerprint ${esc(short(STRATEGY.wasm_hash, 8, 6))}) for a proposal; it keeps the two tokens near half and half by value. The fund cannot check on chain that the program ran in a secure enclave, so its answer is checked like any manager's proposal. ${who} ${feeWords ? `receives ${feeWords}, and nothing else` : "receives nothing"}.</li>`
        : `<li>${who} can only propose trades. ${feeWords ? `Pay: ${feeWords}.` : "No fee."}</li>`,
      v.manager === "none" && STRATEGY
        ? `<li>Test signer: the program signs its own stand-in quotes, because NEAR Intents 1Click does not run on testnet. The fund's card will say so.</li>`
        : v.signer.trim() && !b.errors.signer
          ? `<li>Test signer: quotes are signed by the key you pasted (${esc(short(v.signer.trim().replace(/^ed25519:/, ""), 6, 4))}), not by NEAR Intents. Testnet stand-in only; the fund's card will say so.</li>`
          : `<li>Trades need a quote signed by NEAR Intents 1Click. 1Click does not run on testnet, so this fund can take joins and exits but cannot trade here.</li>`,
      `<li>Everyone can exit at any time with their slice of every token. Nobody, including you, holds a key to the fund, and none of these rules can be changed later.</li>`,
    ].filter(Boolean);
    $<HTMLElement>("l-summary").innerHTML = `<ul class="plain">${lines.join("")}</ul><p class="cost">Cost: <b>${esc(units(cost, 24, 5))} NEAR</b> from your wallet, plus a small network fee.</p><ul class="breakdown small muted"><li><span>The fund, for storage and running costs</span><b>0.5 NEAR</b></li><li><span>Its refund account, a second keyless account that can only pass refunds on to the fund</span><b>0.03 NEAR</b></li><li><span>Setting both up on ${n} ${n === 1 ? "token" : "tokens"} (2 × ${n} × ${esc(units(storage, 24, 5))})</span><b>${esc(units(storage * BigInt(2 * n), 24, 5))} NEAR</b></li><li><span>The factory, for the fund's line in its list</span><b>0.003 NEAR</b></li></ul><p class="small muted">If the chain refuses the fund, the NEAR comes back, except what a refund account that was already created keeps.</p>`;
    const btn = $<HTMLButtonElement>("l-submit");
    btn.disabled = busy || !factory;
    btn.textContent = !factory ? "Launching is not open yet" : busy ? "Working…" : me ? `Launch fund for ${units(cost, 24, 5)} NEAR` : "Connect a wallet to launch";
    if (!factory && !busy) $<HTMLElement>("l-status").textContent = "The release 0.3 factory is not live on testnet yet, so nothing can be sent. You can still fill in the form: every rule is checked as you type.";
    return b;
  }

  /** Ask the chain whether the custom account is a token, and what each token charges to hold it. */
  async function checkChain(): Promise<void> {
    const v = read();
    const custom = v.custom.trim().toLowerCase();
    if (custom && isAccountId(custom) && customChecked !== custom) {
      customOk = null;
      paint();
      const m = await readMeta(NET, custom).catch(() => null);
      if (read().custom.trim().toLowerCase() !== custom) return;
      if (m) await loadMeta(NET, [custom]);
      customChecked = custom;
      customOk = !!m;
    } else if (!custom) {
      customOk = null;
      customChecked = "";
    }
    const tokens = [v.base, ...v.others, ...(custom && customOk ? [custom] : [])];
    const mins = await Promise.all(tokens.map((t) => view<any>(NET, t, "storage_balance_bounds").then((b) => (typeof b?.min === "string" ? BigInt(b.min) : 0n), () => 0n)));
    storage = mins.reduce((a, b) => (b > a ? b : a), DEFAULT_STORAGE);
    paint();
  }

  const fieldOf = (name: string): Field | null => (name === "others" || name === "base" || name === "manager" ? "tokens" : name in ERR_IDS ? (name as Field) : null);
  let timer = 0;
  const onEdit = (e: Event) => {
    const t = e.target as HTMLInputElement;
    const f = fieldOf(t.name);
    if (f) touched.add(f);
    if (t.name === "custom") {
      touched.add("tokens");
      if (t.value.trim().toLowerCase() !== customChecked) {
        customOk = null;
        customChecked = "";
      }
    }
    if (t.name === "base") {
      paintOthers();
      void loadMeta(NET, [t.value]).then(paint);
    }
    paint();
    if (t.name === "custom" || t.name === "base" || t.name === "others") {
      clearTimeout(timer);
      timer = window.setTimeout(() => void checkChain(), t.name === "custom" ? 500 : 0);
    }
  };
  root.addEventListener("input", onEdit);
  root.addEventListener("change", onEdit);

  const say = (msg: string, html = "") => {
    const st = $<HTMLElement>("l-status");
    st.textContent = msg;
    if (html) st.insertAdjacentHTML("beforeend", ` ${html}`);
  };

  // ---- one step at a time
  const STEPS: Field[][] = [["name", "tokens", "custom"], ["trade", "cost", "perDay", "gap"], ["closes", "min", "max"], ["operator", "signer", "fee", "tokens"]];
  const panels = [...root.querySelectorAll<HTMLElement>(".lstep")];
  const progress = [...root.querySelectorAll<HTMLButtonElement>(".lprog button")];
  const backBtn = $<HTMLButtonElement>("l-back");
  const nextBtn = $<HTMLButtonElement>("l-next");
  let step = 0;
  const badIn = (i: number, b: Built) => STEPS[i]?.find((f) => b.errors[f]);
  const stepOf = (f: Field) => (f === "tokens" || f === "custom" || f === "name" ? 0 : STEPS.findIndex((x) => x.includes(f)));
  const focusField = (f: Field) => {
    const id = f === "tokens" && step === 3 ? "" : ERR_IDS[f][0];
    const el = id ? $(id) : root.querySelector<HTMLElement>('input[name=manager][value=none]');
    el?.focus({ preventScroll: false });
  };
  function go(i: number) {
    const dir = i >= step ? "in-r" : "in-l";
    step = Math.max(0, Math.min(panels.length - 1, i));
    panels.forEach((p, j) => {
      p.hidden = j !== step;
      p.classList.remove("in-r", "in-l");
    });
    const p = panels[step];
    void p.offsetWidth;
    p.classList.add(dir);
    progress.forEach((b, j) => {
      b.setAttribute("aria-current", j === step ? "step" : "false");
      b.classList.toggle("done", j < step);
    });
    backBtn.hidden = step === 0;
    nextBtn.hidden = step === panels.length - 1;
    $<HTMLElement>("l-count").textContent = `Step ${step + 1} of ${panels.length}`;
    if (step === panels.length - 1) {
      paint();
      // The summary lines come in one by one, each time the review opens.
      const sum = $<HTMLElement>("l-summary");
      sum.classList.remove("play");
      void sum.offsetWidth;
      sum.classList.add("play");
    }
    const top = root!.getBoundingClientRect().top;
    if (top < 0 || top > innerHeight * 0.6) root!.scrollIntoView({ block: "start" });
  }
  async function next() {
    STEPS[step]?.forEach((f) => touched.add(f));
    let b = paint();
    // Only a custom token still being looked up needs the chain before moving on; the cost
    // read runs in the background and the review shows its result.
    const custom = read().custom.trim().toLowerCase();
    if (step === 0 && custom && customChecked !== custom) {
      await Promise.race([checkChain().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
      b = paint();
    } else if (step === 0) void checkChain().catch(() => {});
    const bad = badIn(step, b);
    if (bad) {
      const p = panels[step];
      p.classList.remove("nudge");
      void p.offsetWidth;
      p.classList.add("nudge");
      focusField(bad);
      return;
    }
    go(step + 1);
  }
  nextBtn.addEventListener("click", () => void next());
  backBtn.addEventListener("click", () => go(step - 1));
  progress.forEach((b, j) =>
    b.addEventListener("click", () => {
      if (j <= step) return go(j);
      // Forward only past steps that are already in order.
      const built = paint();
      for (let k = step; k < j; k++) {
        if (badIn(k, built)) {
          STEPS[k].forEach((f) => touched.add(f));
          paint();
          go(k);
          return;
        }
      }
      go(j);
    }),
  );
  go(0);

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Enter in a field before the last step means "Next".
    if (step < panels.length - 1) return void next();
    if (busy || !factory) return;
    // Set before anything is awaited, so a double click sends one request.
    busy = true;
    $<HTMLButtonElement>("l-submit").disabled = true;
    submitted = true;
    let me = currentAccount();
    if (!me) {
      say("Connect a testnet wallet to launch.");
      me = await signIn().catch(() => "");
      if (!me) {
        busy = false;
        paint();
        return;
      }
    }
    try {
      say("Checking the rules against the chain…");
      await checkChain();
      const b = paint();
      if (!b.config || !b.fundId) {
        const firstBad = (Object.keys(ERR_IDS) as Field[]).find((f) => b.errors[f]);
        if (firstBad) {
          go(stepOf(firstBad));
          focusField(firstBad);
        }
        throw new UserError("fix the fields marked above first");
      }
      // The same things the contract would refuse, asked before any NEAR moves.
      const [taken, relayTaken, op, mine] = await Promise.all([account(NET, b.fundId), account(NET, b.fundId.replace(".", "-r.")), account(NET, b.config.operator), account(NET, me)]);
      if (taken || relayTaken) throw new UserError(`the name ${read().name.trim()} is already taken; pick another`);
      if (!op) throw new UserError("the manager's account does not exist on testnet");
      const cost = totalCost(b.tokens.length);
      if (!mine || BigInt(mine.amount) < cost + 10n ** 23n) throw new UserError(`your wallet holds ${mine ? units(mine.amount, 24, 3) : "0"} NEAR; this needs ${units(cost, 24, 5)} NEAR plus a little for the network fee`);
      if (b.config.mandate.subscription_closes_at < Math.floor(Date.now() / 1000) + 300) throw new UserError("the join window must end at least 5 minutes from now");
      say("Waiting for your wallet…");
      const r = await send([{ receiverId: factory, methodName: "create_fund", args: { name: read().name.trim(), config: b.config }, deposit: cost.toString(), gas: "300000000000000" }]);
      // The factory answers with the new fund's name, or nothing when the chain refused it (and the NEAR
      // went back). A fresh account can take a few blocks to show up, so wait for it.
      if (r.value === null) throw new UserError("the fund was not created and your NEAR was sent back; the chain refused one of the rules");
      const made = await settle(() => account(NET, b.fundId!, "optimistic"), (x) => !!x);
      if (!made && r.value !== b.fundId) throw new UserError("the fund was not created and your NEAR was sent back; the chain refused one of the rules");
      say(`Created ${shortAccount(b.fundId)}. It has no keys. Checking it now.`, r.hashes[0] ? `<a href="${explorer(NET, r.hashes[0])}" target="_blank" rel="noopener">View transaction ↗</a>` : "");
      onCreated(b.fundId);
      root.reset();
      $("l-closes").value = localStamp(Date.now() + 7 * 86_400_000);
      submitted = false;
      touched.clear();
      paintOthers();
      go(0);
    } catch (err) {
      const raw = String((err as Error)?.message ?? err);
      say(isCancel(err) ? "Cancelled. Nothing was sent." : `Did not go through: ${err instanceof UserError ? raw : /[{}_()"]/.test(raw) || raw.length > 160 ? "the chain refused the request" : raw}.`);
    } finally {
      busy = false;
      paint();
    }
  });

  onAccount(() => paint());
  paintOthers();
  paint();
  void loadMeta(NET, KNOWN.map((t) => t.id)).then(() => {
    // Token names read from the chain replace the built-in ones.
    const sel = $<HTMLSelectElement>("l-base");
    const keep = sel.value;
    sel.innerHTML = KNOWN.map((t) => `<option value="${t.id}">${esc(tokenLabel(t.id))}: ${esc(t.hint)}</option>`).join("");
    sel.value = keep;
    paintOthers();
    paint();
    void checkChain();
  });
}
