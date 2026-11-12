import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from './theme';

// ---------------------------------------------------------------- time helpers
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
export const ease = Easing.bezier(0.2, 0.7, 0.2, 1); // the site's --ease
export const lerp = (t: number, a: number, b: number, from = 0, to = 1, e = ease) => interpolate(t, [a, b], [from, to], { ...clamp, easing: e });
export const sprAt = (frame: number, fps: number, at: number, cfg = {}) =>
  spring({ frame: frame - Math.round(at * fps), fps, config: { damping: 20, stiffness: 120, mass: 0.9, ...cfg } });
export const useSpring = (at: number, cfg = {}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return sprAt(frame, fps, at, cfg);
};
/** in at `at`, out at `out` (local seconds) */
export const useEnv = (at: number, out = 1e9, inDur = 0.5, outDur = 0.35) => {
  const t = useT();
  return Math.min(lerp(t, at, at + inDur), 1 - lerp(t, out, out + outDur, 0, 1, Easing.in(Easing.cubic)));
};
/** piecewise interpolation over keyframes [t, value] */
export const keyed = (t: number, keys: [number, number][]) =>
  keys.length === 1 ? keys[0][1] : interpolate(t, keys.map((k) => k[0]), keys.map((k) => k[1]), { ...clamp, easing: Easing.inOut(Easing.cubic) });

// ---------------------------------------------------------------- type
type DisplayProps = {
  text: string; // *word* = Instrument Serif italic accent, \n = line break
  at: number;
  out?: number;
  size: number;
  align?: 'left' | 'center';
  color?: string;
  accent?: string;
  stagger?: number;
  style?: React.CSSProperties;
  weight?: number;
};
/** Display line in the site's style: Inter Tight 600, tight tracking, one italic serif phrase. Words rise from a mask. */
export const Display: React.FC<DisplayProps> = ({ text, at, out, size, align = 'left', color = C.on, accent = C.blueSoft, stagger = 0.06, style, weight = 600 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const outP = out === undefined ? 0 : lerp(t, out, out + 0.4, 0, 1, Easing.in(Easing.cubic));
  let k = 0;
  return (
    <div style={{ fontFamily: F.display, fontWeight: weight, fontSize: size, lineHeight: 1.04, letterSpacing: '-0.045em', color, textAlign: align, ...style }}>
      {text.split('\n').map((line, li) => {
        // split into tokens, keeping *accent* groups
        const parts: { w: string; it: boolean }[] = [];
        line.split(/(\*[^*]+\*)/).filter(Boolean).forEach((seg) => {
          const it = seg.startsWith('*');
          seg.replace(/\*/g, '').split(' ').filter(Boolean).forEach((w) => parts.push({ w, it }));
        });
        return (
          <div key={li}>
            {parts.map((p, i) => {
              const s = sprAt(frame, fps, at + k++ * stagger, { damping: 22, stiffness: 140 });
              return (
                <span key={i} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', padding: '0.06em 0.03em 0.16em', margin: '-0.06em 0 -0.16em' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      transform: `translateY(${(1 - s) * 110 - outP * 110}%)`,
                      opacity: Math.min(1, s * 1.5) * (1 - outP),
                      ...(p.it ? { fontFamily: F.serif, fontStyle: 'italic', fontWeight: 400, letterSpacing: '-0.01em', color: accent } : {}),
                    }}
                  >
                    {p.w}
                    {i < parts.length - 1 ? ' ' : ''}
                  </span>
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/** The site's label: a short blue dash, then the text (Manrope 700, sentence case). */
export const Label: React.FC<{ text: string; at: number; out?: number; size?: number; style?: React.CSSProperties; color?: string }> = ({ text, at, out, size = 28, style, color = C.on2 }) => {
  const t = useT();
  const env = useEnv(at, out, 0.4);
  const dash = lerp(t, at, at + 0.5);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: F.body, fontWeight: 800, fontSize: size, color, opacity: env, ...style }}>
      <span style={{ width: 34 * dash, height: 3, borderRadius: 2, background: C.blue, display: 'inline-block' }} />
      <span style={{ transform: `translateX(${(1 - dash) * -12}px)` }}>{text}</span>
    </div>
  );
};

/** One line of explanation behind a thin accent bar. */
export const Line: React.FC<{ text: string; at: number; out?: number; size?: number; style?: React.CSSProperties; maxWidth?: number }> = ({ text, at, out, size = 36, style, maxWidth = 700 }) => {
  const t = useT();
  const env = useEnv(at, out, 0.5);
  const bar = lerp(t, at, at + 0.6);
  return (
    <div style={{ display: 'flex', gap: 22, opacity: env, maxWidth, ...style }}>
      <div style={{ width: 4, borderRadius: 2, background: `linear-gradient(${C.blue}, ${C.cyan})`, transform: `scaleY(${bar})`, transformOrigin: 'top' }} />
      <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: size, lineHeight: 1.4, color: C.on2, transform: `translateY(${(1 - bar) * 12}px)` }}>{text}</div>
    </div>
  );
};

/** Pill like the site's tags on the night band. */
export const Pill: React.FC<{ children: React.ReactNode; at: number; out?: number; dot?: string; size?: number; style?: React.CSSProperties; strong?: boolean }> = ({ children, at, out, dot, size = 24, style, strong }) => {
  const p = useSpring(at, { damping: 16, stiffness: 170 });
  const env = useEnv(at, out, 0.25);
  return (
    <div
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: F.body, fontWeight: 700, fontSize: size, color: strong ? '#fff' : C.on,
        background: strong ? C.blue : C.glass, border: `1px solid ${strong ? C.blue : C.glassLine}`, borderRadius: 999, padding: `${size * 0.36}px ${size * 0.8}px`,
        opacity: env, transform: `scale(${0.85 + 0.15 * p})`, whiteSpace: 'nowrap', boxShadow: strong ? `0 10px 40px -10px ${C.blue}` : undefined, ...style,
      }}
    >
      {dot ? <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: 99, background: dot, boxShadow: `0 0 12px ${dot}` }} /> : null}
      {children}
    </div>
  );
};
export const Testnet: React.FC<{ at: number; out?: number; style?: React.CSSProperties; text?: string }> = ({ at, out, style, text = 'NEAR testnet' }) => (
  <Pill at={at} out={out} dot="#f5c451" size={22} style={style}>{text}</Pill>
);

