// Shared by every page: header, footer, links that work under any base path, the phone menu,
// scroll reveals and number counters. Kept small: the home page loads only this and its own bits.
import "./base.css";

export const BASE = import.meta.env.BASE_URL;
const GITHUB = "https://github.com/unajijacob6-create/plinth";
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="20" width="22" height="6" rx="1.5" class="b1" /><rect x="9" y="12" width="14" height="6" rx="1.5" class="b2" /><rect x="13" y="4" width="6" height="6" rx="1.5" class="b3" /></svg>`;

export type Page = "home" | "app" | "launch" | "verify" | "how" | "security";

/** Header and footer for this page. `dark`: the page opens on the dark hero band. */
export function mountShell(page: Page, dark: boolean) {
  const nav: [Page | "gh", string, string][] = [
    ["how", "How it works", `${BASE}how/`],
    ["verify", "Verify", `${BASE}verify/`],
    ["security", "Security", `${BASE}security/`],
    ["gh", "GitHub", GITHUB],
  ];
  const header = document.createElement("header");
  header.className = `site-h${dark ? " on-dark" : " solid"}`;
  header.innerHTML = `
    <a class="brand" href="${BASE}" aria-label="Plinth home">${LOGO}<span>Plinth</span></a>
    <button class="menu-btn" id="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav"><span class="bars" aria-hidden="true"></span><span class="sr">Menu</span></button>
    <nav id="site-nav" aria-label="Site">
      ${nav.map(([k, label, href]) => `<a href="${href}"${k === page ? ' aria-current="page"' : ""}${k === "gh" ? ' rel="noopener"' : ""}>${esc(label)}</a>`).join("")}
      <a class="btn primary sm nav-cta" href="${BASE}app/"${page === "app" || page === "launch" ? ' aria-current="page"' : ""}>Open the app</a>
    </nav>`;
  document.body.prepend(header);
  const skip = document.createElement("a");
  skip.className = "skip";
  skip.href = "#main";
  skip.textContent = "Skip to the content";
  document.body.prepend(skip);

  const foot = document.createElement("footer");
  foot.className = "site-f";
  foot.innerHTML = `
    <div class="f-in">
      <div class="f-brand"><a class="brand" href="${BASE}">${LOGO}<span>Plinth</span></a><p>A shared fund on NEAR that nobody can change. Built at the NEAR HACKATHON by Unaji Jacob. Runs on NEAR testnet with test tokens.</p></div>
      <div class="f-cols">
        <div><p class="f-h">Product</p><a href="${BASE}app/">Open the app</a><a href="${BASE}app/launch/">Launch a fund</a><a href="${BASE}verify/">Verify a fund</a></div>
        <div><p class="f-h">Learn</p><a href="${BASE}how/">How it works</a><a href="${BASE}security/">Security</a><a href="${BASE}security/#limits">Limits</a></div>
        <div><p class="f-h">Source</p><a href="${GITHUB}" rel="noopener">GitHub</a><span>MIT licence</span></div>
      </div>
    </div>`;
  document.body.append(foot);

  // Phone menu: a real button, closes on link tap, outside tap and Escape.
  const btn = header.querySelector("#menu-btn") as HTMLButtonElement;
  const navEl = header.querySelector("#site-nav") as HTMLElement;
  const setMenu = (open: boolean) => {
    btn.setAttribute("aria-expanded", String(open));
    navEl.classList.toggle("open", open);
    header.classList.toggle("menu-open", open);
  };
  btn.addEventListener("click", () => setMenu(btn.getAttribute("aria-expanded") !== "true"));
  navEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
      setMenu(false);
      btn.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".site-h")) setMenu(false);
  });

  // Over the dark band the header is clear; once you scroll it turns solid.
  if (dark) {
    const onScroll = () => header.classList.toggle("solid", scrollY > 24);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Links written in the pages as data-href="app/" become real links under the current base.
  document.querySelectorAll<HTMLAnchorElement>("a[data-href]").forEach((a) => (a.href = BASE + a.dataset.href));
  reveal();
}

/** Sections with data-reveal fade and rise in once, as they come into view. */
export function reveal(root: ParentNode = document) {
  const els = [...root.querySelectorAll<HTMLElement>("[data-reveal]:not(.in)")];
  if (reduced() || !("IntersectionObserver" in window)) {
    els.forEach((e) => e.classList.add("in"));
    return;
  }
  document.documentElement.classList.add("motion");
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.classList.add("in");
        io.unobserve(en.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  els.forEach((e) => io.observe(e));
}

/** Count a number up from zero when it scrolls into view (instantly with reduced motion). */
export function countUp(el: HTMLElement, value: number) {
  const done = () => (el.textContent = value.toLocaleString("en"));
  if (reduced() || value === 0 || !("IntersectionObserver" in window)) return done();
  el.textContent = "0";
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const start = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(value * eased).toLocaleString("en");
      if (k < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  io.observe(el);
}

/** Split a headline into words that rise in one after another (the accent phrase stays one unit). */
export function riseWords(el: HTMLElement | null) {
  if (!el || reduced()) return;
  let i = 0;
  const wrap = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? "").split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const w = document.createElement("span");
            w.className = "w";
            w.style.setProperty("--i", String(i++));
            w.textContent = part;
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else if (child instanceof HTMLElement && child.tagName === "EM") {
        child.classList.add("w");
        child.style.setProperty("--i", String(i++));
      } else if (child instanceof HTMLElement) wrap(child);
    }
  };
  wrap(el);
  el.classList.add("rise");
}
