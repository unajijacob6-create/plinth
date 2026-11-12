// Poster v2: picks the variant from ?v=a|b|c|b-wide, adds the Plinth mark to each lockup,
// draws A's light curtains and C's pedestal, then sets window.__flierReady for render.mjs.
(() => {
  const q = new URLSearchParams(location.search).get("v") || "a";
  const [v, wide] = q.split("-");
  document.body.dataset.v = v;
  if (wide === "wide") document.body.classList.add("wide");
  const NS = "http://www.w3.org/2000/svg";
  const W = document.body.classList.contains("wide") ? 1600 : 1080;
  const H = document.body.classList.contains("wide") ? 900 : 1350;

  // Plinth mark (web/src/shell.ts LOGO) in front of each wordmark
  const tpl = document.getElementById("plinth-mark");
  for (const n of document.querySelectorAll("[data-mark]")) n.prepend(tpl.content.cloneNode(true));

  // seeded random so every render is identical
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // ---- A: vertical light curtains in Plinth blue
  const cur = document.querySelector(".pa .curtains");
  if (cur && v === "a") {
    cur.setAttribute("viewBox", `0 0 ${W} ${H}`);
    cur.setAttribute("preserveAspectRatio", "none");
    let html = `<defs>
      <filter id="fold" x="-20%" y="0" width="140%" height="100%"><feGaussianBlur stdDeviation="9 0"/></filter>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".45" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity=".3"/></linearGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask></defs><g mask="url(#m)" filter="url(#fold)">`;
    let x = -20;
    while (x < W + 20) {
      const w = 8 + rnd() * 46;
      const t = x / W;
      // brightest folds just right of centre, as if lit from above
      const lift = Math.exp(-Math.pow((t - 0.6) / 0.3, 2));
      const o = (0.14 + 0.86 * lift) * (0.4 + 0.6 * rnd());
      const c = rnd() < 0.18 ? "#22c3e6" : rnd() < 0.5 ? "#2f6bff" : "#5b8cff";
      html += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="${c}" opacity="${o.toFixed(3)}"/>`;
      html += `<rect x="${(x + w).toFixed(1)}" y="0" width="${(4 + rnd() * 10).toFixed(1)}" height="${H}" fill="#01030b" opacity="${(0.5 + rnd() * 0.4).toFixed(2)}"/>`;
      x += w + 6 + rnd() * 18;
    }
    html += `</g>`;
    cur.innerHTML = html;
  }

  // ---- C: a dark plinth under the laptop (two stacked blocks seen slightly from above)
  const ped = document.querySelector(".pc .pedestal");
  if (ped && v === "c") {
    ped.setAttribute("viewBox", "0 0 1080 470");
    const block = (bx0, bx1, fx0, fx1, yTop, yFront, yBottom, lit) => `
      <polygon points="${bx0},${yTop} ${bx1},${yTop} ${fx1},${yFront} ${fx0},${yFront}" fill="url(#top${lit})"/>
      <rect x="${fx0}" y="${yFront}" width="${fx1 - fx0}" height="${yBottom - yFront}" fill="url(#front)"/>
      <line x1="${fx0}" y1="${yFront}" x2="${fx1}" y2="${yFront}" stroke="rgba(170,200,255,.35)" stroke-width="1.5"/>
      <line x1="${bx0}" y1="${yTop}" x2="${bx1}" y2="${yTop}" stroke="rgba(170,200,255,.16)" stroke-width="1"/>`;
    ped.innerHTML = `<defs>
      <linearGradient id="top1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2650"/><stop offset="1" stop-color="#25356b"/></linearGradient>
      <linearGradient id="top2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1838"/><stop offset="1" stop-color="#18244c"/></linearGradient>
      <linearGradient id="front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1530"/><stop offset=".5" stop-color="#070b1a"/><stop offset="1" stop-color="#03050d"/></linearGradient>
      <radialGradient id="sheen" cx="50%" cy="0%" r="60%"><stop offset="0" stop-color="#4d7dff" stop-opacity=".22"/><stop offset="1" stop-color="#2f6bff" stop-opacity="0"/></radialGradient>
      <radialGradient id="pool" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#7aa2ff" stop-opacity=".6"/><stop offset="1" stop-color="#2f6bff" stop-opacity="0"/></radialGradient>
    </defs>
    ${block(-40, 1120, -90, 1170, 284, 324, 470, 2)}
    <rect x="-90" y="324" width="1260" height="146" fill="url(#sheen)"/>
    ${block(96, 984, 40, 1040, 146, 204, 284, 1)}
    <rect x="40" y="204" width="1000" height="80" fill="url(#sheen)"/>
    <ellipse cx="540" cy="186" rx="470" ry="26" fill="url(#pool)"/>`;
  }

  const faces = ["700 40px 'Inter Tight Variable'", "italic 40px 'Instrument Serif'", "500 20px 'Manrope Variable'"].map((f) => document.fonts.load(f));
  Promise.all([...faces, document.fonts.ready, ...[...document.images].filter((i) => i.closest(".poster")?.dataset.v === v).map((i) => i.decode().catch(() => {}))]).then(() => {
    window.__flierReady = true;
  });
})();
