// Site smoke test: run against a served build (npm run web:preview) or any URL.
//   node web/tests/smoke.mjs [base url]
// Every page at phone and desktop width: loads, no console errors, no horizontal overflow, nothing that
// reads like code, 44px controls. Then what each page is for: Home's live numbers and links, the old
// ?fund= link redirecting into the app, the app's fund cards from the chain (old releases tagged, deep
// links), the verifier's verdicts, the launch form's checks without a wallet, the recorded runs on How
// it works (AI receipts verified in the browser), and the security page's known issue.
// Checks that need release 0.3 funds run only when data/releases.json names a testnet factory.
import { chromium } from "playwright";
import fs from "node:fs";

const base = (process.argv[2] ?? "http://localhost:4173/").replace(/\/?$/, "/");
const data = (f) => JSON.parse(fs.readFileSync(new URL(`../../data/${f}`, import.meta.url), "utf8"));
const releases = data("releases.json");
const factory = releases.factories?.testnet || null;
const run = data("testnet-run.json");
const recorded = run.fund;
// Which release the recorded fund runs, from the data: a factory fund reports it as global_contract_hash.
const recordedRelease = releases.releases[run.global_contract_hash ?? ""] ?? releases.releases[run.code_hash] ?? null;
const recordedLegacy = !!recordedRelease?.known_issue;
// A fund from before release 0.3, so the known-issue path is always covered.
const legacyFund = data("open-fund.json").previous?.fund ?? "open2.plinthfund.testnet";

const browser = await chromium.launch();
let failed = 0;
function check(cond, msg) {
  console.log(`${cond ? "[ok]  " : "[FAIL]"} ${msg}`);
  if (!cond) failed++;
}
// A rate-limited RPC node answers 429 without CORS headers; the browser logs that as a failed fetch
// and the page retries it. That is the node's weather, not a bug in the page: everything else fails.
const RPC_HOST = /rpc\.(testnet|mainnet)\.fastnear\.com/;
const rpcWeather = (text) => RPC_HOST.test(text) && /fetch|CORS|Access-Control|429|Too Many Requests|ERR_FAILED|Failed to load resource/i.test(text);
async function open(path, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !rpcWeather(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !rpcWeather(e.message) && errors.push(e.message));
  await page.goto(base + path, { waitUntil: "networkidle" });
  return { page, errors };
}
/** Poll a condition for up to `ms`, so a slow runner gets the same answer as a fast one. */
async function settle(fn, ms = 10000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}
/** Leaf elements whose text reads like code: braces, method names, raw units, long hashes or addresses. */
const codeLike = () =>
  [...document.querySelectorAll("body *")]
    .filter((e) => e.children.length === 0 && !["SCRIPT", "STYLE", "OPTION"].includes(e.tagName))
    .filter((e) => /[{}]|"action"|\d{8,}|0x[0-9a-f]{10}|\bbps\b|\b[a-z]+_[a-z_]+\b|[a-z_]+\(\)|\b[1-9A-HJ-NP-Za-km-z]{30,}\b|\b[0-9a-f]{40,}\b|TGas|yocto/.test(e.textContent || ""))
    .map((e) => (e.textContent || "").slice(0, 60));
/** What every page must get right. */
async function common(page, errors, name) {
  check((await page.title()).includes("Plinth"), `${name}: title`);
  const cta = page.locator(".site-h .nav-cta");
  check((await cta.getAttribute("href"))?.endsWith("app/"), `${name}: header has "Open the app"`);
  check((await page.locator(".site-f").count()) === 1, `${name}: shared footer`);
  const codey = await page.evaluate(codeLike);
  check(codey.length === 0, `${name}: no code-like text${codey.length ? ": " + codey.join(" | ") : ""}`);
  check((await page.$$("pre, code")).length === 0, `${name}: no code blocks`);
  const small = await page.$$eval("button, .btn, input:not([type=checkbox]):not([type=radio]), select, summary", (els) => els.filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height < 43.5).map((e) => (e.textContent || e.id || e.tagName).trim().slice(0, 30)));
  check(small.length === 0, `${name}: controls are at least 44px tall${small.length ? ": " + small.join(" | ") : ""}`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, `${name}: no horizontal overflow (${over}px)`);
  const inner = await page.$$eval("body *", (els) => els.filter((e) => { const cs = getComputedStyle(e); return (cs.overflowX === "auto" || cs.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 1 && cs.scrollbarWidth !== "none"; }).map((e) => String(e.className || e.tagName).slice(0, 40)));
  check(inner.length === 0, `${name}: no inner scrollbars${inner.length ? ": " + inner.join(" | ") : ""}`);
  check(errors.length === 0, `${name}: no console errors${errors.length ? ": " + errors.join(" | ").slice(0, 300) : ""}`);
}
const allLoaded = () => document.querySelectorAll(".fund").length > 0 && [...document.querySelectorAll(".fund")].every((e) => !e.classList.contains("loading"));

