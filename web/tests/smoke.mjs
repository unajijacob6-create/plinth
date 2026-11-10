// Site smoke test: run against a served build (npm run web:preview) or any URL.
//   node web/tests/smoke.mjs [url]
// Checks at phone and desktop width: no console errors, no horizontal overflow, the live fund cards
// render from testnet RPC, the in-browser verifier verifies the recorded fund, and the AI operator
// receipts verify in the browser.
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:4173/";
const browser = await chromium.launch();
let failed = 0;
function check(cond, msg) {
  console.log(`${cond ? "[ok]  " : "[FAIL]"} ${msg}`);
  if (!cond) failed++;
}
for (const [w, h, name] of [[390, 844, "phone"], [1440, 900, "desktop"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  check((await page.title()).includes("Plinth"), `${name}: title`);
  await page.waitForSelector(".fund .fund-h", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".fund .fund-h").length === 3, null, { timeout: 30000 }).catch(() => {});
  check((await page.$$(".fund .fund-h")).length === 3, `${name}: three live fund cards`);
  check((await page.textContent("#funds")).includes("stNEAR"), `${name}: the earning fund shows its stNEAR`);
  check((await page.textContent(".fund")).includes("0 keys"), `${name}: open fund shows 0 keys`);
  await page.click("#verify-form button[type=submit]");
  await page.waitForSelector(".verdict", { timeout: 30000 });
  check((await page.textContent(".verdict")).startsWith("Verified"), `${name}: verifier verifies the recorded fund`);
  const receipts = await page.$$eval(".agent-case .okc, .agent-case .bad", (els) => els.map((e) => e.className.includes("okc")));
  check(receipts.length > 0 && receipts.every(Boolean), `${name}: ${receipts.length} NEAR AI receipts verify in the browser`);
  check((await page.$$(".quorum-case")).length === 3, `${name}: three quorum cases render`);
  check((await page.textContent("#quorum-cases")).includes("quorum: hold"), `${name}: the quorum held on the injected note`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, `${name}: no horizontal overflow (${over}px)`);
  check(errors.length === 0, `${name}: no console errors${errors.length ? ": " + errors.join(" | ").slice(0, 300) : ""}`);
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all smoke checks passed");
process.exit(failed ? 1 : 0);
