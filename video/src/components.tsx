import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { C, FONT, GRAD } from './theme';

export const useT = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps;
};
export const useLayout = () => {
  const { width, height } = useVideoConfig();
  const sq = width === height;
  return { w: width, h: height, sq, L: <T,>(land: T, square: T) => (sq ? square : land) };
};

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const lerp = (t: number, a: number, b: number, from = 0, to = 1, e = ease) =>
  interpolate(t, [a, b], [from, to], { ...clamp, easing: e });

/** Spring progress starting at local second `at`. */
export const useSpring = (at: number, cfg: { damping?: number; stiffness?: number; mass?: number } = {}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - Math.round(at * fps), fps, config: { damping: 18, stiffness: 120, mass: 0.9, ...cfg } });
};
export const sprAt = (frame: number, fps: number, at: number, cfg = {}) =>
  spring({ frame: frame - Math.round(at * fps), fps, config: { damping: 18, stiffness: 120, mass: 0.9, ...cfg } });

/** Opacity/slide envelope: in at `at`, out at `out` (local seconds). */
export const useEnv = (at: number, out = 1e9, inDur = 0.5, outDur = 0.35) => {
  const t = useT();
  const i = lerp(t, at, at + inDur);
  const o = 1 - lerp(t, out, out + outDur, 0, 1, Easing.in(Easing.cubic));
  return Math.min(i, o);
};

