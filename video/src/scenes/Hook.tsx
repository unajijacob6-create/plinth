import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, FONT } from '../theme';
import { S, at } from '../timeline';
import { BrowserFrame, Chip, Counter, Edge, Eyebrow, Logo, Panel, Stamp, Testnet, Words, lerp, useEnv, useLayout, useSpring, useT } from '../components';

export const KeyIcon: React.FC<{ size: number; color?: string }> = ({ size, color = C.warn }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <circle cx="15" cy="24" r="9" fill="none" stroke={color} strokeWidth="4" />
    <path d="M24 24 H44 M37 24 V32 M43 24 V30" stroke={color} strokeWidth="4" strokeLinecap="round" fill="none" />
  </svg>
);

/** 1. Hook: "Every fund has someone who can change the rules. This one doesn't." */
export const Hook: React.FC = () => {
  const t = useT();
  const { L } = useLayout();
  const tThis = at('This') - 0.1;
  const tPlinth = at('Plinth') - 0.05;
  const keysOut = tThis - 0.4;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* line 1 with three keys = people who can change the rules */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 50 }}>
        <div style={{ display: 'flex', gap: 46, height: 110 }}>
          {[0, 1, 2].map((i) => {
            const p = useSpring(0.5 + i * 0.22, { damping: 11, stiffness: 150 });
            const fall = lerp(t, keysOut + i * 0.05, keysOut + 0.5 + i * 0.05);
            return (
              <div key={i} style={{ opacity: Math.min(1, p) * (1 - fall), transform: `translateY(${(1 - p) * -40 + fall * 160}px) rotate(${(1 - p) * -40 + fall * (i - 1) * 50 + Math.sin(t * 2 + i) * 4}deg)` }}>
                <KeyIcon size={L(110, 96)} />
              </div>
            );
          })}
        </div>
        <Words text={L('Every fund has someone\nwho can change the rules.', 'Every fund has\nsomeone who can\nchange the rules.')} at={0.1} out={keysOut} size={L(104, 84)} align="center" hi={['change', 'rules']} />
      </AbsoluteFill>
      {/* "This one doesn't." */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Words text="This one doesn't." at={tThis} out={tPlinth - 0.25} size={L(170, 130)} align="center" grad={["doesn't."]} stagger={0.1} />
      </AbsoluteFill>
      {/* Plinth: a fund on NEAR with no keys */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 34, opacity: useEnv(tPlinth, S.hook[1] - 0.25) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
          <Logo size={L(150, 120)} at={tPlinth} />
          <Words text="Plinth" at={tPlinth + 0.15} size={L(150, 120)} />
        </div>
        <Words text={L('A fund on NEAR with no keys.', 'A fund on NEAR\nwith no keys.')} at={at('fund', 1) - 0.05} size={L(64, 60)} weight={500} color={C.ink2} align="center" grad={['no', 'keys.']} ls="-0.01em" />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 2. No keys: the account, its fingerprint, and the live verifier. */
export const NoKeys: React.FC = () => {
  const t = useT();
  const { L, sq } = useLayout();
  const o = S.keys[0];
  const g = (x: number) => x - o;
  const tZero = g(at('zero')) - 0.15;
  const tCode = g(at('Its')) - 0.3;
  const tPub = g(at('published'));
  const tPin = g(at('pinned'));
  const tByte = g(at('byte'));
  const tCheck = g(at('Anyone')) - 0.35;
  const dur = S.keys[1] - S.keys[0];
  const H = '3j5tSNim99x5caDaQF618gJL1QdcZQTJT7yk9G4PJn23';
  const typed = Math.round(lerp(t, tCode + 0.4, tCode + 1.6) * H.length);
  return (
    <AbsoluteFill>
      {/* A: the account with an empty key slot */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: useEnv(0, tCode, 0.3, 0.3), transform: `scale(${1 + lerp(t, 0, tCode, 0, 0.05)})` }}>
        <Eyebrow text="A Plinth fund is an account" at={0.1} style={{ position: 'absolute', top: L(130, 150) }} size={L(26, 24)} />
        <Panel glow={C.blue} style={{ width: L(1100, 900), padding: '44px 56px', marginTop: -40 }}>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(54, 44), color: C.ink, letterSpacing: '-0.02em' }}>fund-mwc4ll9q</div>
          <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: L(30, 28), color: C.ink2 }}>.funds.plinthfund.testnet</div>
          <div style={{ height: 2, background: C.line2, margin: '30px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 30 }}>
            <div>
              <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 24, letterSpacing: '0.16em', color: C.ink3 }}>ACCESS KEYS</div>
              <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(170, 150), lineHeight: 1, color: C.ok, transform: `scale(${0.6 + 0.4 * useSpring(tZero, { damping: 10, stiffness: 160 })})`, transformOrigin: 'left bottom', opacity: lerp(t, tZero, tZero + 0.15) }}>0</div>
            </div>
            {/* the empty key slot */}
            <div style={{ width: L(420, 330), height: 150, borderRadius: 20, border: `3px dashed ${C.line2}`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', fontFamily: FONT, fontWeight: 500, fontSize: 26, color: C.ink3 }}>
              <span style={{ opacity: lerp(t, 1.4, 1.8) }}>no key can be added</span>
              <div style={{ position: 'absolute', opacity: (1 - lerp(t, 1.0, 1.4)) * lerp(t, 0.2, 0.4), transform: `translateY(${-90 + lerp(t, 0.2, 0.9, 0, 90)}px) rotate(${lerp(t, 0.9, 1.4, 0, 30)}deg)` }}>
                <svg width="90" height="90" viewBox="0 0 48 48"><circle cx="15" cy="24" r="9" fill="none" stroke={C.ink3} strokeWidth="4" /><path d="M24 24 H44 M37 24 V32" stroke={C.ink3} strokeWidth="4" strokeLinecap="round" /></svg>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 30 }}>
            <Chip at={tZero + 0.3} color={C.ok}>0 keys</Chip>
            <Chip at={tZero + 0.45} color={C.ink2}>release 0.3</Chip>
            <Testnet at={tZero + 0.6} />
          </div>
        </Panel>
      </AbsoluteFill>

      {/* B: the code fingerprint, published once and rebuilt reproducibly */}
      <AbsoluteFill style={{ alignItems: 'center', opacity: useEnv(tCode, tCheck - 0.1, 0.3, 0.3) }}>
        <Eyebrow text="Release 0.3 · code fingerprint" at={tCode + 0.1} style={{ position: 'absolute', top: L(120, 130) }} size={L(26, 24)} />
        <div style={{ position: 'absolute', top: L(200, 220), width: '100%', textAlign: 'center', fontFamily: FONT, fontWeight: 800, fontSize: L(62, 46), letterSpacing: '0.01em', color: C.ink, lineHeight: 1.2, padding: '0 60px' }}>
          {sq ? (
            <>
              <span>{H.slice(0, Math.min(typed, 22))}</span>
              <br />
              <span>{typed > 22 ? H.slice(22, typed) : ''}</span>
            </>
          ) : (
            <span>
              <span style={{ background: 'linear-gradient(90deg,#3d8bff,#22d3ee)', WebkitBackgroundClip: 'text', color: 'transparent' }}>{H.slice(0, Math.min(typed, 8))}</span>
              {H.slice(8, typed)}
            </span>
          )}
          <span style={{ opacity: typed < H.length && Math.floor(t * 4) % 2 === 0 ? 1 : 0, color: C.cyan }}>▍</span>
        </div>
        {/* build pipeline drawn as a line diagram */}
        {(() => {
          const y = L(560, 610);
          const xs = L([330, 960, 1590], [200, 540, 880]);
          const w = L(470, 310);
          return (
            <>
              <Edge a={[xs[0] + w / 2 - 10, y]} b={[xs[1] - w / 2 + 10, y]} at={tPub - 0.3} dur={0.5} color={C.cyan} particles={{ at: tPub, n: 3, every: 0.4, travel: 0.7 }} />
              <Edge a={[xs[1] + w / 2 - 10, y]} b={[xs[2] - w / 2 + 10, y]} at={tPin - 0.2} dur={0.5} color={C.cyan} particles={{ at: tPin + 0.2, n: 3, every: 0.4, travel: 0.7 }} />
              <NodeBox x={xs[0]} y={y} w={w} at={tPub - 0.6} title="commit aecddbb" sub="pinned build image" />
              <NodeBox x={xs[1]} y={y} w={w} at={tPub} title="311,122 bytes" sub="published once" accent={C.cyan} />
              <NodeBox x={xs[2]} y={y} w={w} at={tPin} title="by hash" sub="global contract, NEP-591" accent={C.ok} />
            </>
          );
        })()}
        <div style={{ position: 'absolute', top: L(720, 760), width: '100%', display: 'flex', justifyContent: 'center', gap: 40, flexWrap: 'wrap' }}>
          <Stamp at={tPub + 0.5} verdict="PUBLISHED" tx="3Mpr34HR…" color={C.cyan} size={0.8} rot={-3} />
          <Stamp at={tByte} verdict="REBUILT · SAME HASH" color={C.ok} size={0.8} rot={2} />
        </div>
      </AbsoluteFill>

      {/* C: the live verifier passing on this fund (real footage) */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        {t > tCheck - 0.2 ? (
          <>
            <div style={{ position: 'absolute', top: L(70, 120), display: 'flex', gap: 16, alignItems: 'center' }}>
              <Chip at={tCheck + 0.2} color={C.cyan} size={24} out={dur - 0.3}>Live site · fund verifier</Chip>
              <Testnet at={tCheck + 0.35} out={dur - 0.3} />
            </div>
            <BrowserFrame
              src="rec/verify-02.png" imgW={2128} at={tCheck} out={dur - 0.3} width={L(1400, 980)} viewH={L(600, 600)}
              reveal={[tCheck + 0.3, tCheck + 1.4]} zoom={[tCheck + 0.9, dur, 1, 1.4]} scroll={[tCheck + 1.0, dur, 0, 160]} tilt={[-8, -2]}
              style={{ marginTop: L(-40, -20) }}
            />
          </>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const NodeBox: React.FC<{ x: number; y: number; w: number; at: number; title: string; sub?: string; accent?: string; out?: number; titleSize?: number }> = ({ x, y, w, at, title, sub, accent = C.blue, out, titleSize }) => {
  const p = useSpring(at, { damping: 15, stiffness: 140 });
  const env = useEnv(at, out, 0.25);
  const { L } = useLayout();
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, transform: `translate(-50%, -50%) scale(${0.75 + 0.25 * p})`, opacity: env }}>
      <Panel glow={accent} style={{ padding: '26px 22px', textAlign: 'center' }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: titleSize ?? L(44, 34), color: C.ink, lineHeight: 1.15 }}>{title}</div>
        {sub ? <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: L(28, 23), color: C.ink2, marginTop: 6 }}>{sub}</div> : null}
      </Panel>
    </div>
  );
};

export { Counter };
