// Builds the hero object (glass plinth + keyless padlock) and the glowing wires, then sets
// window.__flierReady for render.mjs. Layout comes from ?layout=4x5|16x9|story.
(() => {
  const layout = new URLSearchParams(location.search).get("layout") || "4x5";
  document.body.classList.add("l-" + layout);
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  // ------------------------------------------------------------ hero object
  const VW = 460, VH = 520, CX = 230, CY = 372;
  const iso = (x, y, z) => [CX + (x - y) * 0.866, CY + (x + y) * 0.5 - z];
  const pts = (arr) => arr.map((p) => iso(...p).map((v) => v.toFixed(2)).join(",")).join(" ");

  const art = document.getElementById("hero-art");
  const svg = el("svg", { viewBox: `0 0 ${VW} ${VH}`, "aria-hidden": "true" }, art);
  const defs = el("defs", {}, svg);
  defs.innerHTML = `
    <radialGradient id="floor" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#4d86ff" stop-opacity=".75"/><stop offset=".45" stop-color="#2f6bff" stop-opacity=".28"/><stop offset="1" stop-color="#2f6bff" stop-opacity="0"/></radialGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0ff" stop-opacity=".0"/><stop offset=".35" stop-color="#cfe0ff" stop-opacity=".20"/><stop offset="1" stop-color="#cfe0ff" stop-opacity="0"/></linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7fe3ff" stop-opacity=".0"/><stop offset=".5" stop-color="#9cc0ff" stop-opacity=".9"/><stop offset="1" stop-color="#7fe3ff" stop-opacity=".0"/></linearGradient>
    <linearGradient id="lockBody" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".45" stop-color="#bcd3ff" stop-opacity=".22"/><stop offset="1" stop-color="#7fa6ff" stop-opacity=".35"/></linearGradient>
    <linearGradient id="shackle" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9cc0ff"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#7fe3ff"/></linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`;

  const slabs = [
    { w: 236, h: 44, z: 0, rgb: "47,107,255" },    // b1 blue
    { w: 168, h: 44, z: 58, rgb: "34,195,230" },   // b2 cyan
    { w: 92, h: 44, z: 116, rgb: "230,238,255" },  // b3 (currentColor on dark: white)
  ];
  for (const [i, s] of slabs.entries()) {
    const id = "s" + i;
    defs.insertAdjacentHTML("beforeend", `
      <linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${s.rgb})" stop-opacity=".62"/><stop offset="1" stop-color="rgb(${s.rgb})" stop-opacity=".26"/></linearGradient>
      <linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${s.rgb})" stop-opacity=".50"/><stop offset="1" stop-color="rgb(${s.rgb})" stop-opacity=".14"/></linearGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${s.rgb})" stop-opacity=".30"/><stop offset="1" stop-color="rgb(${s.rgb})" stop-opacity=".06"/></linearGradient>`);
  }

  // light beam falling onto the stack
  const topZ = slabs[2].z + slabs[2].h;
  const [tx, ty] = iso(0, 0, topZ);
  el("polygon", { points: `${tx - 34},-40 ${tx + 34},-40 ${tx + 150},${ty + 40} ${tx - 150},${ty + 40}`, fill: "url(#beam)" }, svg);
  // floor glow
  const [fx, fy] = iso(0, 0, 0);
  el("ellipse", { cx: fx, cy: fy + 6, rx: 250, ry: 92, fill: "url(#floor)" }, svg);
  // orbit ring (back half)
  const ringY = CY - 62, rx = 222, ry = 70;
  el("path", { d: `M${CX - rx},${ringY} A${rx},${ry} 0 0 1 ${CX + rx},${ringY}`, fill: "none", stroke: "url(#ring)", "stroke-width": 1.4, opacity: .55 }, svg);

  for (const [i, s] of slabs.entries()) {
    const a = s.w / 2, z0 = s.z, z1 = s.z + s.h, id = "s" + i;
    const g = el("g", {}, svg);
    // bloom behind the slab
    el("polygon", { points: pts([[-a, -a, z1], [a, -a, z1], [a, a, z1], [a, a, z0], [-a, a, z0], [-a, a, z1]]), fill: `rgb(${s.rgb})`, opacity: i === 2 ? .18 : .30, filter: "url(#bloom)" }, g);
    // hidden back edges: it is glass, you can see through it
    const hid = { fill: "none", stroke: "rgba(220,232,255,.28)", "stroke-width": 1, "stroke-dasharray": "3 5" };
    el("polyline", { points: pts([[-a, -a, z1], [-a, -a, z0], [a, -a, z0]]), ...hid }, g);
    el("polyline", { points: pts([[-a, -a, z0], [-a, a, z0]]), ...hid }, g);
    // faces
    el("polygon", { points: pts([[-a, a, z0], [a, a, z0], [a, a, z1], [-a, a, z1]]), fill: `url(#${id}l)` }, g);
    el("polygon", { points: pts([[a, -a, z0], [a, a, z0], [a, a, z1], [a, -a, z1]]), fill: `url(#${id}r)` }, g);
    el("polygon", { points: pts([[-a, -a, z1], [a, -a, z1], [a, a, z1], [-a, a, z1]]), fill: `url(#${id}t)` }, g);
    // edges
    const edge = { fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" };
    el("polygon", { points: pts([[-a, -a, z1], [a, -a, z1], [a, a, z1], [-a, a, z1]]), stroke: "rgba(255,255,255,.75)", "stroke-width": 1.4, ...edge }, g);
    el("polyline", { points: pts([[-a, a, z1], [-a, a, z0], [a, a, z0], [a, -a, z0], [a, -a, z1]]), stroke: "rgba(255,255,255,.42)", "stroke-width": 1.2, ...edge }, g);
    el("line", { x1: iso(a, a, z0)[0], y1: iso(a, a, z0)[1], x2: iso(a, a, z1)[0], y2: iso(a, a, z1)[1], stroke: "#fff", "stroke-width": 1.8, opacity: .95 }, g);
    // specular streak along the front top edge
    const p1 = iso(-a * .7, a, z1), p2 = iso(a * .5, a, z1);
    el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: "#fff", "stroke-width": 2.6, "stroke-linecap": "round", opacity: .55, filter: "url(#soft)" }, g);
  }

  // orbit ring (front half)
  el("path", { d: `M${CX + rx},${ringY} A${rx},${ry} 0 0 1 ${CX - rx},${ringY}`, fill: "none", stroke: "url(#ring)", "stroke-width": 1.8 }, svg);
  for (const t of [0.18, 0.62]) {
    const ang = Math.PI * t;
    el("circle", { cx: CX + rx * Math.cos(ang), cy: ringY + ry * Math.sin(ang), r: 3.4, fill: "#dff4ff" }, svg);
    el("circle", { cx: CX + rx * Math.cos(ang), cy: ringY + ry * Math.sin(ang), r: 9, fill: "#7fe3ff", opacity: .35, filter: "url(#soft)" }, svg);
  }

  // keyless padlock, floating over the top slab
  const lockW = 104, lockH = 84, lx = tx - lockW / 2, lBottom = ty - 34, ly = lBottom - lockH;
  el("ellipse", { cx: tx, cy: ty, rx: 40, ry: 14, fill: "#9cc0ff", opacity: .45, filter: "url(#soft)" }, svg);
  el("ellipse", { cx: tx, cy: ty, rx: 30, ry: 10, fill: "none", stroke: "rgba(255,255,255,.6)", "stroke-width": 1 }, svg);
  const lock = el("g", {}, svg);
  el("rect", { x: lx - 6, y: ly - 60, width: lockW + 12, height: lockH + 70, rx: 30, fill: "#7fb0ff", opacity: .35, filter: "url(#bloom)" }, lock);
  const sx1 = lx + 24, sx2 = lx + lockW - 24, sTop = ly - 50;
  el("path", { d: `M${sx1},${ly + 4} V${sTop + 28} A${(sx2 - sx1) / 2},${(sx2 - sx1) / 2} 0 0 1 ${sx2},${sTop + 28} V${ly + 4}`, fill: "none", stroke: "url(#shackle)", "stroke-width": 13, "stroke-linecap": "round" }, lock);
  el("path", { d: `M${sx1 - 3},${ly} V${sTop + 28} A${(sx2 - sx1) / 2 + 3},${(sx2 - sx1) / 2 + 3} 0 0 1 ${sx1 + 22},${sTop - 2}`, fill: "none", stroke: "#fff", "stroke-width": 2.4, opacity: .8, "stroke-linecap": "round" }, lock);
  el("rect", { x: lx, y: ly, width: lockW, height: lockH, rx: 20, fill: "url(#lockBody)", stroke: "rgba(255,255,255,.85)", "stroke-width": 1.6 }, lock);
  el("rect", { x: lx + 8, y: ly + 8, width: lockW - 16, height: 16, rx: 8, fill: "url(#sheen)", opacity: .7 }, lock);
  // no keyhole on purpose: a smooth face with a faint inner frame
  el("rect", { x: lx + 14, y: ly + 30, width: lockW - 28, height: lockH - 44, rx: 10, fill: "none", stroke: "rgba(255,255,255,.28)", "stroke-width": 1 }, lock);

  // sparkles
  for (const [x, y, r, o] of [[60, 120, 2.2, .8], [402, 90, 1.6, .7], [420, 250, 2.4, .6], [38, 300, 1.6, .5], [330, 40, 1.4, .6], [110, 40, 1.2, .5]]) {
    el("circle", { cx: x, cy: y, r, fill: "#e6f0ff", opacity: o }, svg);
  }

  // where wires leave the object: the floor under the base, in viewBox units
  const heroOut = { x: fx, y: fy + 30 };

  // ------------------------------------------------------------ wires
  function drawWires() {
    const wires = document.getElementById("wires");
    const P = document.getElementById("poster").getBoundingClientRect();
    wires.setAttribute("viewBox", `0 0 ${P.width} ${P.height}`);
    wires.innerHTML = `<defs>
      <linearGradient id="wire" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${P.height}"><stop offset="0" stop-color="#7fe3ff" stop-opacity=".0"/><stop offset=".35" stop-color="#7fb0ff" stop-opacity=".75"/><stop offset="1" stop-color="#2f6bff" stop-opacity=".15"/></linearGradient>
      <filter id="wglow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter></defs>`;
    const A = svg.getBoundingClientRect();
    const k = A.width / VW;
    const ox = A.left - P.left + heroOut.x * k, oy = A.top - P.top + heroOut.y * k;
    const targets = [...document.querySelectorAll(".pt")].map((n) => n.getBoundingClientRect());
    const wireLayer = el("g", {}, wires);
    for (const r of targets) {
      let tx2, ty2, d;
      if (layout === "16x9") {
        tx2 = r.left - P.left; ty2 = r.top - P.top + r.height / 2;
        d = `M${ox},${oy} C${tx2 - 36},${oy + 10} ${tx2 - 36},${ty2} ${tx2},${ty2}`;
      } else {
        tx2 = r.left - P.left + r.width / 2; ty2 = r.top - P.top;
        d = `M${ox},${oy} C${ox},${ty2 - 4} ${tx2},${ty2 - 44} ${tx2},${ty2}`;
      }
      el("path", { d, fill: "none", stroke: "#4d86ff", "stroke-width": 5, opacity: .35, filter: "url(#wglow)" }, wireLayer);
      el("path", { d, fill: "none", stroke: "url(#wire)", "stroke-width": 1.5 }, wireLayer);
      el("circle", { cx: tx2, cy: ty2, r: 4, fill: "#dff4ff" }, wireLayer);
      el("circle", { cx: tx2, cy: ty2, r: 10, fill: "#7fe3ff", opacity: .3, filter: "url(#wglow)" }, wireLayer);
    }
    el("circle", { cx: ox, cy: oy, r: 5, fill: "#dff4ff" }, wireLayer);
  }

  Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => {
    drawWires();
    window.__flierReady = true;
  });
})();
