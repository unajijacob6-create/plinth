import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, FONT } from '../theme';
import { S, at } from '../timeline';
import { BrowserFrame, Check, Chip, Edge, Eyebrow, Panel, Stamp, Testnet, Words, lerp, useEnv, useLayout, useSpring, useT } from '../components';
import { NodeBox } from './Hook';

const Bar: React.FC<{ label: string; v: number; color: string; ghost?: number; text: string; w: number }> = ({ label, v, color, ghost = 0, text, w }) => (
  <div style={{ marginBottom: 22 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT, fontWeight: 800, fontSize: 28, color: C.ink2, letterSpacing: '0.08em', marginBottom: 10 }}>
      <span>{label}</span>
      <span style={{ color: C.ink, letterSpacing: 0 }}>{text}</span>
    </div>
    <div style={{ height: 44, width: w, borderRadius: 8, background: C.bg, border: `1px solid ${C.line2}`, overflow: 'hidden', display: 'flex' }}>
      <div style={{ width: `${v * 100}%`, background: color }} />
      <div style={{ width: `${ghost * 100}%`, background: `repeating-linear-gradient(45deg, ${C.bad}, ${C.bad} 8px, ${C.bad}66 8px, ${C.bad}66 16px)` }} />
    </div>
  </div>
);

/** One bounce diagram, drawn for the old releases (bug) or for 0.3 (fixed). Times are local to the part. */
const Bounce: React.FC<{ fixed: boolean; t0: number; t1: number }> = ({ fixed, t0, t1 }) => {
  const t = useT();
  const { L } = useLayout();
  const env = useEnv(t0, t1, 0.3, 0.3);
  const att: [number, number] = L([330, 520], [250, 470]);
  const fund: [number, number] = L([1180, 520], [720, 470]);
  const fw = L(760, 540);
  const pa = t0 + 0.6; // particles leave
  const arrive = pa + 0.75; // first one reaches the fund
  const inside = lerp(t, arrive, arrive + 0.4) * (1 - lerp(t, arrive + 1.2, arrive + 1.6)); // sits in the balance ~2 blocks
  const ghost = fixed ? 0 : lerp(t, arrive + 0.3, arrive + 0.7) * 0.18;
  const shield = fixed ? lerp(t, t0 + 0.2, t0 + 0.6) : 0;
  return (
    <AbsoluteFill style={{ opacity: env }}>
      <NodeBox x={att[0]} y={att[1]} w={L(420, 340)} at={t0 + 0.1} title="Attacker" sub="sends tokens set to bounce back" accent={C.bad} />
      <Edge a={[att[0] + L(210, 170), att[1]]} b={[fund[0] - fw / 2 - (fixed ? 40 : 0), fund[1]]} at={t0 + 0.3} color={C.line2}
        particles={{ at: pa, n: 3, every: 0.22, travel: 0.75, bounce: true, color: C.bad, r: 11 }} />
      {fixed ? (
        <svg style={{ position: 'absolute', left: fund[0] - fw / 2 - 90, top: fund[1] - 200, overflow: 'visible' }} width={80} height={400}>
          <path d="M 60 10 Q 0 200 60 390" fill="none" stroke={C.ok} strokeWidth={6} strokeLinecap="round" strokeDasharray={420} strokeDashoffset={420 * (1 - shield)} />
          <path d="M 60 10 Q 0 200 60 390" fill="none" stroke={C.ok} strokeWidth={26} opacity={0.15 * shield} />
        </svg>
      ) : null}
      <div style={{ position: 'absolute', left: fund[0], top: fund[1], transform: `translate(-50%, -50%) scale(${0.85 + 0.15 * useSpring(t0)})` }}>
        <Panel glow={fixed ? C.ok : C.warn} style={{ width: fw, padding: '28px 34px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(44, 34), color: C.ink }}>Fund</div>
            {fixed ? <Chip at={t0 + 0.2} color={C.ok} size={26}>release 0.3</Chip> : <Chip at={t0 + 0.2} color={C.warn} size={26}>0.1 · 0.2 · known issue</Chip>}
          </div>
          {fixed ? (
            <>
              <Bar label="COUNTED" v={0.9} color={C.blue} text="90 pUSD" w={fw - 68} />
              <Bar label="REAL BALANCE" v={0.9} color={C.cyan} text="90 pUSD" w={fw - 68} />
            </>
          ) : (
            <>
              <Bar label="COUNTED" v={0.6} ghost={ghost} color={C.blue} text={ghost > 0.01 ? 'counted as money' : ''} w={fw - 68} />
              <Bar label="REAL BALANCE" v={0.6} ghost={inside * 0.18} color={C.cyan} text={inside > 0.05 ? 'bounce in flight' : ''} w={fw - 68} />
            </>
          )}
        </Panel>
      </div>
    </AbsoluteFill>
  );
};

/** 4. We found a bug in our own funds. */
export const Bug: React.FC = () => {
  const t = useT();
  const { L } = useLayout();
  const o = S.bug[0];
  const g = (x: number) => x - o;
  const tRel = g(at('Releases')) - 0.3;
  const tFix = g(at('0.3')) - 0.3;
  const tNoBal = g(at('balance'));
  const tRelay = g(at('Refunds')) - 0.3;
  const dur = S.bug[1] - o;
  const fund: [number, number] = L([1180, 520], [720, 470]);
  return (
    <AbsoluteFill>
      {/* A: the admission */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Words text={'We found a bug\nin our own funds.'} at={0.1} out={tRel - 0.35} size={L(124, 100)} align="center" hi={['bug']} />
      </AbsoluteFill>
      {/* B: releases 0.1 and 0.2 */}
      <AbsoluteFill style={{ opacity: useEnv(tRel, tFix - 0.1, 0.3, 0.3) }}>
        <div style={{ position: 'absolute', top: L(70, 80), left: L(120, 70) }}>
          <Words text="Releases 0.1 and 0.2 counted a bounce." at={tRel} size={L(72, 52)} hi={['bounce.']} maxWidth={L(1700, 940)} />
        </div>
      </AbsoluteFill>
      <Bounce fixed={false} t0={tRel} t1={tFix - 0.1} />
      {/* C: release 0.3 */}
      <AbsoluteFill style={{ opacity: useEnv(tFix, tRelay - 0.1, 0.3, 0.3) }}>
        <div style={{ position: 'absolute', top: L(70, 80), left: L(120, 70) }}>
          <Words text="0.3 counts only what is handed to it." at={tFix} size={L(72, 52)} grad={['handed']} maxWidth={L(1700, 940)} />
        </div>
        <Testnet at={tFix + 0.3} style={{ position: 'absolute', right: L(120, 70), top: L(176, 210) }} />
        <div style={{ position: 'absolute', left: L(fund[0] - 350, 120), top: L(760, 700), display: 'flex', flexDirection: L('row', 'column'), gap: L(36, 14), alignItems: L('center', 'flex-start') }}>
          <Check at={tNoBal - 0.3} text="no balance read anywhere" size={L(36, 28)} />
          <Check at={tNoBal + 0.2} text="fund kept 0" size={L(36, 28)} />
        </div>
        <div style={{ position: 'absolute', left: L(120, 120), top: L(240, 240), width: 640 }}>
          <Stamp at={tFix + 1.7} verdict="BOUNCED OFF" tx="HoB3ZQhf…" reason="holdings unchanged" color={C.ok} size={L(0.9, 0.7)} rot={-3} />
        </div>
      </AbsoluteFill>
      <Bounce fixed t0={tFix} t1={tRelay - 0.1} />
      {/* D: the refund relay */}
      <Relay t0={tRelay} dur={dur} />
    </AbsoluteFill>
  );
};

const Relay: React.FC<{ t0: number; dur: number }> = ({ t0, dur }) => {
  const { L } = useLayout();
  const env = useEnv(t0, dur - 0.35, 0.3, 0.3);
  const y = L(470, 480);
  const xs = L([300, 960, 1620], [200, 540, 880]);
  const nw = L(460, 310);
  return (
    <AbsoluteFill style={{ opacity: env }}>
      <div style={{ position: 'absolute', top: L(70, 80), left: L(120, 70) }}>
        <Words text="Refunds go through a relay." at={t0} size={L(72, 52)} grad={['relay.']} />
      </div>
      <Edge a={[xs[0] + nw / 2, y]} b={[xs[1] - nw / 2, y]} at={t0 + 0.4} color={C.cyan} particles={{ at: t0 + 0.8, n: 3, every: 0.3, travel: 0.7 }} />
      <Edge a={[xs[1] + nw / 2, y]} b={[xs[2] - nw / 2, y]} at={t0 + 0.9} color={C.cyan} particles={{ at: t0 + 1.5, n: 3, every: 0.3, travel: 0.7 }} />
      <Edge a={[xs[1], y + 100]} b={[xs[1] + L(260, 160), y + L(250, 230)]} at={t0 + 1.4} color={C.bad} dashed />
      <NodeBox x={xs[0]} y={y} w={nw} at={t0 + 0.2} title="1Click refund" sub="plain transfer" accent={C.cyan} titleSize={L(42, 30)} />
      <NodeBox x={xs[1]} y={y} w={nw} at={t0 + 0.4} title="Refund relay" sub="0 keys · same code" accent={C.ok} titleSize={L(42, 30)} />
      <NodeBox x={xs[2]} y={y} w={nw} at={t0 + 0.7} title="This fund" sub="counts it on arrival" accent={C.blue} titleSize={L(42, 30)} />
      <div style={{ position: 'absolute', left: xs[1] + L(270, 60), top: y + L(230, 260) }}>
        <Chip at={t0 + 1.7} color={C.bad} size={30}>✕ anyone else</Chip>
      </div>
      <div style={{ position: 'absolute', left: L(120, 70), top: L(760, 780), display: 'flex', gap: 20, alignItems: 'center' }}>
        <Stamp at={t0 + 2.1} verdict="REFUNDED" tx="H1QRGveX…" reason="9.9955 pUSD back to the fund" color={C.ok} size={L(0.9, 0.62)} rot={-2} />
        <Testnet at={t0 + 2.3} />
      </div>
    </AbsoluteFill>
  );
};

/** 5. No manager: anyone presses rebalance, a strategy runs in an OutLayer enclave, the contract checks. */
export const Auto: React.FC = () => {
  const t = useT();
  const { L, sq } = useLayout();
  const o = S.auto[0];
  const g = (x: number) => x - o;
  const tAny = g(at('Anyone', 1)) - 0.2;
  const tReb = g(at('rebalance'));
  const tEnc = g(at('OutLayer')) - 0.2;
  const tTrust = g(at('enclave', 1)) - 0.2;
  const tChecks = g(at('checks'));
  const dur = S.auto[1] - o;
  const nw = L(460, 330);
  const P: [number, number][] = L([[300, 470], [960, 470], [1620, 470]], [[230, 330], [790, 330], [540, 590]]);
  const press = lerp(t, tReb - 0.15, tReb) * (1 - lerp(t, tReb + 0.05, tReb + 0.25));
  return (
    <AbsoluteFill>
      {/* A: launch form footage, "No manager: run a strategy" */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: useEnv(0, tAny - 0.1, 0.3, 0.3) }}>
        <div style={{ position: 'absolute', top: L(64, 90), left: L(120, 70), zIndex: 2 }}>
          <Words text="Or skip the manager." at={0.05} size={L(76, 60)} grad={['manager.']} />
        </div>
        <BrowserFrame src="rec/launch.png" imgW={2128} at={0.1} out={tAny - 0.1} width={L(1300, 960)} viewH={L(600, 600)} scroll={[0.1, tAny, 2430, 2600]} zoom={[0.1, tAny, 1.75, 1.9]} tilt={[-10, -4]}
          url="unajijacob6-create.github.io/plinth/#launch" style={{ marginTop: L(180, 200) }} />
      </AbsoluteFill>
      {/* B: the manager-less flow */}
      <AbsoluteFill style={{ opacity: useEnv(tAny, dur - 0.35, 0.3, 0.3) }}>
        <Testnet at={tAny + 0.2} style={{ position: 'absolute', right: L(120, 70), top: L(80, 90) }} />
        <Eyebrow text="No manager · auto-mwc5tnnh" at={tAny} style={{ position: 'absolute', top: L(90, 100), left: L(120, 70) }} size={L(30, 22)} />
        <Edge a={[P[0][0] + nw / 2, P[0][1]]} b={[P[1][0] - nw / 2 - 20, P[1][1]]} at={tReb} color={C.cyan} particles={{ at: tReb + 0.2, n: 2, every: 0.3, travel: 0.6 }} label="rebalance()" labelAt={tReb} />
        <Edge a={L([P[1][0] + nw / 2 + 20, P[1][1]], [P[1][0], P[1][1] + 110])} b={L([P[2][0] - nw / 2, P[2][1]], [P[2][0] + nw / 2 - 20, P[2][1] - 30])} at={tEnc + 1.6} color={C.cyan} particles={{ at: tEnc + 1.9, n: 1, travel: 0.7, r: 12 }} label="proposal" labelAt={tEnc + 1.8} />
        {/* anyone, with a button */}
        <div style={{ position: 'absolute', left: P[0][0], top: P[0][1], transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * useSpring(tAny)})`, opacity: useEnv(tAny) }}>
          <Panel glow={C.blue} style={{ width: nw, padding: '24px', textAlign: 'center' }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(44, 32), color: C.ink }}>Anyone</div>
            <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 26, color: C.ink2, margin: '4px 0 16px' }}>here: bob.plinthfund.testnet</div>
            <div style={{ display: 'inline-block', fontFamily: FONT, fontWeight: 800, fontSize: 26, color: '#fff', padding: '12px 26px', borderRadius: 12, background: `linear-gradient(180deg, color-mix(in srgb, ${C.blue} 90%, white), ${C.blue})`, transform: `scale(${1 - press * 0.08})`, boxShadow: `0 8px 30px -10px ${C.blue}` }}>Rebalance</div>
          </Panel>
        </div>
        {/* OutLayer enclave: trusted, not proven */}
        <div style={{ position: 'absolute', left: P[1][0], top: P[1][1], transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * useSpring(tEnc)})`, opacity: useEnv(tEnc) }}>
          <div style={{ width: nw + 40, padding: '26px 24px', borderRadius: 22, border: `3px dashed ${t > tTrust ? C.warn : C.cyan}`, background: `${C.panel}ee`, textAlign: 'center' }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(42, 30), color: C.ink }}>OutLayer enclave</div>
            <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 26, color: C.ink2, marginTop: 4 }}>strategy program</div>
            <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 24, color: C.ink3, marginTop: 4 }}>sha256 d7bf6ba8…</div>
            {/* the program "running" */}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 14 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ width: 14, height: 14 + 16 * Math.abs(Math.sin(t * 6 + i)) * lerp(t, tEnc + 0.3, tEnc + 0.5) * (1 - lerp(t, tEnc + 1.8, tEnc + 2.0)), borderRadius: 4, background: C.cyan, opacity: 0.8 }} />)}
            </div>
          </div>
          <div style={{ position: 'absolute', left: '50%', top: -66, transform: 'translateX(-50%)' }}>
            <Chip at={tTrust} color={C.warn} size={L(28, 21)}>trusted · not proven on chain</Chip>
          </div>
        </div>
        {/* the contract still checks */}
        <div style={{ position: 'absolute', left: P[2][0], top: P[2][1], transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * useSpring(tEnc + 1.4)})`, opacity: useEnv(tEnc + 1.4) }}>
          <Panel glow={C.ok} style={{ width: nw, padding: '24px', textAlign: 'center' }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: L(44, 32), color: C.ink }}>Fund contract</div>
            <div style={{ fontFamily: FONT, fontWeight: 500, fontSize: 26, color: C.ink2, marginTop: 4 }}>same checks as any proposal</div>
          </Panel>
          <div style={{ position: 'absolute', left: '50%', top: -66, transform: 'translateX(-50%)' }}>
            <Chip at={tChecks} color={C.ok} size={L(28, 21)}>checked on chain</Chip>
          </div>
        </div>
        {/* results */}
        <div style={{ position: 'absolute', left: L(120, 70), right: L(120, 70), top: L(700, 720), display: 'flex', gap: L(40, 14), flexDirection: L('row', 'column'), alignItems: L('center', 'flex-start') }}>
          <Stamp at={tEnc + 2.6} verdict="SETTLED" tx="9uTU9UCk…" reason="14.25 pUSD → 3.7886 wNEAR · cost 79 bps" color={C.ok} size={L(0.85, 0.56)} rot={-2} maxWidth={L(800, 900)} />
          <Stamp at={tTrust + 1.2} verdict="OPERATOR REFUSED" tx="BtvZgB13…" reason="“this fund has no manager”" color={C.bad} size={L(0.85, 0.56)} rot={2} maxWidth={L(800, 900)} />
        </div>
        {sq ? null : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
