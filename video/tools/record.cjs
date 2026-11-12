// Records real footage of the live Plinth site (NEAR testnet) as high-dpi PNGs into public/rec/.
// Usage: node tools/record.cjs   (needs the repo's playwright: npm ci at the repo root)
// Nothing here signs or sends a transaction: no wallet is connected; the launch form stops at Review.
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../node_modules/playwright'));
const OUT = path.resolve(__dirname, '../public/rec');
const BASE = 'https://unajijacob6-create.github.io/plinth/';
const FUND = 'fund-mwc4ll9q.funds.plinthfund.testnet';
const hideNav = '.site-h{display:none!important} *{scroll-behavior:auto!important} [data-reveal]{opacity:1!important;transform:none!important}';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const go = async (u, wait = 7000) => { await p.goto(BASE + u, { waitUntil: 'networkidle', timeout: 90000 }); await p.waitForTimeout(wait); };
  const BOX = {};
  // Screenshot an element, and record (in screenshot pixels, 2x) where some parts of it are, so the
  // film can point at them. `parts` maps a name to a CSS selector or to 'text:<visible text>'.
  const shot = async (sel, name, parts = {}) => {
    const el = await p.$(sel); await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(700);
    await el.screenshot({ path: `${OUT}/${name}.png` });
    BOX[name] = await p.evaluate(([sel, parts]) => {
      const root = document.querySelector(sel); const r0 = root.getBoundingClientRect(); const out = {};
      for (const [k, q] of Object.entries(parts)) {
        let e = null;
        if (q.startsWith('text:')) {
          const want = q.slice(5);
          const all = [...root.querySelectorAll('*')].filter((x) => x.offsetParent !== null && x.innerText && x.innerText.trim().startsWith(want));
          all.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
          e = all[0] || null;
        } else e = [...root.querySelectorAll(q)].find((x) => x.offsetParent !== null) || null;
        if (!e) { out[k] = null; continue; }
        const r = e.getBoundingClientRect();
        out[k] = [Math.round((r.left - r0.left) * 2), Math.round((r.top - r0.top) * 2), Math.round(r.width * 2), Math.round(r.height * 2)];
      }
      return out;
    }, [sel, parts]);
  };

  // 0. home hero (viewport, nav visible: it is the site's first impression)
  await go('');
  await p.screenshot({ path: `${OUT}/home.png` });

  // 1. launch: step through the five steps to Review. No wallet, no transaction.
  await go('app/launch/');
  await p.addStyleTag({ content: hideNav });
  await p.fill('#l-name', 'my-first-fund');
  await shot('#launch-form', 'launch-1', { next: '#l-next', name: '#l-name', tokens: 'text:Other tokens' });
  for (let i = 2; i <= 5; i++) {
    await p.click('#l-next');
    await p.waitForTimeout(900);
    await shot('#launch-form', `launch-${i}`, { next: '#l-next', submit: '#l-submit', trade: '#l-trade', review: 'text:What you are about to create', open: 'text:Open to in-kind', me: 'text:I manage it' });
  }

  // 2. the app: the card of the fund from the recorded run
  await go('app/', 9000);
  await p.addStyleTag({ content: hideNav });
  const card = await p.evaluateHandle((id) => [...document.querySelectorAll('article')].find((e) => e.innerText.includes(id.slice(0, 13))), FUND);
  await card.asElement().scrollIntoViewIfNeeded();
  await p.waitForTimeout(800);
  await p.evaluate((el) => el.setAttribute('data-film', 'card'), card);
  await shot('[data-film=card]', 'card', { holds: 'text:The fund holds', shares: 'text:10 shares hold', you: '.you', title: 'h3' });

  // 3. how: the AI-manager cases and the two-model cases, one slide at a time
  await go('how/', 8000);
  await p.addStyleTag({ content: hideNav });
  for (const [id, n, name] of [['#agent', 4, 'agent'], ['#quorum', 3, 'quorum']]) {
    const dots = await p.$$(`${id} .car-dot`);
    for (let i = 0; i < Math.min(n, dots.length); i++) {
      await dots[i].click();
      await p.waitForTimeout(1200);
      await shot(`${id}-cases`, `${name}-${i + 1}`, { outcome: '.outcome', next: '.car-btn:last-of-type', a: 'text:DeepSeek V4.1 Flash', b: 'text:Gemini 2.5 Flash', submitted: 'text:The manager submitted', decided: 'text:The model decided' });
    }
  }

  // 4. verify: run the verifier on the fund, keep a frame each time the output changes
  await go('verify/', 4000);
  await p.addStyleTag({ content: hideNav });
  await p.fill('#fund-id', FUND);
  const form = '#verify-form';
  await shot(form, 'verify-0', { input: '#fund-id', go: 'button[type=submit]' });
  await p.click(`${form} button[type=submit]`);
  const t0 = Date.now(); let last = ''; let i = 1;
  while (Date.now() - t0 < 30000) {
    const txt = await p.evaluate(() => document.getElementById('verify-out')?.innerText || '');
    if (txt !== last) { last = txt; await p.$eval(form, (e) => e.scrollIntoView({ block: 'start' })); await (await p.$(form)).screenshot({ path: `${OUT}/verify-${i++}.png` }); }
    if (/check out|NOT verified|verified/i.test(txt) && Date.now() - t0 > 4000) break;
    await p.waitForTimeout(150);
  }
  await p.waitForTimeout(1200);
  await shot(form, 'verify-final', { keys: 'text:No access keys', code: 'text:Code is Plinth release', self: 'text:Code cannot change itself', go: 'button[type=submit]' });
  fs.writeFileSync(`${OUT}/boxes.json`, JSON.stringify(BOX, null, 1));
  console.log(last.slice(0, 1500));
  await b.close();
})();
