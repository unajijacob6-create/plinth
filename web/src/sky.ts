// The hero band's night sky: fine stars that twinkle and drift up slowly. A canvas, drawn only
// while the band is on screen and the tab is visible; one still frame with reduced motion.
import { reduced } from "./shell.ts";

export function mountSky(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let w = 0, h = 0, dpr = 1;
  type Star = { x: number; y: number; r: number; a: number; s: number; p: number };
  let stars: Star[] = [];
  const seed = () => {
    const n = Math.round(Math.min(160, (w * h) / 9000));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() < 0.85 ? 0.6 + Math.random() * 0.6 : 1.2 + Math.random() * 0.8,
      a: 0.25 + Math.random() * 0.6,
      s: 4 + Math.random() * 10,
      p: Math.random() * Math.PI * 2,
    }));
  };
  const size = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  };
  let last = performance.now();
  const draw = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.y -= s.s * dt;
      if (s.y < -2) {
        s.y = h + 2;
        s.x = Math.random() * w;
      }
      // Fade out towards the bottom, where the band turns into the light page.
      const fade = Math.max(0, 1 - s.y / (h * 0.92));
      const tw = 0.65 + 0.35 * Math.sin(t / 900 + s.p);
      ctx.globalAlpha = s.a * tw * fade;
      ctx.fillStyle = "#cfe0ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  size();
  if (reduced()) {
    draw(performance.now());
    addEventListener("resize", () => (size(), draw(performance.now())));
    return;
  }
  let visible = true;
  let raf = 0;
  const loop = (t: number) => {
    draw(t);
    raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => {
    if (!raf && visible && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };
  new IntersectionObserver((e) => {
    visible = e.some((x) => x.isIntersecting);
    kick();
  }).observe(canvas);
  document.addEventListener("visibilitychange", kick);
  let t0 = 0;
  addEventListener("resize", () => {
    clearTimeout(t0);
    t0 = window.setTimeout(size, 150);
  });
  kick();
}
