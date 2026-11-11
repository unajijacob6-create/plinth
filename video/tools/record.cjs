// Records real footage of the live Plinth site (NEAR testnet) as high-dpi PNGs.
// Usage: node tools/record.cjs  (needs the repo's playwright: npm ci at the repo root)
const path = require('path');
const { chromium } = require(path.resolve(__dirname, '../../node_modules/playwright'));
const OUT = path.resolve(__dirname, '../public/rec');
const URL = 'https://unajijacob6-create.github.io/plinth/?fund=fund-mwc4ll9q.funds.plinthfund.testnet';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await p.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
  await p.waitForTimeout(8000);
  await p.addStyleTag({ content: '.nav{display:none!important}' }); // keep the sticky nav out of element shots
  // 1. the deep-linked fund card, read from the chain
  const card = await p.$('.fund.hl, .fund:has(h3:text("Demo fund")), .funds .fund');
  if (card) await card.screenshot({ path: `${OUT}/card.png` });
  // 2. the verifier, run on the fund from the recorded run; a burst of frames while it runs
  await p.evaluate(() => document.getElementById('verify').scrollIntoView({ block: 'start' }));
  await p.fill('#fund-id', 'fund-mwc4ll9q.funds.plinthfund.testnet');
  const form = await p.$('#verify-form');
  await form.screenshot({ path: `${OUT}/verify-00.png` });
  await p.click('#verify-form button[type=submit]');
  const t0 = Date.now(); let i = 1; let last = '';
  while (Date.now() - t0 < 30000) {
    const txt = await p.evaluate(() => document.getElementById('verify-out').innerText);
    if (txt !== last) { last = txt; await form.screenshot({ path: `${OUT}/verify-${String(i++).padStart(2, '0')}.png` }); }
    if (/verified|NOT verified/i.test(txt) && Date.now() - t0 > 4000) { await p.waitForTimeout(1500); await form.screenshot({ path: `${OUT}/verify-${String(i++).padStart(2, '0')}.png` }); break; }
    await p.waitForTimeout(150);
  }
  console.log('verify frames', i, '\n', last.slice(0, 2000));
  // 3. launch form
  const launch = await p.$('#launch-form');
  await p.evaluate(() => document.getElementById('launch').scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(1500);
  if (launch) await launch.screenshot({ path: `${OUT}/launch.png` });
  // 4. AI operator + quorum cases, refusals
  for (const id of ['agent-cases', 'quorum-cases', 'refusal-cards']) {
    const el = await p.$('#' + id);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(1200);
    await el.screenshot({ path: `${OUT}/${id}.png` });
  }
  await b.close();
})();