/** Glass card on the night band. */
export const Glass: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; glow?: string }> = ({ children, style, glow }) => (
  <div
    style={{
      background: 'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.04))', border: `1px solid ${C.glassLine}`, borderRadius: 24,
      boxShadow: `0 30px 80px -30px rgba(0,0,0,.8)${glow ? `, 0 0 70px -20px ${glow}` : ''}`, backdropFilter: 'blur(10px)', ...style,
    }}
  >
    {children}
  </div>
);

/** Result card for a recorded on-chain outcome: state dot, one sentence, tx. */
export const Proof: React.FC<{ at: number; out?: number; state: 'ok' | 'bad'; head: string; body?: React.ReactNode; tx?: string; width?: number; style?: React.CSSProperties; size?: number }> = ({
  at, out, state, head, body, tx, width = 640, style, size = 1,
}) => {
  const p = useSpring(at, { damping: 15, stiffness: 160 });
  const env = useEnv(at, out, 0.3);
  const t = useT();
  const col = state === 'ok' ? C.ok : C.bad;
  const flash = 1 - lerp(t, at + 0.1, at + 0.8);
  return (
    <div style={{ width, opacity: env, transform: `translateY(${(1 - p) * 40}px) scale(${0.94 + 0.06 * p})`, ...style }}>
      <Glass glow={flash > 0.02 ? col : undefined} style={{ padding: `${22 * size}px ${28 * size}px`, borderColor: `${col}66`, background: 'linear-gradient(180deg, rgba(13,28,70,.96), rgba(7,20,54,.96))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 30 * size, height: 30 * size, borderRadius: 99, background: `${col}22`, border: `2px solid ${col}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: col, fontFamily: F.body, fontWeight: 800, fontSize: 18 * size, flex: 'none' }}>
            {state === 'ok' ? '✓' : '✕'}
          </span>
          <span style={{ fontFamily: F.display, fontWeight: 650, fontSize: 32 * size, letterSpacing: '-0.02em', color: C.on }}>{head}</span>
        </div>
        {body ? <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: 24 * size, lineHeight: 1.45, color: C.on2, marginTop: 10 * size }}>{body}</div> : null}
        {tx ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 * size, fontFamily: F.body, fontWeight: 700, fontSize: 20 * size, color: C.on3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 9, background: '#f5c451' }} />
            Recorded on NEAR testnet · tx {tx}
          </div>
        ) : null}
      </Glass>
    </div>
  );
};

export const Counter: React.FC<{ to: number; at: number; dur?: number; decimals?: number; style?: React.CSSProperties }> = ({ to, at, dur = 1, decimals = 0, style }) => {
  const t = useT();
  const v = to * lerp(t, at, at + dur, 0, 1, Easing.out(Easing.cubic));
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
};

// ---------------------------------------------------------------- footage in a browser frame
export type Layer = {
  src: string; // in public/
  at: number; // when it slides in
  keys?: [number, number, number][]; // [t, scrollY (image px), zoom]
};
export type Ring = { at: number; out: number; x: number; y: number; w: number; h: number; color?: string; layer: number };
export type Cursor = [number, number, number, boolean?][]; // [t, x, y, tap]: image px measured from the top-left of the window (not scrolled)

