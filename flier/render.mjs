// Renders the Plinth posters to PNG at 2x with Playwright (Chromium) and checks them.
//   cd flier && npm install && node shoot.mjs   # fresh screenshots of the live site (optional)
//   node render.mjs                              # v2 posters: a, b, c, b-wide
//   node render.mjs v1-4x5 v1-16x9 v1-story     # the v1 info-sheet flier (QR decode checked)
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // resolved from the repo's node_modules
const QRCode = require("qrcode");
const jsQR = require("jsqr");
const { PNG } = require("pngjs");

const here = dirname(fileURLToPath(import.meta.url));
const SITE = "https://unajijacob6-create.github.io/plinth/";
const LAYOUTS = {
  // v2: product posters (poster.html), the current set
  a: { page: "poster.html?v=a", w: 1080, h: 1350, out: "plinth-flier-a.png" },
  b: { page: "poster.html?v=b", w: 1080, h: 1350, out: "plinth-flier-b.png" },
  c: { page: "poster.html?v=c", w: 1080, h: 1350, out: "plinth-flier-c.png" },
  "b-wide": { page: "poster.html?v=b-wide", w: 1600, h: 900, out: "plinth-flier-b-16x9.png" },
  // v1: the info-sheet flier (flier.html), kept for reference
  "v1-4x5": { page: "flier.html?layout=4x5", w: 1080, h: 1350, out: "plinth-flier-4x5-v1.png", qr: true, v1: true },
  "v1-16x9": { page: "flier.html?layout=16x9", w: 1600, h: 900, out: "plinth-flier-16x9-v1.png", qr: true, v1: true },
  "v1-story": { page: "flier.html?layout=story", w: 1080, h: 1920, out: "plinth-flier-story-v1.png", qr: true, v1: true },
};
const want = process.argv.slice(2).filter((a) => LAYOUTS[a]);
const todo = want.length ? want : Object.keys(LAYOUTS).filter((k) => !LAYOUTS[k].v1);

// 1. QR code to the live site: dark on white, 4-module quiet zone, error correction M.
const qrSvg = await QRCode.toString(SITE, { type: "svg", errorCorrectionLevel: "M", margin: 4, color: { dark: "#030817", light: "#ffffff" } });
await writeFile(join(here, "assets/qr.svg"), qrSvg);

// 2. Serve the flier folder over http so fonts and images load exactly as in a browser.
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
  if (path.startsWith("..")) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(join(here, path || "flier.html"));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// 3. Render each layout at 2x and check it.
await mkdir(join(here, "out"), { recursive: true });
const browser = await chromium.launch();
let failed = false;
try {
  for (const name of todo) {
    const L = LAYOUTS[name];
    const page = await browser.newPage({ viewport: { width: L.w, height: L.h }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base + L.page, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__flierReady === true);
    const checks = await page.evaluate((v1) => {
      const fonts = ["600 40px 'Inter Tight Variable'", "italic 40px 'Instrument Serif'", "500 20px 'Manrope Variable'"].map((f) => [f, document.fonts.check(f)]);
      const P = (document.getElementById("poster") ?? document.querySelector(`.poster[data-v="${document.body.dataset.v}"]`)).getBoundingClientRect();
      let out;
      if (v1) {
        const pad = parseFloat(getComputedStyle(document.getElementById("poster")).paddingLeft);
        // nothing may cross into the poster's padding (the safe margin)
        out = [...document.querySelectorAll(".poster *:not(.bg *):not(.wires *):not(.bg):not(.wires):not(.hero-art *):not(.hero-art)")]
          .filter((n) => getComputedStyle(n).display !== "none")
          .map((n) => [n, n.getBoundingClientRect()])
          .filter(([, r]) => r.width && (r.right > P.right - pad + 0.5 || r.bottom > P.bottom - pad + 0.5 || r.left < pad - 0.5 || r.top < pad - 0.5))
          .map(([n]) => n.className?.baseVal ?? n.className ?? n.tagName);
      } else {
        // posters bleed their device mockups on purpose; every piece of text must stay 40px inside
        const sel = ".hl, .sub, .cta, .lockup, .lk, .fine, .near, .near-badge, .pill, .bar, .spaced";
        out = [...document.querySelectorAll(sel)].filter((n) => n.offsetParent && n.closest(".poster").checkVisibility())
          .map((n) => { const g = document.createRange(); g.selectNodeContents(n); const t = g.getBoundingClientRect(), b = n.getBoundingClientRect(); return [n, getComputedStyle(n).display.includes("flex") || getComputedStyle(n).backgroundColor !== "rgba(0, 0, 0, 0)" ? b : t]; })
          .filter(([, r]) => r.right > P.right - 40 || r.bottom > P.bottom - 40 || r.left < 40 || r.top < 40)
          .map(([n]) => n.className);
      }
      return { fonts, out };
    }, !!L.v1);
    const file = join(here, "out", L.out);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: L.w, height: L.h } });
    await page.close();

    const png = PNG.sync.read(await readFile(file));
    let ok = true, qrNote = "no QR";
    if (L.qr) {
      // decode the QR from the rendered PNG, at full size and at half size (a phone feed)
      const full = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      const half = downscale(png, 2);
      const small = jsQR(half.data, half.w, half.h);
      ok = full?.data === SITE && small?.data === SITE;
      qrNote = ok ? "QR decodes to " + SITE + " at 100% and 50%" : "QR FAILED (" + (full?.data ?? "none") + ")";
    }
    const fontsOk = checks.fonts.every(([, v]) => v);
    console.log(`${name}: ${L.out} ${png.width}x${png.height} · ${qrNote} · fonts ${fontsOk ? "loaded" : "MISSING " + JSON.stringify(checks.fonts)} · text outside safe area ${checks.out.length ? JSON.stringify(checks.out) : "none"} · console errors ${errors.length ? JSON.stringify(errors) : "none"}`);
    if (!ok || !fontsOk || checks.out.length || errors.length) failed = true;
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;

function downscale(png, f) {
  const w = Math.floor(png.width / f), h = Math.floor(png.height / f), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += png.data[((y * f + dy) * png.width + (x * f + dx)) * 4 + c];
    data[(y * w + x) * 4 + c] = s / (f * f);
  }
  return { w, h, data };
}