type WordsProps = {
  text: string;
  at: number;
  out?: number;
  size: number;
  weight?: number;
  color?: string;
  grad?: boolean | string[];
  stagger?: number;
  align?: 'left' | 'center' | 'right';
  lh?: number;
  ls?: string;
  style?: React.CSSProperties;
  maxWidth?: number;
  hi?: string[];
  hiColor?: string;
};
/** Kinetic headline: each word rises out of a mask on a spring. Words in `grad` get the site gradient. */
export const Words: React.FC<WordsProps> = ({
  text, at, out, size, weight = 800, color = C.ink, grad, stagger = 0.07, align = 'left', lh = 1.08, ls = '-0.03em', style, maxWidth, hi, hiColor = C.warn,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const lines = text.split('\n');
  let k = 0;
  const outP = out === undefined ? 0 : lerp(t, out, out + 0.4, 0, 1, Easing.in(Easing.cubic));
  return (
    <div style={{ fontFamily: FONT, fontSize: size, fontWeight: weight, lineHeight: lh, letterSpacing: ls, color, textAlign: align, maxWidth, ...style }}>
      {lines.map((line, li) => (
        <div key={li} style={{ display: 'block' }}>
          {line.split(' ').map((w, wi) => {
            const idx = k++;
            const p = sprAt(frame, fps, at + idx * stagger, { damping: 20, stiffness: 140 });
            const cw = w.replace(/[.,]/g, '');
            const isGrad = grad === true || (Array.isArray(grad) && grad.some((x) => x.replace(/[.,]/g, '') === cw));
            return (
              <span key={wi} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', padding: '0.04em 0.02em 0.12em', margin: '-0.04em 0 -0.12em' }}>
                <span
                  style={{
                    display: 'inline-block',
                    transform: `translateY(${(1 - p) * 105 - outP * 105}%)`,
                    opacity: Math.min(1, p * 1.4) * (1 - outP),
                    ...(hi && hi.some((x) => x.replace(/[.,]/g, '') === cw) ? { color: hiColor } : {}),
                    ...(isGrad ? { background: GRAD, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' } : {}),
                  }}
                >
                  {w}
                  {wi < line.split(' ').length - 1 ? ' ' : ''}
                </span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export const Eyebrow: React.FC<{ text: string; at: number; out?: number; color?: string; style?: React.CSSProperties; size?: number }> = ({ text, at, out, color = C.cyan, style, size = 30 }) => {
  const t = useT();
  const env = useEnv(at, out);
  const wipe = lerp(t, at, at + 0.6);
  return (
    <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, letterSpacing: '0.18em', textTransform: 'uppercase', color, opacity: env, clipPath: `inset(0 ${100 - wipe * 100}% 0 0)`, ...style }}>
      {text}
    </div>
  );
};

/** Small pill, like the site's tags ("0 keys", "release 0.3", "testnet"). */
export const Chip: React.FC<{ children: React.ReactNode; at: number; out?: number; color?: string; size?: number; style?: React.CSSProperties; filled?: boolean }> = ({ children, at, out, color = C.ok, size = 26, style, filled }) => {
  const p = useSpring(at, { damping: 14, stiffness: 160 });
  const env = useEnv(at, out, 0.25);
  return (
    <div
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: FONT, fontWeight: 800, fontSize: size, color: filled ? C.bg : color,
        border: `2px solid ${color}`, background: filled ? color : `color-mix(in srgb, ${color} 12%, transparent)`, borderRadius: 999,
        padding: `${size * 0.28}px ${size * 0.75}px`, transform: `scale(${0.6 + 0.4 * p})`, opacity: env, whiteSpace: 'nowrap', letterSpacing: '0.02em', ...style,
      }}
    >
      {children}
    </div>
  );
};

/** The "testnet" marker shown wherever a result is on screen. */
export const Testnet: React.FC<{ at: number; out?: number; style?: React.CSSProperties; label?: string }> = ({ at, out, style, label = 'NEAR testnet' }) => (
  <Chip at={at} out={out} color={C.warn} size={26} style={style}>
    <span style={{ width: 10, height: 10, borderRadius: 99, background: C.warn, display: 'inline-block' }} />
    {label}
  </Chip>
);

export const Panel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; glow?: string }> = ({ children, style, glow }) => (
  <div
    style={{
      background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`, border: `2px solid ${C.line2}`, borderRadius: 22,
      boxShadow: glow ? `0 0 0 1px ${glow}55, 0 30px 80px -30px ${glow}88` : '0 30px 80px -40px #000', ...style,
    }}
  >
    {children}
  </div>
);

/** An account on the diagram. Centred on (x, y). */
export const Node: React.FC<{
  x: number; y: number; at: number; out?: number; title: string; sub?: string; w?: number; accent?: string; children?: React.ReactNode; size?: number; dim?: number; icon?: React.ReactNode;
}> = ({ x, y, at, out, title, sub, w = 380, accent = C.blue, children, size = 36, dim = 1, icon }) => {
  const p = useSpring(at, { damping: 15, stiffness: 130 });
  const env = useEnv(at, out, 0.3);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, transform: `translate(-50%, -50%) scale(${0.7 + 0.3 * p})`, opacity: env * dim }}>
      <Panel glow={accent} style={{ padding: '22px 26px', textAlign: 'center' }}>
        {icon}
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, color: C.ink, letterSpacing: '-0.01em', lineHeight: 1.15 }}>{title}</div>
        {sub ? <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: size * 0.64, color: C.ink2, marginTop: 6, lineHeight: 1.25 }}>{sub}</div> : null}
        {children}
      </Panel>
    </div>
  );
};

// Quadratic bezier helpers for edges and particles.
type Pt = [number, number];
const ctrl = (a: Pt, b: Pt, curve: number): Pt => {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return [mx - dy * curve, my + dx * curve];
};
export const bez = (a: Pt, b: Pt, curve: number, u: number): Pt => {
  const c = ctrl(a, b, curve);
  const v = 1 - u;
  return [v * v * a[0] + 2 * v * u * c[0] + u * u * b[0], v * v * a[1] + 2 * v * u * c[1] + u * u * b[1]];
};

/** A line drawn between two points, with optional particles (transfers) moving along it. */
export const Edge: React.FC<{
  a: Pt; b: Pt; at: number; dur?: number; out?: number; curve?: number; color?: string; width?: number; dashed?: boolean;
  particles?: { at: number; n?: number; every?: number; travel?: number; color?: string; r?: number; bounce?: boolean; stopAt?: number };
  label?: string; labelAt?: number;
}> = ({ a, b, at, dur = 0.7, out, curve = 0, color = C.line2, width = 3, dashed, particles, label, labelAt }) => {
  const t = useT();
  const { w, h } = useLayout();
  const draw = lerp(t, at, at + dur);
  const env = useEnv(at, out, 0.01);
  const c = ctrl(a, b, curve);
  const d = `M ${a[0]} ${a[1]} Q ${c[0]} ${c[1]} ${b[0]} ${b[1]}`;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.2 + 10;
  const dots: React.ReactNode[] = [];
  if (particles) {
    const { n = 3, every = 0.35, travel = 0.9, r = 9, bounce, stopAt } = particles;
    for (let i = 0; i < n; i++) {
      const s0 = particles.at + i * every;
      if (stopAt !== undefined && s0 > stopAt) continue;
      let u = (t - s0) / travel;
      if (u < 0) continue;
      let alpha = 1;
      if (bounce) {
        // travels to ~92% of the path, then is thrown back to the start
        if (u > 1) { const back = (u - 1) * 1.4; u = 0.92 - back; alpha = 1 - lerp(back, 0.5, 0.92); if (u < 0) continue; }
        else u = u * 0.92;
      } else if (u > 1) continue;
      const pt = bez(a, b, curve, u);
      const col = particles.color ?? C.cyan;
      dots.push(
        <g key={i} opacity={alpha * env}>
          <circle cx={pt[0]} cy={pt[1]} r={r * 2.4} fill={col} opacity={0.18} />
          <circle cx={pt[0]} cy={pt[1]} r={r} fill={col} />
        </g>,
      );
    }
  }
  const lp = label ? bez(a, b, curve, 0.5) : null;
  const lEnv = lerp(t, labelAt ?? at + dur * 0.6, (labelAt ?? at + dur * 0.6) + 0.4) * env;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" opacity={env}
          strokeDasharray={dashed ? '10 12' : `${len}`} strokeDashoffset={dashed ? -t * 30 : len * (1 - draw)}
          style={dashed ? { clipPath: `inset(0 ${100 - draw * 100}% 0 0)` } : undefined} />
        {dots}
      </svg>
      {lp && label ? (
        <div style={{ position: 'absolute', left: lp[0], top: lp[1] - 34, transform: 'translate(-50%, -50%)', fontFamily: FONT, fontWeight: 800, fontSize: 24, color: C.ink2, background: C.bg, padding: '4px 12px', borderRadius: 8, opacity: lEnv, whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
          {label}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** Transaction stamp: a verdict pressed onto the screen, carrying the real (shortened) tx hash. */
export const Stamp: React.FC<{ at: number; out?: number; verdict: string; reason?: string; tx?: string; color?: string; rot?: number; size?: number; style?: React.CSSProperties; maxWidth?: number }> = ({
  at, out, verdict, reason, tx, color = C.bad, rot = -4, size = 1, style, maxWidth = 760,
}) => {
  const p = useSpring(at, { damping: 13, stiffness: 220, mass: 0.8 });
  const env = useEnv(at, out, 0.08);
  const t = useT();
  const flash = 1 - lerp(t, at + 0.05, at + 0.5);
  return (
    <div style={{ transform: `rotate(${rot}deg) scale(${1.7 - 0.7 * p})`, opacity: env, maxWidth, ...style }}>
      <div
        style={{
          border: `4px solid ${color}`, borderRadius: 16, padding: `${16 * size}px ${26 * size}px`, background: `color-mix(in srgb, ${C.bg} 82%, ${color})`,
          boxShadow: `0 0 ${60 * flash}px ${color}`, fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 46 * size, color, letterSpacing: '0.08em' }}>{verdict}</span>
          {tx ? <span style={{ fontWeight: 500, fontSize: 22 * size, color: C.ink2, letterSpacing: '0.02em' }}>tx {tx}</span> : null}
        </div>
        {reason ? <div style={{ fontWeight: 500, fontSize: 28 * size, color: C.ink, marginTop: 6, lineHeight: 1.3 }}>{reason}</div> : null}
      </div>
    </div>
  );
};

/** Number that ticks up to its value. */
export const Counter: React.FC<{ to: number; from?: number; at: number; dur?: number; decimals?: number; style?: React.CSSProperties; suffix?: string; prefix?: string; group?: boolean }> = ({
  to, from = 0, at, dur = 1, decimals = 0, style, suffix = '', prefix = '', group = true,
}) => {
  const t = useT();
  const v = from + (to - from) * lerp(t, at, at + dur, 0, 1, Easing.out(Easing.cubic));
  const s = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: group });
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{prefix}{s}{suffix}</span>;
};

/** Check row that ticks in. */
export const Check: React.FC<{ at: number; text: string; size?: number; ok?: boolean; color?: string }> = ({ at, text, size = 32, ok = true, color }) => {
  const p = useSpring(at, { damping: 16, stiffness: 170 });
  const t = useT();
  const col = color ?? (ok ? C.ok : C.bad);
  const draw = lerp(t, at + 0.05, at + 0.35);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: FONT, fontWeight: 800, fontSize: size, color: C.ink, opacity: Math.min(1, p * 1.5), transform: `translateX(${(1 - p) * -30}px)` }}>
      <svg width={size * 1.2} height={size * 1.2} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="11" fill={`${col}22`} stroke={col} strokeWidth="1.6" />
        {ok ? (
          <path d="M7 12.5 L10.5 16 L17 8.5" fill="none" stroke={col} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="20" strokeDashoffset={20 * (1 - draw)} />
        ) : (
          <path d="M8 8 L16 16 M16 8 L8 16" fill="none" stroke={col} strokeWidth="2.4" strokeLinecap="round" strokeDasharray="24" strokeDashoffset={24 * (1 - draw)} />
        )}
      </svg>
      <span>{text}</span>
    </div>
  );
};

/** Browser window holding real footage of the live site. `focus` animates a crop (in image px of the 2x shot). */
export const BrowserFrame: React.FC<{
  src: string; at: number; out?: number; width: number; viewH: number; imgW: number;
  scroll?: [number, number, number, number]; // [t0, t1, y0, y1] in image px
  zoom?: [number, number, number, number]; // [t0, t1, z0, z1]
  tilt?: [number, number]; // rotateY from -> to over the shot
  url?: string; style?: React.CSSProperties; children?: React.ReactNode; reveal?: [number, number]; origin?: string;
}> = ({ origin = '0% 0%', src, at, out, width, viewH, imgW, scroll, zoom, tilt = [-10, -3], url = 'unajijacob6-create.github.io/plinth', style, children, reveal }) => {
  const t = useT();
  const p = useSpring(at, { damping: 20, stiffness: 90 });
  const env = useEnv(at, out, 0.3);
  const k = width / imgW;
  const y = scroll ? lerp(t, scroll[0], scroll[1], scroll[2], scroll[3], Easing.inOut(Easing.cubic)) : 0;
  const z = zoom ? lerp(t, zoom[0], zoom[1], zoom[2], zoom[3], Easing.inOut(Easing.cubic)) : 1;
  const ry = interpolate(t, [at, (out ?? at + 6) + 0.4], tilt, clamp);
  const rv = reveal ? lerp(t, reveal[0], reveal[1], 0, 100, Easing.inOut(Easing.cubic)) : 100;
  return (
    <div style={{ perspective: 2200, opacity: env, ...style }}>
      <div
        style={{
          width, transform: `translateY(${(1 - p) * 80}px) rotateY(${ry}deg) rotateX(${(1 - p) * 8 + 2}deg)`, transformOrigin: '50% 50%',
          borderRadius: 18, overflow: 'hidden', border: `2px solid ${C.line2}`, background: C.bg2,
          boxShadow: `0 60px 120px -40px #000, 0 0 0 1px #000, 0 0 90px -30px ${C.blue}`,
        }}
      >
        <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', background: C.panel, borderBottom: `1px solid ${C.line2}` }}>
          {['#f87171', '#fbbf24', '#34d399'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: 99, background: c, opacity: 0.8 }} />)}
          <div style={{ marginLeft: 18, flex: 1, height: 32, borderRadius: 9, background: C.bg, border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: FONT, fontWeight: 500, fontSize: 18, color: C.ink2, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span style={{ color: C.ok, marginRight: 8 }}>●</span>{url}
          </div>
        </div>
        <div style={{ height: viewH, overflow: 'hidden', position: 'relative' }}>
          <div style={{ transform: `scale(${z})`, transformOrigin: origin, clipPath: `inset(0 0 ${100 - rv}% 0)` }}>
            <Img src={staticFile(src)} style={{ width, display: 'block', transform: `translateY(${-y * k}px)` }} />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

export const Logo: React.FC<{ size: number; at: number }> = ({ size, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const blocks = [
    { x: 5, y: 20, w: 22, h: 6, c: C.blue, d: 0 },
    { x: 9, y: 12, w: 14, h: 6, c: C.cyan, d: 0.12 },
    { x: 13, y: 4, w: 6, h: 6, c: C.ink, d: 0.24 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ overflow: 'visible' }}>
      {blocks.map((b, i) => {
        const p = sprAt(frame, fps, at + b.d, { damping: 12, stiffness: 160 });
        return <rect key={i} x={b.x} y={b.y - (1 - p) * 14} width={b.w} height={b.h} rx={1.5} fill={b.c} opacity={Math.min(1, p * 2)} />;
      })}
    </svg>
  );
};

/** Persistent background: site colours, drifting glow, faint grid, grain. */
export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame / 30;
  const gx = 32 + Math.sin(t * 0.15) * 8, gy = 30 + Math.cos(t * 0.11) * 6;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(45% 55% at ${gx}% ${gy}%, ${C.blue}2e, transparent 72%), radial-gradient(38% 46% at ${100 - gx + 2}% ${gy + 40}%, ${C.cyan}1c, transparent 72%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px), linear-gradient(90deg, ${C.line} 1px, transparent 1px)`,
          backgroundSize: '96px 96px', backgroundPosition: `${(t * 6) % 96}px ${(t * 4) % 96}px`, opacity: 0.35,
          WebkitMaskImage: 'radial-gradient(70% 70% at 50% 45%, #000, transparent)', maskImage: 'radial-gradient(70% 70% at 50% 45%, #000, transparent)',
        }}
      />
      <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 50% 40%, transparent 55%, #000a)` }} />
      <AbsoluteFill
        style={{
          backgroundImage: `url(${staticFile('grain.png')})`, backgroundPosition: `${(frame * 137) % 512}px ${(frame * 251) % 512}px`,
          opacity: 0.06, mixBlendMode: 'overlay', width, height,
        }}
      />
    </AbsoluteFill>
  );
};

/** Scene wrapper: soft in/out (blur + scale) so cuts feel continuous. Times are local. */
export const Shell: React.FC<{ dur: number; children: React.ReactNode; inT?: number; outT?: number }> = ({ dur, children, inT = 0.35, outT = 0.35 }) => {
  const t = useT();
  const i = lerp(t, 0, inT);
  const o = 1 - lerp(t, dur - outT, dur, 0, 1, Easing.in(Easing.cubic));
  const v = Math.min(i, o);
  const s = 1 + (1 - i) * 0.03 - (1 - o) * 0.04;
  return <AbsoluteFill style={{ opacity: v, transform: `scale(${s})`, filter: v < 1 ? `blur(${(1 - v) * 10}px)` : undefined }}>{children}</AbsoluteFill>;
};
