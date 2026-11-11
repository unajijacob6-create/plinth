// Site smoke test: run against a served build (npm run web:preview) or any URL.
//   node web/tests/smoke.mjs [url]
// Checks at phone and desktop width: no console errors, no horizontal overflow, the fund cards
// render from testnet RPC, old-release funds carry their known-issue tag, the in-browser verifier
// does not pass an old-release fund as clean, the ?fund= deep link, the phone menu, the launch form's
// validation without a wallet, the AI operator receipts, and that nothing on the page reads like code.
// Checks that need release 0.3 funds run only when data/releases.json names a testnet factory.
import { chromium } from "playwright";
import fs from "node:fs";

const url = process.argv[2] ?? "http://localhost:4173/";
const data = (f) => JSON.parse(fs.readFileSync(new URL(`../../data/${f}`, import.meta.url), "utf8"));
const releases = data("releases.json");
const factory = releases.factories?.testnet || null;
const legacy = [data("open-fund.json").fund, data("testnet-run.json").fund, data("earn-run.json").fund];
const recorded = data("testnet-run.json").fund;

const browser = await chromium.launch();
let failed = 0;
function check(cond, msg) {
  console.log(`${cond ? "[ok]  " : "[FAIL]"} ${msg}`);
  if (!cond) failed++;
}
/** Leaf elements whose text reads like code: braces, method names, raw units, long hashes or addresses. */
const codeLike = () =>
  [...document.querySelectorAll("body *")]
    .filter((e) => e.children.length === 0 && !["SCRIPT", "STYLE", "OPTION"].includes(e.tagName))
    .filter((e) => /[{}]|"action"|\d{8,}|0x[0-9a-f]{10}|\bbps\b|\b[a-z]+_[a-z_]+\b|[a-z_]+\(\)|\b[1-9A-HJ-NP-Za-km-z]{30,}\b|\b[0-9a-f]{40,}\b|TGas|yocto/.test(e.textContent || ""))
    .map((e) => (e.textContent || "").slice(0, 60));
