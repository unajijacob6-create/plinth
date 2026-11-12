// A horizontal carousel: one slide in view, swipe or scroll on touch, buttons, dots and arrow keys.
// The slides are plain children of the track; scrolling is native (scroll-snap), so it stays smooth
// and works without this script. No inner scrollbar is shown.
import { reduced } from "./shell.ts";

export function mountCarousel(track: HTMLElement | null, label: string) {
  if (!track || track.dataset.carousel) return;
  const slides = [...track.children] as HTMLElement[];
  if (slides.length === 0) return;
  track.dataset.carousel = "1";
  track.classList.remove("cases");
  track.classList.add("track");
  track.tabIndex = 0;
  track.setAttribute("aria-label", `${label}: use the arrow keys or the buttons to move between them`);
  slides.forEach((s, i) => {
    s.classList.add("slide");
    s.setAttribute("role", "group");
    s.setAttribute("aria-roledescription", "slide");
    s.setAttribute("aria-label", `${i + 1} of ${slides.length}`);
  });
  const wrap = document.createElement("div");
  wrap.className = "carousel";
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-roledescription", "carousel");
  wrap.setAttribute("aria-label", label);
  track.replaceWith(wrap);
  wrap.append(track);
  const nav = document.createElement("div");
  nav.className = "car-nav";
  nav.innerHTML = `
    <button type="button" class="car-btn" data-dir="-1" aria-label="Previous"><span aria-hidden="true">←</span></button>
    <div class="car-dots">${slides.map((_, i) => `<button type="button" class="car-dot" data-i="${i}" aria-label="Show ${i + 1} of ${slides.length}"><span></span></button>`).join("")}</div>
    <p class="car-count" aria-live="polite"><b>1</b> / ${slides.length}</p>
    <button type="button" class="car-btn" data-dir="1" aria-label="Next"><span aria-hidden="true">→</span></button>`;
  wrap.append(nav);
  const dots = [...nav.querySelectorAll<HTMLButtonElement>(".car-dot")];
  const [prev, next] = [...nav.querySelectorAll<HTMLButtonElement>(".car-btn")];
  const count = nav.querySelector(".car-count b")!;
  let cur = 0;
  const go = (i: number) => {
    const n = Number.isFinite(i) ? Math.max(0, Math.min(slides.length - 1, i)) : 0;
    track.scrollTo({ left: slides[n].offsetLeft - slides[0].offsetLeft, behavior: reduced() ? "auto" : "smooth" });
  };
  const paint = () => {
    // The slide whose start is nearest to where the track has scrolled.
    const x = track.scrollLeft;
    let i = 0;
    slides.forEach((sl, j) => {
      if (Math.abs(sl.offsetLeft - slides[0].offsetLeft - x) < Math.abs(slides[i].offsetLeft - slides[0].offsetLeft - x)) i = j;
    });
    cur = i;
    dots.forEach((d, j) => d.setAttribute("aria-current", j === i ? "true" : "false"));
    slides.forEach((s, j) => {
      s.classList.toggle("current", j === i);
      s.toggleAttribute("inert", j !== i);
    });
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    count.textContent = String(i + 1);
  };
  let raf = 0;
  track.addEventListener("scroll", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  }, { passive: true });
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.dir) go(cur + Number(b.dataset.dir));
    else if (b.dataset.i) go(Number(b.dataset.i));
  });
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") (e.preventDefault(), go(cur + 1));
    if (e.key === "ArrowLeft") (e.preventDefault(), go(cur - 1));
  });
  addEventListener("resize", () => go(cur));
  paint();
}
