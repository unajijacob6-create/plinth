// Screenshots of the LIVE Plinth site for the device mockups (no wallet connected).
//   node shoot.mjs            -> assets/shots/*.png
// Each shot waits for chain data to load (fund cards / verifier result) before capturing.
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const SITE = "https://unajijacob6-create.github.io/plinth/";
const out = join(here, "assets/shots");
await mkdir(out, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const browser = await chromium.launch({ proxy });

async function shot(name, path, viewport, ready, { full = false, scrollTo, at = 40, settle = 1500 } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce", isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(SITE + path, { waitUntil: "networkidle", timeout: 60_000 });
  if (ready) await page.waitForFunction(ready, null, { timeout: 60_000 }).catch(() => console.log(`  [${name}] ready check timed out`));
  if (scrollTo) await page.evaluate(([t, at]) => {
    // scroll so the fund card whose title is exactly t sits at the top of the screen
    const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((n) => n.textContent.trim() === t);
    const head = document.querySelector("header")?.getBoundingClientRect().height ?? 0; // sticky site header
    if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - head - at);
  }, [scrollTo, at]);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(out, name + ".png"), fullPage: full });
  console.log(`${name}: ${SITE + path} ${viewport.width}x${viewport.height}`);
  await page.close();
}

const what = process.argv[2];
const jobs = {
  // home hero on a laptop-sized viewport
  "home-desktop": () => shot("home-desktop", "", { width: 1440, height: 900 }, null, { settle: 2500 }),
  // the app on desktop and phone, after fund cards have loaded from testnet RPC
  "app-desktop": () => shot("app-desktop", "app/", { width: 1440, height: 1000 }, () => /shares? hold/i.test(document.body.innerText), { settle: 2500 }),
  "app-phone": () => shot("app-phone", "app/", { width: 390, height: 844 }, () => /shares? hold/i.test(document.body.innerText), { settle: 2500 }),
  "app-phone-full": () => shot("app-phone-full", "app/", { width: 390, height: 844 }, () => /shares? hold/i.test(document.body.innerText), { full: true, settle: 2500 }),
  "app-desktop-full": () => shot("app-desktop-full", "app/", { width: 1440, height: 1000 }, () => /shares? hold/i.test(document.body.innerText), { full: true, settle: 2500 }),
  "app-phone-card": () => shot("app-phone-card", "app/", { width: 390, height: 844 }, () => /shares? hold/i.test(document.body.innerText), { scrollTo: "auto-mwc5tnnh", settle: 2500 }),
  // phone: the "Holdings" block (the fund holds / 10 shares hold) in the lower half of the screen
  "app-phone-holdings": () => shot("app-phone-holdings", "app/", { width: 390, height: 844 }, () => /shares? hold/i.test(document.body.innerText), { scrollTo: "Holdings", at: 330, settle: 2500 }),
  "app-desktop-card": () => shot("app-desktop-card", "app/", { width: 1440, height: 900 }, () => /shares? hold/i.test(document.body.innerText), { scrollTo: "auto-mwc5tnnh", settle: 2500 }),
  "verify-desktop": () => shot("verify-desktop", "verify/?fund=fund-mwc4ll9q.funds.plinthfund.testnet", { width: 1440, height: 1000 }, () => /check out/i.test(document.body.innerText), { full: true, settle: 2500 }),
};
for (const [k, fn] of Object.entries(jobs)) if (!what || what === k) await fn();
await browser.close();
