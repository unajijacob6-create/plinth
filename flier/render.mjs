// Renders the Plinth flier to PNG with Playwright (Chromium), then checks the QR code decodes.
//   cd flier && npm install && node render.mjs            # all layouts
//   node render.mjs 4x5                                   # one layout
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
  "4x5": { w: 1080, h: 1350, out: "plinth-flier-4x5.png" },
  "16x9": { w: 1600, h: 900, out: "plinth-flier-16x9.png" },
  story: { w: 1080, h: 1920, out: "plinth-flier-story.png" },
};
const want = process.argv.slice(2).filter((a) => LAYOUTS[a]);
const todo = want.length ? want : Object.keys(LAYOUTS);

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
const base = `http://127.0.0.1:${server.address().port}/flier.html`;

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
    await page.goto(`${base}?layout=${name}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__flierReady === true);
    const checks = await page.evaluate(() => {
      const fonts = ["600 40px 'Inter Tight Variable'", "italic 40px 'Instrument Serif'", "500 20px 'Manrope Variable'"].map((f) => [f, document.fonts.check(f)]);
      const P = document.getElementById("poster").getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(document.getElementById("poster")).paddingLeft);
      const out = [...document.querySelectorAll(".poster *:not(.bg *):not(.wires *):not(.bg):not(.wires):not(.hero-art *):not(.hero-art)")]
        .filter((n) => getComputedStyle(n).display !== "none")
        .map((n) => [n, n.getBoundingClientRect()])
        // nothing may cross into the poster's padding (the safe margin)
        .filter(([, r]) => r.width && (r.right > P.right - pad + 0.5 || r.bottom > P.bottom - pad + 0.5 || r.left < pad - 0.5 || r.top < pad - 0.5))
        .map(([n]) => n.className?.baseVal ?? n.className ?? n.tagName);
      const clipped = [...document.querySelectorAll("h1, h2, p, li, span, b")]
        .filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== "visible")
        .map((n) => n.className || n.tagName);
      return { fonts, out, clipped };
    });
    const file = join(here, "out", L.out);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: L.w, height: L.h } });
    await page.close();

    // decode the QR from the rendered PNG, at full size and at half size (a phone feed)
    const png = PNG.sync.read(await readFile(file));
    const full = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    const half = downscale(png, 2);
    const small = jsQR(half.data, half.w, half.h);
    const ok = full?.data === SITE && small?.data === SITE;
    const fontsOk = checks.fonts.every(([, v]) => v);
    console.log(`${name}: ${L.out} ${png.width}x${png.height} · QR ${ok ? "decodes to " + SITE : "FAILED (" + (full?.data ?? "none") + ")"} at 100% and 50% · fonts ${fontsOk ? "loaded" : "MISSING " + JSON.stringify(checks.fonts)} · overflow ${checks.out.length ? JSON.stringify(checks.out) : "none"} · console errors ${errors.length ? JSON.stringify(errors) : "none"}`);
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