for (const [w, h, dev] of [[390, 844, "phone"], [1440, 900, "desktop"]]) {
  // ---------------------------------------------------------------- Home
  {
    const { page, errors } = await open("", w, h);
    const name = `${dev} home`;
    check((await page.textContent(".hero")).includes("testnet"), `${name}: says plainly it is testnet`);
    // The numbers count up when the panel scrolls into view: bring it into view first.
    await page.locator("#live").scrollIntoViewIfNeeded().catch(() => {});
    const nums = await settle(async () => {
      const hidden = await page.$eval("#live", (e) => e.hidden).catch(() => true);
      const v = await page.$$eval("#live .num", (els) => els.map((e) => e.textContent.trim()));
      return { ok: hidden || (v.length === 4 && v.every((x) => /^\d[\d,]*$/.test(x)) && (await page.getAttribute("#live", "aria-busy")) === "false"), v, hidden };
    }, 45000);
    if (nums.hidden) console.log(`[note] ${name}: the chain could not be read (rate limit); the live panel correctly hid itself instead of showing stale numbers`);
    check(nums.ok, `${name}: live numbers render from the chain, or the panel hides when it cannot read it (${(nums.v || []).join(", ")})`);
    // Counters run up to the number: wait for them to stop before reading.
    await page.locator("#live").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    const keys = await page.textContent('#live .num[data-k="keys"]');
    check(keys.trim() === "0", `${name}: access keys across the factory's funds is 0`);
    check((await page.$$(".steps4 .step")).length === 4, `${name}: four steps`);
    check((await page.$$("#proofs .proof")).length === 3, `${name}: three proof cards`);
    check((await page.$$(".faq details")).length >= 4, `${name}: FAQ`);
    if (w < 900) {
      const btn = page.locator("#menu-btn");
      await page.evaluate(() => scrollTo(0, 0));
      check(await btn.isVisible(), `${name}: menu button is shown`);
      check(!(await page.locator("#site-nav a").first().isVisible()), `${name}: menu starts closed`);
      await btn.click();
      check((await btn.getAttribute("aria-expanded")) === "true" && (await page.locator("#site-nav a").first().isVisible()), `${name}: menu opens`);
      await page.keyboard.press("Escape");
      check((await btn.getAttribute("aria-expanded")) === "false" && !(await page.locator("#site-nav a").first().isVisible()), `${name}: Escape closes the menu`);
    } else check(await page.locator('#site-nav a[href$="verify/"]').isVisible(), `${name}: navigation links are shown`);
    await common(page, errors, name);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator(".hero .btn.primary").click();
    await page.waitForURL(/\/app\/$/, { timeout: 15000 }).catch(() => {});
    check(new URL(page.url()).pathname.endsWith("/app/"), `${name}: "Open the app" goes to the app (${new URL(page.url()).pathname})`);
    await page.close();
  }
  // the old share link
  {
    const { page } = await open(`?fund=${legacyFund}`, w, h);
    await page.waitForURL(/\/app\/\?fund=/, { timeout: 15000 }).catch(() => {});
    const u = new URL(page.url());
    check(u.pathname.endsWith("/app/") && u.searchParams.get("fund") === legacyFund, `${dev}: /?fund= redirects to /app/?fund= (${u.pathname}${u.search})`);
    await page.close();
  }

  // ---------------------------------------------------------------- App
  {
    const { page, errors } = await open("app/", w, h);
    const name = `${dev} app`;
    await page.waitForFunction(allLoaded, null, { timeout: 60000 }).catch(() => {});
    await page.locator("#funds-legacy-wrap").evaluate((d) => (d.open = true));
    const legacyCards = await page.$$("#funds-legacy .fund .fund-h");
    check(legacyCards.length >= 1, `${name}: ${legacyCards.length} earlier funds render from the chain`);
    check((await page.$$("#funds-legacy .fund")).length === legacyCards.length, `${name}: every earlier fund loaded`);
    const tags = await page.$$eval("#funds-legacy .fund", (els) => els.map((e) => !!e.querySelector(".known-tag") && /Known issue: old release/.test(e.querySelector(".known-tag").textContent)));
    check(tags.length === legacyCards.length && tags.every(Boolean), `${name}: every earlier fund carries the known-issue tag`);
    check((await page.$$("#funds-new .fund .known-tag")).length === 0, `${name}: no fund outside the earlier group carries the tag`);
    check((await page.$$('#funds-legacy .known-tag a[href$="security/#limit-known"]')).length === legacyCards.length, `${name}: the tag links to the known issue on the security page`);
    check((await page.locator(`#funds-legacy .fund h3 a[title="${legacyFund}"]`).count()) === 1, `${name}: ${legacyFund} sits in the earlier group`);
    const allText = await page.textContent("#main");
    check(allText.includes("stNEAR"), `${name}: the earning fund shows its stNEAR`);
    check(allText.includes("0 keys"), `${name}: funds show 0 keys`);
    check(/shares? holds?/.test(allText) && allText.includes("Shares issued"), `${name}: cards explain what shares hold`);
    check(allText.includes("Running costs") && allText.includes("The most trading can cost a holding in one day"), `${name}: cards show running costs and the worst day`);
    const allCards = await page.$$(".fund");
    check((await page.$$(".fund [data-act=share]")).length === allCards.length, `${name}: every card has a Share link`);
    check((await page.$$('.fund a[href*="verify/?fund="]')).length === allCards.length, `${name}: every card links to the verifier`);
    await page.locator("#funds-legacy-wrap").evaluate((d) => (d.open = false));
    if (factory) {
      const fresh = await page.$$("#funds-new .fund .fund-h");
      check(fresh.length > 0, `${name}: funds from the factory render (${fresh.length})`);
      check(!(await page.locator("#funds-legacy-wrap").evaluate((d) => d.open)), `${name}: earlier funds are collapsed below the new ones`);
      check((await page.locator(`#funds-new .fund h3 a[title="${recorded}"]`).count()) === (recordedLegacy ? 0 : 1), `${name}: the recorded fund is listed ${recordedLegacy ? "among the earlier funds" : "with the factory funds"}`);
    } else {
      check(await page.locator("#funds-legacy-wrap").evaluate((d) => d.open), `${name}: with no factory, the earlier funds are shown open`);
      check(await page.locator("#funds-note").isVisible(), `${name}: the page says no release 0.3 fund is live yet`);
    }
    const sum = await settle(async () => {
      const v = await page.$$eval("#dash-summary b", (els) => els.map((e) => e.textContent.trim()));
      return { ok: v.length === 4 && v.every((x) => /^\d[\d,]*$/.test(x)), v };
    }, 30000);
    check(sum.ok, `${name}: four live numbers above the funds (${(sum.v || []).join(", ")})`);
    const cardTrades = await page.$$eval(".fund .kv", (els) => els.filter((e) => /Trades/.test(e.querySelector("span")?.textContent || "")).map((e) => Number(e.querySelector("b").textContent.split("·")[0])));
    check(Number((sum.v || [])[2]) === cardTrades.reduce((a, b) => a + b, 0), `${name}: the trades total equals the sum on the cards`);
    await common(page, errors, name);
    await page.close();
  }
  // deep link into the app
  {
    const { page, errors } = await open(`app/?fund=${legacyFund}`, w, h);
    const name = `${dev} app deep link`;
    await page.waitForSelector(".fund.focus .fund-h", { timeout: 45000 }).catch(() => {});
    check((await page.locator(".fund.focus h3 a").getAttribute("title").catch(() => "")) === legacyFund, `${name}: ?fund= highlights that fund's card`);
    check(await page.locator("#funds-legacy-wrap").evaluate((d) => d.open), `${name}: ?fund= opens the earlier group the fund is in`);
    // Cards above the linked one keep growing as the chain answers, so the page re-scrolls for a while.
    const scrolled = await settle(async () => {
      const top = await page.locator(".fund.focus").evaluate((e) => e.getBoundingClientRect().top).catch(() => 9999);
      return { ok: top > -50 && top < h, top };
    });
    check(scrolled.ok, `${name}: ?fund= scrolls to the card (top at ${Math.round(scrolled.top)}px)`);
    const href = await page.locator(".fund.focus [data-act=share]").getAttribute("href").catch(() => "");
    check(href.endsWith(`app/?fund=${legacyFund}`) || href.endsWith(`/f/${legacyFund}`), `${name}: the Share link points back to this fund`);
    check((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `${name}: no horizontal overflow`);
    check(errors.length === 0, `${name}: no console errors${errors.length ? ": " + errors.join(" | ").slice(0, 300) : ""}`);
    await page.close();
  }

  // ---------------------------------------------------------------- Verify
  {
    const { page, errors } = await open("verify/", w, h);
    const name = `${dev} verify`;
    if (factory) {
      const pre = await settle(async () => ({ ok: (await page.inputValue("#fund-id")) !== recorded }), 20000);
      const first = await page.inputValue("#fund-id");
      check(pre.ok && /\.funds\./.test(first) || first.endsWith(`.${factory}`), `${name}: prefilled with the newest factory fund (${first})`);
    }
    const verifyId = async (id) => {
      await page.fill("#fund-id", id);
      await page.click("#verify-form button[type=submit]");
      await page.waitForFunction(() => document.querySelector(".verdict") && !/^Reading/.test(document.querySelector("#verify-out").textContent), null, { timeout: 60000 });
      return page.textContent(".verdict");
    };
    const verdict = await verifyId(recorded);
    if (recordedLegacy) {
      check(!verdict.startsWith("Verified") && verdict.includes("known accounting bug"), `${name}: the verifier flags the recorded fund's release instead of passing it`);
      check(await page.locator("#verify-out .known-tag").isVisible(), `${name}: the verifier shows the known-issue tag`);
    } else {
      check(!verdict.startsWith("Not verified") && !verdict.includes("known accounting bug"), `${name}: the recorded fund (release ${recordedRelease?.version ?? "?"}) has no failed check and no known issue`);
      check((await page.textContent("#verify-out")).includes("Refunds can only go to this fund"), `${name}: the verifier checked the recorded fund's refund account`);
    }
    check(!(await page.locator(".verdict").evaluate((e) => e.classList.contains("ok"))) === (recordedLegacy || (await page.textContent("#verify-out")).includes("Test signer")), `${name}: the verdict is styled as a pass only for a clean fund with the real signer`);
    check((await page.textContent("#verify-out")).includes("Test signer"), `${name}: the verifier says quotes come from a test signer`);
    const old = await verifyId(legacyFund);
    check(!old.startsWith("Verified") && old.includes("known accounting bug"), `${name}: the verifier flags ${legacyFund} as an old release instead of passing it`);
    check(!(await page.locator(".verdict").evaluate((e) => e.classList.contains("ok"))), `${name}: that verdict is not styled as a pass`);
    check(await page.locator("#verify-out .known-tag").isVisible(), `${name}: the verifier shows the known-issue tag`);
    const bad = await verifyId("wrap.testnet");
    check(bad.startsWith("Not verified"), `${name}: the verifier refuses a contract that is not Plinth`);
    await common(page, errors, name);
    await page.close();
  }
  // verify deep link
  {
    const { page, errors } = await open(`verify/?fund=${legacyFund}`, w, h);
    const name = `${dev} verify deep link`;
    check((await page.inputValue("#fund-id")) === legacyFund, `${name}: ?fund= prefills the verifier`);
    await page.waitForSelector(".verdict", { timeout: 60000 }).catch(() => {});
    check(((await page.textContent(".verdict").catch(() => "")) || "").includes("known accounting bug"), `${name}: ?fund= runs the check straight away`);
    check(errors.length === 0, `${name}: no console errors${errors.length ? ": " + errors.join(" | ").slice(0, 300) : ""}`);
    await page.close();
  }

  // ---------------------------------------------------------------- Launch
  {
    const { page, errors } = await open("app/launch/", w, h);
    const name = `${dev} launch`;
    check((await page.$$("#launch-form fieldset")).length === 4 && (await page.$$("#launch-form .lstep")).length === 5, `${name}: the launch form renders as five steps`);
    const visibleStep = () => page.$eval("#launch-form .lstep:not([hidden])", (e) => Number(e.dataset.step));
    check((await visibleStep()) === 0, `${name}: it opens on step 1`);
    await page.click("#l-next");
    await page.waitForTimeout(300);
    check((await visibleStep()) === 0 && (await page.textContent("#l-name-e")).length > 10, `${name}: Next without a name stays on step 1 and says why`);
    await page.fill("#l-name", "Bad Name!");
    check((await page.textContent("#l-name-e")).length > 10, `${name}: a bad fund name is refused as you type`);
    await page.fill("#l-name", "my-fund");
    check((await page.textContent("#l-name-e")) === "", `${name}: a good fund name is accepted`);
    await page.click("#l-next");
    await page.waitForFunction(() => document.querySelector('#launch-form .lstep[data-step="1"]:not([hidden])'), null, { timeout: 15000 }).catch(() => {});
    check((await visibleStep()) === 1, `${name}: Next moves to the trading rules`);
    await page.fill("#l-gap", "5");
    check((await page.textContent("#l-gap-e")).includes("11"), `${name}: fewer than 11 minutes between trades is refused`);
    await page.click("#l-next");
    await page.waitForTimeout(200);
    check((await visibleStep()) === 1, `${name}: a broken rule keeps you on its step`);
    await page.fill("#l-gap", "11");
    await page.click("#l-next");
    await page.click("#l-next");
    check((await visibleStep()) === 3, `${name}: on to the manager and fee`);
    await page.fill("#l-fee", "3");
    check((await page.textContent("#l-fee-e")).length > 10, `${name}: a fee above 2% is refused`);
    await page.fill("#l-fee", "1");
    await page.click("#l-next");
    check((await visibleStep()) === 4, `${name}: the last step is the review`);
    await page.click("#l-back");
    check((await visibleStep()) === 3, `${name}: Back goes back one step`);
    await page.click("#l-next");
    const summary = await page.textContent("#l-summary");
    check(summary.includes("refund account") && /Cost: 0\.5\d+ NEAR/.test(summary) && summary.includes("my-fund"), `${name}: the summary shows the exact NEAR cost`);
    check((await page.locator("#l-submit").isDisabled()) === !factory, `${name}: launching is ${factory ? "open" : "closed until the factory is live"}`);
    await common(page, errors, name);
    await page.close();
  }

  // ---------------------------------------------------------------- How it works
  {
    const { page, errors } = await open("how/", w, h);
    const name = `${dev} how`;
    check((await page.$$(".steps [role=tab]")).length === 6, `${name}: six lifecycle steps`);
    check((await page.$$("#timeline li")).length >= 6, `${name}: the recorded run's timeline`);
    const receipts = await page.$$eval(".agent-case .okc, .agent-case .bad, .quorum-case .okc, .quorum-case .bad", (els) => els.map((e) => e.className.includes("okc")));
    check(receipts.length > 0 && receipts.every(Boolean), `${name}: ${receipts.length} NEAR AI receipts verify in the browser`);
    check((await page.$$(".quorum-case")).length === 3, `${name}: three quorum cases render`);
    check((await page.textContent("#quorum-cases")).includes("Quorum: hold"), `${name}: the quorum held on the injected note`);
    check((await page.$$(".quorum-case .vote")).length === 6, `${name}: each quorum case shows both model votes`);
    check((await page.$$(".carousel")).length === 2, `${name}: the cases are carousels`);
    const before = await page.$eval("#quorum-cases", (e) => e.scrollLeft);
    await page.locator("#quorum .car-btn").last().click();
    const moved = await settle(async () => ({ ok: (await page.$eval("#quorum-cases", (e) => e.scrollLeft)) > before + 50 }), 5000);
    check(moved.ok, `${name}: Next moves the quorum carousel`);
    await common(page, errors, name);
    await page.close();
  }

  // ---------------------------------------------------------------- Security
  {
    const { page, errors } = await open("security/", w, h);
    const name = `${dev} security`;
    check((await page.$$("#limit-known")).length === 1, `${name}: the known issue has its own section`);
    check((await page.textContent("#limit-known")).includes("0.1 and 0.2"), `${name}: it names the affected releases`);
    check((await page.$$("#limits .limits li")).length >= 8, `${name}: the limits are listed`);
    await common(page, errors, name);
    await page.close();
  }
}

// ---- the narrowest phones
for (const path of ["", "app/", "verify/", "how/", "security/", "app/launch/"]) {
  const { page } = await open(path, 360, 740);
  if (path === "app/") await page.waitForFunction(allLoaded, null, { timeout: 60000 }).catch(() => {});
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, `360px /${path}: no horizontal overflow (${over}px)`);
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all smoke checks passed");
process.exit(failed ? 1 : 0);