const watch = (page) => {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const [w, h, name] of [[390, 844, "phone"], [1440, 900, "desktop"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = watch(page);
  await page.goto(url, { waitUntil: "networkidle" });
  check((await page.title()).includes("Plinth"), `${name}: title`);

  // ---- hero and navigation
  check((await page.locator(".hero .btn.primary").textContent()).includes("Try it on testnet"), `${name}: hero's main button is "Try it on testnet"`);
  if (w < 800) {
    const btn = page.locator("#menu-btn");
    check(await btn.isVisible(), `${name}: menu button is shown`);
    check(!(await page.locator("#site-nav a").first().isVisible()), `${name}: menu starts closed`);
    await btn.click();
    check((await btn.getAttribute("aria-expanded")) === "true" && (await page.locator("#site-nav a").first().isVisible()), `${name}: menu opens`);
    await page.keyboard.press("Escape");
    check((await btn.getAttribute("aria-expanded")) === "false" && !(await page.locator("#site-nav a").first().isVisible()), `${name}: Escape closes the menu`);
    await btn.click();
    await page.locator('#site-nav a[href="#limits"]').click();
    check((await btn.getAttribute("aria-expanded")) === "false", `${name}: tapping a link closes the menu`);
  } else {
    check(await page.locator('#site-nav a[href="#launch"]').isVisible(), `${name}: navigation links are shown`);
  }

  // ---- fund cards from the chain
  await page.waitForFunction((n) => document.querySelectorAll("#funds-legacy .fund .fund-h").length === n, legacy.length, { timeout: 45000 }).catch(() => {});
  check((await page.$$("#funds-legacy .fund .fund-h")).length === legacy.length, `${name}: ${legacy.length} earlier funds render from the chain`);
  const tags = await page.$$eval("#funds-legacy .fund", (els) => els.map((e) => !!e.querySelector(".known-tag") && /Known issue: old release/.test(e.querySelector(".known-tag").textContent)));
  check(tags.length === legacy.length && tags.every(Boolean), `${name}: every earlier fund carries the known-issue tag`);
  check((await page.$$('#funds-legacy .known-tag a[href="#limit-known"]')).length === legacy.length && (await page.$$("#limit-known")).length === 1, `${name}: the tag links to the limit`);
  const legacyText = await page.textContent("#funds-legacy");
  check(legacyText.includes("stNEAR"), `${name}: the earning fund shows its stNEAR`);
  check(legacyText.includes("0 keys"), `${name}: funds show 0 keys`);
  check(/shares? holds?/.test(legacyText) && legacyText.includes("Shares issued"), `${name}: cards explain what shares hold`);
  check(legacyText.includes("Running costs") && legacyText.includes("The most trading can cost a holding in one day"), `${name}: cards show running costs and the worst day`);
  check((await page.$$("#funds-legacy [data-act=share]")).length === legacy.length, `${name}: every card has a Share link`);
  if (factory) {
    await page.waitForSelector("#funds-new .fund .fund-h", { timeout: 45000 }).catch(() => {});
    const fresh = await page.$$("#funds-new .fund .fund-h");
    check(fresh.length > 0, `${name}: funds from the factory render (${fresh.length})`);
    check((await page.$$("#funds-new .fund .known-tag")).length === 0, `${name}: factory funds carry no known-issue tag`);
    check(!(await page.locator("#funds-legacy-wrap").evaluate((d) => d.open)) || fresh.length === 0, `${name}: earlier funds are collapsed below the new ones`);
    const first = await page.locator("#funds-new .fund h3 a").first().getAttribute("title");
    check((await page.inputValue("#fund-id")) === first, `${name}: the verifier is prefilled with the newest factory fund`);
  } else {
    check(await page.locator("#funds-legacy-wrap").evaluate((d) => d.open), `${name}: with no factory, the earlier funds are shown open`);
    check(await page.locator("#funds-note").isVisible(), `${name}: the page says no release 0.3 fund is live yet`);
  }

  // ---- live stats
  await page.waitForFunction(() => document.querySelector("#stats")?.getAttribute("aria-busy") === "false", null, { timeout: 45000 }).catch(() => {});
  const stats = await page.$$eval("#stats .stat b", (els) => els.map((e) => e.textContent.trim()));
  check(stats.length === 4 && stats.every((s) => /^\d+$/.test(s)), `${name}: four live numbers in the stats strip (${stats.join(", ")})`);
  const cardTrades = await page.$$eval(".fund .kv", (els) => els.filter((e) => /Trades/.test(e.querySelector("span")?.textContent || "")).map((e) => Number(e.querySelector("b").textContent.split("·")[0])));
  check(Number(stats[2]) === cardTrades.reduce((a, b) => a + b, 0), `${name}: the trades total equals the sum on the cards`);

  // ---- verifier: an old-release fund must not read as a clean pass
  await page.fill("#fund-id", recorded);
  await page.click("#verify-form button[type=submit]");
  await page.waitForSelector(".verdict", { timeout: 45000 });
  const verdict = await page.textContent(".verdict");
  check(!verdict.startsWith("Verified") && verdict.includes("known accounting bug"), `${name}: the verifier flags the recorded fund's release instead of passing it`);
  check(!(await page.locator(".verdict").evaluate((e) => e.classList.contains("ok"))), `${name}: that verdict is not styled as a pass`);
  check(await page.locator("#verify-out .known-tag").isVisible(), `${name}: the verifier shows the known-issue tag`);
  check((await page.textContent("#verify-out")).includes("Test signer"), `${name}: the verifier says quotes come from a test signer`);
  await page.fill("#fund-id", "wrap.testnet");
  await page.click("#verify-form button[type=submit]");
  await page.waitForFunction(() => document.querySelector(".verdict")?.classList.contains("bad"), null, { timeout: 45000 }).catch(() => {});
  check((await page.textContent(".verdict")).startsWith("Not verified"), `${name}: the verifier refuses a contract that is not Plinth`);
  if (factory) {
    const first = await page.locator("#funds-new .fund h3 a").first().getAttribute("title");
    await page.fill("#fund-id", first);
    await page.click("#verify-form button[type=submit]");
    await page.waitForFunction(() => document.querySelector(".verdict") && !document.querySelector(".verdict").textContent.startsWith("Not verified"), null, { timeout: 45000 }).catch(() => {});
    const v = await page.textContent(".verdict");
    check(!v.includes("known accounting bug") && !v.startsWith("Not verified"), `${name}: the newest factory fund has no failed check and no known issue`);
    check(v.startsWith("Verified") !== (await page.textContent("#verify-out")).includes("Test signer"), `${name}: a clean pass is given only to a fund without a test signer`);
  }

  // ---- launch form: validates without a wallet
  check((await page.$$("#launch-form fieldset")).length === 4, `${name}: the launch form renders`);
  await page.fill("#l-name", "Bad Name!");
  check((await page.textContent("#l-name-e")).length > 10, `${name}: a bad fund name is refused as you type`);
  await page.fill("#l-name", "my-fund");
  check((await page.textContent("#l-name-e")) === "", `${name}: a good fund name is accepted`);
  await page.fill("#l-gap", "5");
  check((await page.textContent("#l-gap-e")).includes("11"), `${name}: fewer than 11 minutes between trades is refused`);
  await page.fill("#l-gap", "11");
  await page.fill("#l-fee", "3");
  check((await page.textContent("#l-fee-e")).length > 10, `${name}: a fee above 2% is refused`);
  await page.fill("#l-fee", "1");
  const summary = await page.textContent("#l-summary");
  check(summary.includes("refund account") && /Cost: 0\.5\d+ NEAR/.test(summary) && summary.includes("my-fund"), `${name}: the summary shows the exact NEAR cost`);
  check((await page.locator("#l-submit").isDisabled()) === !factory, `${name}: launching is ${factory ? "open" : "closed until the factory is live"}`);

  // ---- recorded runs
  const receipts = await page.$$eval(".agent-case .okc, .agent-case .bad", (els) => els.map((e) => e.className.includes("okc")));
  check(receipts.length > 0 && receipts.every(Boolean), `${name}: ${receipts.length} NEAR AI receipts verify in the browser`);
  check((await page.$$(".quorum-case")).length === 3, `${name}: three quorum cases render`);
  check((await page.textContent("#quorum-cases")).includes("quorum: hold"), `${name}: the quorum held on the injected note`);

  // ---- whole page
  const codey = await page.evaluate(codeLike);
  check(codey.length === 0, `${name}: no code-like text on the page${codey.length ? ": " + codey.join(" | ") : ""}`);
  check((await page.$$("pre, code")).length === 0, `${name}: no code blocks`);
  const small = await page.$$eval("button, .btn, input:not([type=checkbox]):not([type=radio]), select, summary", (els) => els.filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height < 43.5).map((e) => (e.textContent || e.id || e.tagName).trim().slice(0, 30)));
  check(small.length === 0, `${name}: controls are at least 44px tall${small.length ? ": " + small.join(" | ") : ""}`);
  const over = await overflow(page);
  check(over <= 0, `${name}: no horizontal overflow (${over}px)`);
  check(errors.length === 0, `${name}: no console errors${errors.length ? ": " + errors.join(" | ").slice(0, 300) : ""}`);
  await page.close();

  // ---- deep link: ?fund=<account> opens that fund's card and prefills the verifier
  const deep = await browser.newPage({ viewport: { width: w, height: h } });
  const deepErrors = watch(deep);
  const target = legacy[2];
  await deep.goto(`${url}${url.includes("?") ? "&" : "?"}fund=${target}`, { waitUntil: "networkidle" });
  await deep.waitForSelector(".fund.focus .fund-h", { timeout: 45000 }).catch(() => {});
  check((await deep.inputValue("#fund-id")) === target, `${name}: ?fund= prefills the verifier`);
  check((await deep.locator(".fund.focus h3 a").getAttribute("title").catch(() => "")) === target, `${name}: ?fund= highlights that fund's card`);
  check(await deep.locator("#funds-legacy-wrap").evaluate((d) => d.open), `${name}: ?fund= opens the group the fund is in`);
  await deep.waitForTimeout(400);
  const top = await deep.locator(".fund.focus").evaluate((e) => e.getBoundingClientRect().top).catch(() => 9999);
  check(top > -50 && top < h, `${name}: ?fund= scrolls to the card (top at ${Math.round(top)}px)`);
  const href = await deep.locator(".fund.focus [data-act=share]").getAttribute("href").catch(() => "");
  check(href.endsWith(`?fund=${target}`) || href.endsWith(`/f/${target}`), `${name}: the Share link points back to this fund`);
  check((await overflow(deep)) <= 0, `${name}: no horizontal overflow on the deep link`);
  check(deepErrors.length === 0, `${name}: no console errors on the deep link${deepErrors.length ? ": " + deepErrors.join(" | ").slice(0, 300) : ""}`);
  await deep.close();
}

// ---- the narrowest phones
{
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".fund .fund-h", { timeout: 45000 }).catch(() => {});
  const over = await overflow(page);
  check(over <= 0, `360px: no horizontal overflow (${over}px)`);
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all smoke checks passed");
process.exit(failed ? 1 : 0);