/**
 * Real footage of the live site inside a window frame. Every coordinate (scroll, rings, cursor) is in
 * image pixels of the 2x screenshots, so overlays stay glued to the UI while it scrolls and zooms.
 */
export const Shot: React.FC<{
  layers: Layer[]; imgW: number; width: number; viewH: number; at: number; out?: number;
  rings?: Ring[]; cursor?: Cursor; url?: string; tilt?: [number, number]; style?: React.CSSProperties; dur?: number;
}> = ({ layers, imgW, width, viewH, at, out, rings = [], cursor, url = 'unajijacob6-create.github.io/plinth', tilt = [-7, -2], style, dur = 8 }) => {
  const t = useT();
  const p = useSpring(at, { damping: 22, stiffness: 90 });
  const env = useEnv(at, out, 0.35);
  const k = width / imgW;
  const cur = layers.reduce((acc, l, i) => (t >= l.at ? i : acc), 0);
  const state = (l: Layer) => {
    const keys = l.keys ?? [[0, 0, 1]];
    return { y: keyed(t, keys.map((q) => [q[0], q[1]])), z: keyed(t, keys.map((q) => [q[0], q[2]])) };
  };
  const toView = (li: number, x: number, y: number) => {
    const s = state(layers[li]);
    return [x * k * s.z, (y - s.y) * k * s.z, s.z] as const;
  };
  const ry = interpolate(t, [at, (out ?? at + dur) + 0.4], tilt, clamp);
  return (
    <div style={{ perspective: 2400, opacity: env, ...style }}>
      <div
        style={{
          width, transform: `translateY(${(1 - p) * 90}px) rotateY(${ry}deg) rotateX(${(1 - p) * 10 + 1.5}deg)`,
          borderRadius: 20, overflow: 'hidden', background: '#fff', border: `1px solid ${C.glassLine}`,
          boxShadow: `0 70px 140px -50px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,.04), 0 0 120px -40px ${C.glow}`,
        }}
      >
        <div style={{ height: 50, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', background: '#0d1630', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          {['#ff6b61', '#f5c451', '#3ddc97'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: 99, background: c, opacity: 0.85 }} />)}
          <div style={{ marginLeft: 18, flex: 1, height: 32, borderRadius: 999, background: 'rgba(255,255,255,.07)', display: 'flex', alignItems: 'center', padding: '0 16px', fontFamily: F.body, fontWeight: 600, fontSize: 18, color: C.on2, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span style={{ color: C.ok, marginRight: 10, fontSize: 12 }}>●</span>{url}
          </div>
        </div>
        <div style={{ height: viewH, overflow: 'hidden', position: 'relative', background: C.bg }}>
          {layers.map((l, i) => {
            if (i < cur - 1 || t < l.at - 0.05) return null;
            const s = state(l);
            const inP = i === 0 ? 1 : lerp(t, l.at, l.at + 0.45);
            const next = layers[i + 1];
            const outP = next ? lerp(t, next.at, next.at + 0.45) : 0;
            return (
              <div key={i} style={{ position: 'absolute', inset: 0, opacity: Math.min(inP, 1 - outP * 0.999), transform: `translateX(${(1 - inP) * 60 - outP * 60}px)` }}>
                <div style={{ transform: `scale(${s.z})`, transformOrigin: '0 0' }}>
                  <Img src={staticFile(l.src)} style={{ width, display: 'block', transform: `translateY(${-s.y * k}px)` }} />
                </div>
              </div>
            );
          })}
          {rings.map((r, i) => {
            if (t < r.at - 0.1 || t > r.out + 0.5) return null;
            const [x, y, z] = toView(r.layer, r.x, r.y);
            const a = lerp(t, r.at, r.at + 0.35) * (1 - lerp(t, r.out, r.out + 0.3));
            const col = r.color ?? C.blue;
            const grow = 1 + (1 - lerp(t, r.at, r.at + 0.45)) * 0.12;
            return (
              <div key={i} style={{ position: 'absolute', left: x - 8, top: y - 8, width: r.w * k * z + 16, height: r.h * k * z + 16, borderRadius: 18, border: `4px solid ${col}`, boxShadow: `0 0 0 9999px rgba(3,8,23,${0.28 * a}), 0 0 30px ${col}`, opacity: a, transform: `scale(${grow})` }} />
            );
          })}
          {cursor ? <CursorMark keys={cursor} toView={(x, y) => [x * k, y * k, 1] as const} /> : null}
        </div>
      </div>
    </div>
  );
};

const CursorMark: React.FC<{ keys: Cursor; toView: (x: number, y: number) => readonly [number, number, number] }> = ({ keys, toView }) => {
  const t = useT();
  if (t < keys[0][0] - 0.3) return null;
  const x = keyed(t, keys.map((q) => [q[0], q[1]]));
  const y = keyed(t, keys.map((q) => [q[0], q[2]]));
  const [vx, vy] = toView(x, y);
  const taps = keys.filter((q) => q[3]).map((q) => q[0]);
  const lastTap = taps.filter((s) => s <= t).pop();
  const since = lastTap === undefined ? 9 : t - lastTap;
  const press = since < 0.25 ? 1 - Math.abs(since - 0.12) / 0.13 : 0;
  const fade = lerp(t, keys[0][0] - 0.3, keys[0][0]) * (1 - lerp(t, keys[keys.length - 1][0] + 0.6, keys[keys.length - 1][0] + 1));
  return (
    <div style={{ position: 'absolute', left: vx, top: vy, opacity: fade, pointerEvents: 'none' }}>
      {since < 0.7 ? (
        <div style={{ position: 'absolute', left: -40, top: -40, width: 80, height: 80, borderRadius: 99, border: `3px solid ${C.blue}`, opacity: 1 - since / 0.7, transform: `scale(${0.3 + since * 1.4})` }} />
      ) : null}
      <svg width="40" height="40" viewBox="0 0 24 24" style={{ transform: `scale(${1 - press * 0.15})`, transformOrigin: '0 0', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.35))' }}>
        <path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.7 L11 13.3 L18 13.3 Z" fill="#0a1430" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

// ---------------------------------------------------------------- brand
export const Logo: React.FC<{ size: number; at: number }> = ({ size, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const blocks = [
    { x: 5, y: 20, w: 22, h: 6, c: C.blue, d: 0 },
    { x: 9, y: 12, w: 14, h: 6, c: C.cyan, d: 0.12 },
    { x: 13, y: 4, w: 6, h: 6, c: C.on, d: 0.24 },
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

/** The night band: deep navy, drifting blue light, soft beams, a few stars, grain. */
export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame / 30;
  const stars = React.useMemo(() => Array.from({ length: 70 }, (_, i) => ({ x: (i * 977) % 1000 / 10, y: (i * 613) % 1000 / 10, r: 0.6 + ((i * 37) % 10) / 10, p: i * 0.7 })), []);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${C.night}, ${C.night2} 120%)` }}>
      <AbsoluteFill style={{ background: `radial-gradient(38% 45% at ${22 + Math.sin(t * 0.12) * 6}% ${10 + Math.cos(t * 0.1) * 5}%, rgba(47,107,255,.42), transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(32% 40% at ${82 + Math.cos(t * 0.09) * 5}% ${30 + Math.sin(t * 0.11) * 6}%, rgba(34,195,230,.18), transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(60% 40% at 50% 115%, rgba(47,107,255,.22), transparent 70%)` }} />
      {[18, 46, 72].map((x, i) => (
        <div key={i} style={{ position: 'absolute', top: '-10%', left: `${x}%`, width: 140 - i * 30, height: '75%', background: 'radial-gradient(50% 100% at 50% 0%, rgba(150,190,255,.18), transparent 80%)', transform: `skewX(${-8 + i * 9}deg)`, opacity: 0.35 + 0.25 * Math.sin(t * 0.6 + i * 2) }} />
      ))}
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {stars.map((s, i) => <circle key={i} cx={(s.x / 100) * width} cy={(s.y / 100) * height * 0.8} r={s.r} fill="#cfe0ff" opacity={0.15 + 0.25 * (0.5 + 0.5 * Math.sin(t * 1.3 + s.p))} />)}
      </svg>
      <AbsoluteFill style={{ backgroundImage: `url(${staticFile('grain.png')})`, backgroundPosition: `${(frame * 137) % 512}px ${(frame * 251) % 512}px`, opacity: 0.05, mixBlendMode: 'overlay' }} />
    </AbsoluteFill>
  );
};

/** Scene wrapper: soft blur/scale in and out so cuts carry the eye. */
export const Shell: React.FC<{ dur: number; children: React.ReactNode; inT?: number; outT?: number }> = ({ dur, children, inT = 0.4, outT = 0.4 }) => {
  const t = useT();
  const i = lerp(t, 0, inT);
  const o = 1 - lerp(t, dur - outT, dur, 0, 1, Easing.in(Easing.cubic));
  const v = Math.min(i, o);
  return <AbsoluteFill style={{ opacity: v, transform: `scale(${1 + (1 - i) * 0.025 - (1 - o) * 0.03})`, filter: v < 1 ? `blur(${(1 - v) * 12}px)` : undefined }}>{children}</AbsoluteFill>;
};
