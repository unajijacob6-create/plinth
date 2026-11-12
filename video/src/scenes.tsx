import React from 'react';
import { AbsoluteFill, Easing } from 'remotion';
import { C, F } from './theme';
import { S, at } from './timeline';
import { Counter, Cursor, Display, Glass, Label, Layer, Line, Logo, Pill, Proof, Ring, Shot, Testnet, lerp, useEnv, useLayout, useSpring, useT } from './components';

// Element boxes are in pixels of the 2x screenshots in public/rec/ (tools/record.cjs writes boxes.json
// for the launch form, the card and the verifier input; the carousel boxes were measured on the shots).
const local = (k: keyof typeof S) => (x: number) => x - S[k][0];

// ================================================================ 1. the problem
const KeyIcon: React.FC<{ size: number; color?: string }> = ({ size, color = '#f5c451' }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <circle cx="14" cy="24" r="9" fill="none" stroke={color} strokeWidth="4.5" />
    <path d="M23 24 H45 M38 24 V33 M44 24 V31" stroke={color} strokeWidth="4.5" strokeLinecap="round" fill="none" />
  </svg>
);
const Lock: React.FC<{ size: number; open: number }> = ({ size, open }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <path d={`M14 22 V14 a10 10 0 0 1 20 0 V${22 - open * 8}`} fill="none" stroke={C.on} strokeWidth="4" strokeLinecap="round" transform={`translate(${open * 6} ${-open * 3})`} />
    <rect x="8" y="22" width="32" height="22" rx="5" fill={C.on} />
    <circle cx="24" cy="32" r="3" fill={C.night} />
  </svg>
);
const Person: React.FC<{ size: number; color?: string }> = ({ size, color = C.on }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <circle cx="24" cy="17" r="8" fill="none" stroke={color} strokeWidth="3.5" />
    <path d="M9 42 c2-9 8-13 15-13 s13 4 15 13" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" />
  </svg>
);
const Toast: React.FC<{ at: number; text: string; sub: string }> = ({ at: a, text, sub }) => {
  const p = useSpring(a, { damping: 14, stiffness: 180 });
  return (
    <div style={{ opacity: Math.min(1, p * 1.4), transform: `translateX(${(1 - p) * 60}px) scale(${0.9 + 0.1 * p})` }}>
      <Glass style={{ padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 16, width: 420, background: 'rgba(255,107,97,.10)', borderColor: 'rgba(255,107,97,.45)' }}>
        <span style={{ width: 14, height: 14, borderRadius: 9, background: C.bad, boxShadow: `0 0 14px ${C.bad}` }} />
        <div>
          <div style={{ fontFamily: F.display, fontWeight: 650, fontSize: 30, color: C.on, letterSpacing: '-0.02em' }}>{text}</div>
          <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: 20, color: C.on2 }}>{sub}</div>
        </div>
      </Glass>
    </div>
  );
};

export const Hook: React.FC = () => {
  const t = useT();
  const { L } = useLayout();
  const tKey = at('someone') - 0.2;
  const tChange = at('change', 0);
  const tPause = at('pause');
  const tStop = at('stop');
  const tTrust = at('You') - 0.15;
  // the key travels from the person to the lock, then turns
  const person = L([470, 660], [180, 450]);
  const lock = L([1200, 540], [700, 380]);
  const u = lerp(t, tKey + 0.4, tChange - 0.15, 0, 1, Easing.inOut(Easing.cubic));
  const turn = lerp(t, tChange - 0.2, tChange + 0.25);
  const kx = person[0] + 70 + (lock[0] + L(150, 120) - person[0] - 70) * u;
  const ky = person[1] - 10 + (lock[1] - 80 - person[1] + 10) * u - Math.sin(u * Math.PI) * 120;
  const dim = lerp(t, tTrust, tTrust + 0.6);
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: L(130, 70), top: L(110, 90) }}>
        <Display text="Someone holds *the key.*" at={at('someone') - 0.1} out={tTrust - 0.35} size={L(96, 76)} />
        <div style={{ position: 'absolute', top: 0 }}>
          <Display text="You have to *trust them.*" at={tTrust} size={L(96, 76)} />
        </div>
      </div>
      {/* the person who holds the key */}
      <div style={{ position: 'absolute', left: person[0], top: person[1], transform: `translate(-50%,-50%) scale(${0.8 + 0.2 * useSpring(0.6)})`, opacity: useEnv(0.6), textAlign: 'center' }}>
        <div style={{ width: 150, height: 150, borderRadius: 99, background: C.glass, border: `1px solid ${C.glassLine}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Person size={90} />
        </div>
        <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 26, color: C.on2, marginTop: 14 }}>Whoever runs it</div>
      </div>
      {/* the fund */}
      <div style={{ position: 'absolute', left: lock[0] - L(330, 260), top: lock[1] - 90, opacity: useEnv(0.3), transform: `translateY(${(1 - useSpring(0.3)) * 40}px)` }}>
        <Glass style={{ width: L(560, 460), padding: '34px 36px', opacity: 1 - dim * 0.35 }}>
          <div style={{ fontFamily: F.display, fontWeight: 650, fontSize: 40, color: C.on, letterSpacing: '-0.02em' }}>A shared fund</div>
          <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: 24, color: C.on2, marginTop: 4 }}>Everyone's money, in one pool</div>
          {[0.82, 0.55, 0.68].map((w, i) => (
            <div key={i} style={{ marginTop: i ? 16 : 30, height: 22, borderRadius: 8, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
              <div style={{ width: `${w * 100 * lerp(t, 0.6 + i * 0.15, 1.4 + i * 0.15)}%`, height: '100%', background: i === 0 ? C.blue : i === 1 ? C.cyan : '#6f8fd8', opacity: 0.9 }} />
            </div>
          ))}
        </Glass>
        <div style={{ position: 'absolute', right: -40, top: -50 }}>
          <div style={{ width: 120, height: 120, borderRadius: 30, background: C.night2, border: `1px solid ${C.glassLine}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 50px -10px ${C.glow}` }}>
            <Lock size={70} open={turn} />
          </div>
        </div>
      </div>
      {/* the key */}
      <div style={{ position: 'absolute', left: kx, top: ky, transform: `translate(-50%,-50%) rotate(${-20 + turn * 90}deg)`, opacity: lerp(t, tKey + 0.2, tKey + 0.5) }}>
        <KeyIcon size={L(110, 90)} />
      </div>
      {/* what a key can do */}
      <div style={{ position: 'absolute', left: L(1460, 90), top: L(450, 620), display: 'flex', flexDirection: L('column', 'row'), gap: 18, transform: L('none', 'scale(0.62)'), transformOrigin: 'left top' }}>
        <Toast at={tChange + 0.15} text="Rules changed" sub="by whoever holds the key" />
        <Toast at={tPause} text="Fund paused" sub="nobody can trade" />
        <Toast at={tStop} text="Withdrawals stopped" sub="you can't take money out" />
      </div>
    </AbsoluteFill>
  );
};

// ================================================================ 2. this is Plinth
export const Title: React.FC = () => {
  const { L } = useLayout();
  const g = local('title');
  const tThis = g(at('This')) - 0.1;
  const tPlinth = g(at('Plinth')) - 0.1;
  const tNear = g(at('NEAR')) - 0.3;
  const tLine = g(at('A')) - 0.1;
  const dur = S.title[1] - S.title[0];
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: L(130, 70), top: L(270, 120), width: L(800, 940) }}>
        <Label text="This is" at={tThis} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: 26 }}>
          <Logo size={L(150, 110)} at={tPlinth} />
          <Display text="Plinth" at={tPlinth + 0.1} size={L(170, 130)} />
        </div>
        <div style={{ marginTop: 22 }}>
          <Pill at={tNear} dot={C.cyan} size={26}>Built on NEAR</Pill>
        </div>
        <div style={{ marginTop: L(44, 26) }}>
          <Display text={L('A shared fund that\n*nobody can change.*', 'A shared fund that *nobody can change.*')} at={tLine} size={L(66, 50)} />
        </div>
      </div>
      <Shot
        layers={[{ src: 'rec/home.png', at: 0, keys: [[0.6, 0, 1], [dur, 120, 1.18]] }]} imgW={2560} width={L(880, 820)} viewH={L(550, 270)} at={0.5} dur={dur}
        style={{ position: 'absolute', left: L(950, 130), top: L(250, 610) }} tilt={[-9, -3]}
      />
    </AbsoluteFill>
  );
};

// ================================================================ steps: one layout for every step
const StepScene: React.FC<{
  k: keyof typeof S; n: string; label: string; title: string; line: string; tLine: number; children: React.ReactNode; proof?: React.ReactNode; titleSize?: number;
}> = ({ k, n, label, title, line, tLine, children, proof, titleSize }) => {
  const { L } = useLayout();
  const g = local(k);
  const dur = S[k][1] - S[k][0];
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: L(130, 70), top: L(210, 120), width: L(700, 940) }}>
        <Label text={`${n} · ${label}`} at={0.15} color={C.blueSoft} />
        <div style={{ marginTop: L(24, 16) }}>
          <Display text={title} at={0.3} size={titleSize ?? L(92, 66)} />
        </div>
        <div style={{ marginTop: L(36, 22) }}>
          <Line text={line} at={g(tLine)} size={L(32, 27)} maxWidth={L(660, 940)} />
        </div>
        <div style={{ marginTop: 40, position: 'relative' }}>{proof}</div>
      </div>
      <div style={{ position: 'absolute', left: L(900, 70), top: L(150, 450) }}>{children}</div>
      <div style={{ position: 'absolute', opacity: useEnv(0, dur - 0.4) }} />
    </AbsoluteFill>
  );
};

// 01 · Set the rules once: the launch form, stepped through to Review (no wallet, nothing sent)
export const Step1: React.FC = () => {
  const { L, sq } = useLayout();
  const g = local('s1');
  const t0 = g(at('Pick')) - 1.0;
  // each step: slide in, scroll so its Next button sits at the same place, tap Next
  const shotAt = [0, t0 + 0.9, t0 + 2.1, t0 + 3.3, t0 + 4.5];
  const target = [888, 49, 223, 802, 1277];
  const layers: Layer[] = shotAt.map((a, i) => ({
    src: `rec/launch-${i + 1}.png`, at: a,
    keys: i === 4 ? [[a, 0, 1], [a + 0.6, 0, 1], [a + 2.6, target[i], 1]] : [[a, 0, 1], [a + 0.25, 0, 1], [a + 0.75, target[i], 1]],
  }));
  const nx = 1653, ny = 1202;
  const cursor: Cursor = [[0.9, 900, 500], [shotAt[1] - 0.45, nx, ny]];
  for (let i = 1; i < 5; i++) {
    cursor.push([shotAt[i] - 0.12, nx, ny, true]);
    if (i < 4) cursor.push([shotAt[i + 1] - 0.45, nx, ny]);
  }
  cursor.push([shotAt[4] + 1.6, 1200, 900]);
  const rings: Ring[] = [{ at: shotAt[1] + 0.5, out: shotAt[2] - 0.2, x: 98, y: 583, w: 707, h: 96, layer: 1 }];
  return (
    <StepScene
      k="s1" n="01" label="Set the rules once" title={'Set the rules\n*once.*'} tLine={at('Pick')}
      line="Pick the tokens and the limits. Once it's live, nobody can change them, not even you."
      proof={
        <div style={{ opacity: useEnv(shotAt[4] + 1.2) }}>
          <Pill at={shotAt[4] + 1.2} size={22} dot={C.on3}>Review only: no wallet, nothing sent</Pill>
        </div>
      }
    >
      <Shot layers={layers} imgW={1760} width={L(900, 940)} viewH={L(640, 420)} at={0.2} dur={S.s1[1] - S.s1[0]} cursor={cursor} rings={rings} url="unajijacob6-create.github.io/plinth/app/launch/" tilt={sq ? [0, 0] : [-6, -2]} />
    </StepScene>
  );
};

// 02 · Put tokens in: a live fund card
export const Step2: React.FC = () => {
  const { L, sq } = useLayout();
  const g = local('s2');
  const tShares = g(at('shares'));
  const rings: Ring[] = [
    { at: 1.2, out: tShares - 0.4, x: 99, y: 672, w: 376, h: 256, layer: 0 },
    { at: tShares - 0.2, out: 5.6, x: 503, y: 672, w: 376, h: 256, layer: 0 },
  ];
  return (
    <StepScene
      k="s2" n="02" label="Put tokens in" title={'Put tokens\n*in.*'} tLine={at('Then')}
      line="People join by putting tokens in, and get shares for what they add."
      proof={!sq ? <Proof at={tShares + 0.2} state="ok" head="Alice 60 pUSD + Bob 40 pUSD in" body="100,000,000 shares: one for each smallest unit of test dollar they added." tx="B4YnUB8B…" width={640} size={0.9} /> : null}
    >
      <Shot layers={[{ src: 'rec/card.png', at: 0, keys: [[0.4, 0, 1], [2.2, 470, 1.08]] }]} imgW={1568} width={L(900, 940)} viewH={L(640, 420)} at={0.2} dur={6} rings={rings} url="unajijacob6-create.github.io/plinth/app/" tilt={sq ? [0, 0] : [-6, -2]} />
      {sq ? <Proof at={tShares + 0.2} state="ok" head="Alice 60 + Bob 40 pUSD in" body="100,000,000 shares issued" tx="B4YnUB8B…" width={560} size={0.75} style={{ position: 'absolute', left: 340, top: 230 }} /> : null}
    </StepScene>
  );
};

// 03 · The manager can only suggest: the AI-manager cases on /how/, and the real refusal
export const Step3: React.FC = () => {
  const { L, sq } = useLayout();
  const g = local('s3');
  const tElse = g(at('Anything')) - 0.1;
  const swap = g(at('propose')) + 0.2;
  const layers: Layer[] = [
    { src: 'rec/agent-1.png', at: 0, keys: [[0, 0, 1.2]] },
    { src: 'rec/agent-3.png', at: swap, keys: [[0, 0, 1.2]] },
  ];
  const rings: Ring[] = [
    { at: 1.4, out: swap - 0.3, x: 101, y: 372, w: 1056, h: 407, layer: 0 },
    { at: swap + 0.6, out: tElse - 0.2, x: 96, y: 440, w: 1061, h: 333, color: C.bad, layer: 1 },
    { at: tElse, out: 8.5, x: 98, y: 890, w: 1300, h: 56, color: C.bad, layer: 1 },
  ];
  const proof = (
    <Proof
      at={tElse + 0.3} state="bad" head="Refused on chain" tx="CmxW4CcE…" width={L(660, 600)} size={L(0.9, 0.72)}
      body={<>A hijacked manager's trade would have paid an attacker. The contract's reason: <i style={{ color: C.on }}>“quote must deliver to this fund and refund to its relay on NEAR”</i></>}
      style={sq ? { position: 'absolute', left: 300, top: 160 } : undefined}
    />
  );
  return (
    <StepScene k="s3" n="03" label="The manager can only suggest" title={'The manager can\nonly *suggest.*'} titleSize={L(84, 62)} tLine={at('A', 1)} line="A manager, a person or an AI, can only propose trades the rules allow. Anything else is refused." proof={sq ? null : proof}>
      <Shot layers={layers} imgW={2144} width={L(900, 940)} viewH={L(600, 420)} at={0.2} dur={8} rings={rings} url="unajijacob6-create.github.io/plinth/how/#agent" tilt={sq ? [0, 0] : [-6, -2]} />
      {sq ? proof : null}
    </StepScene>
  );
};

// 04 · Leave any time: the card's "Your part", then Bob's recorded exit
export const Step4: React.FC = () => {
  const { L, sq } = useLayout();
  const tRes = 2.9;
  const proof = (
    <Proof
      at={tRes} state="ok" head="Bob left with 40% of each token" tx="D1a37KJz…" width={L(660, 600)} size={L(0.95, 0.75)}
      style={sq ? { position: 'absolute', left: 300, top: 150 } : undefined}
      body={
        <div style={{ display: 'flex', gap: 30, marginTop: 6, alignItems: 'baseline' }}>
          <span style={{ fontFamily: F.display, fontWeight: 650, fontSize: L(50, 40), color: C.on, letterSpacing: '-0.03em' }}><Counter to={35.9982} at={tRes + 0.3} decimals={4} /> <span style={{ fontSize: 24, color: C.on2 }}>pUSD</span></span>
          <span style={{ fontFamily: F.display, fontWeight: 650, fontSize: L(50, 40), color: C.on, letterSpacing: '-0.03em' }}><Counter to={0.0084} at={tRes + 0.3} decimals={4} /> <span style={{ fontSize: 24, color: C.on2 }}>wNEAR</span></span>
        </div>
      }
    />
  );
  return (
    <StepScene k="s4" n="04" label="Leave any time" title={'Leave\n*any time.*'} tLine={at('And', 0)} line="Anyone can take their share of every token out, at any time." proof={sq ? null : (<>{proof}<div style={{ fontFamily: F.body, fontWeight: 600, fontSize: 21, color: C.on3, marginTop: 14, opacity: useEnv(tRes + 0.6) }}>He held 40,000,000 of 100,000,000 shares.</div></>)}>
      <Shot
        layers={[{ src: 'rec/card.png', at: 0, keys: [[0.2, 420, 1.0], [1.4, 470, 1.12]] }]} imgW={1568} width={L(900, 940)} viewH={L(640, 420)} at={0.15} dur={7}
        rings={[{ at: 1.2, out: 6.4, x: 947, y: 599, w: 523, h: 267, layer: 0 }]}
        cursor={[[0.5, 700, 900], [1.6, 1390, 330], [1.75, 1390, 330, true], [2.6, 1390, 330]]}
        url="unajijacob6-create.github.io/plinth/app/" tilt={sq ? [0, 0] : [-6, -2]}
      />
      {sq ? proof : null}
    </StepScene>
  );
};

// ================================================================ behind the scenes, on NEAR
export const Behind: React.FC = () => {
  const t = useT();
  const { L, sq } = useLayout();
  const g = local('behind');
  const tProg = g(at('program')) - 0.3;
  const tChain = g(at('public')) - 0.2;
  const tNoKey = g(at('no', 0)) - 0.2;
  const tCheck = g(at('Anyone')) - 0.4;
  const dur = S.behind[1] - S.behind[0];
  const shift = lerp(t, tCheck - 0.2, tCheck + 0.6);
  const cx = 960;
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: L(150, 120), display: 'flex', justifyContent: 'center', opacity: 1 - shift }}>
        <Display text="Behind the scenes, *on NEAR.*" at={0.3} size={L(80, 58)} align="center" />
      </div>
      <div style={{ position: 'absolute', left: L(130, 70), top: L(150, 110), opacity: shift }}>
        <Label text="Check it yourself, in your browser" at={tCheck} color={C.blueSoft} />
      </div>
      {/* the diagram: people → the fund program (no key) → on a public chain */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transform: L(`translateX(${-470 * shift}px) scale(${1 - 0.22 * shift})`, `translate(0px, 150px) scale(0.5625)`), transformOrigin: L('50% 55%', '0 0'), opacity: L(1, 1 - shift) }}>
        <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <path d={`M ${cx - 330} 560 L ${cx - 200} 560`} stroke={C.blue} strokeWidth={4} strokeDasharray="160" strokeDashoffset={160 * (1 - lerp(t, tProg, tProg + 0.6))} />
          {[0, 1, 2].map((i) => {
            const u = ((t - tProg - 0.4 - i * 0.35) % 1.4) / 0.9;
            if (t < tProg + 0.4 || u < 0 || u > 1) return null;
            return <circle key={i} cx={cx - 330 + 130 * u} cy={560} r={8} fill={C.cyan} />;
          })}
          <path d={`M ${cx} 455 L ${cx} 390`} stroke={C.glassLine} strokeWidth={3} strokeDasharray="6 8" opacity={lerp(t, tNoKey, tNoKey + 0.4)} />
          {Array.from({ length: 9 }, (_, i) => {
            const a = lerp(t, tChain + i * 0.06, tChain + 0.3 + i * 0.06);
            return <rect key={i} x={cx - 300 + i * 68} y={760} width={52} height={52} rx={10} fill="none" stroke={i === 4 ? C.cyan : C.glassLine} strokeWidth={3} opacity={a} />;
          })}
          {Array.from({ length: 8 }, (_, i) => <line key={i} x1={cx - 248 + i * 68} y1={786} x2={cx - 232 + i * 68} y2={786} stroke={C.glassLine} strokeWidth={3} opacity={lerp(t, tChain + 0.3, tChain + 0.6)} />)}
        </svg>
        <div style={{ position: 'absolute', left: cx - 470, top: 560, transform: 'translate(-50%,-50%)', textAlign: 'center', opacity: useEnv(0.8) }}>
          <div style={{ display: 'flex', gap: -10 }}>{[0, 1, 2].map((i) => <div key={i} style={{ marginLeft: i ? -26 : 0 }}><div style={{ width: 92, height: 92, borderRadius: 99, background: C.night2, border: `1px solid ${C.glassLine}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Person size={56} /></div></div>)}</div>
          <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: 26, color: C.on2, marginTop: 12 }}>People who join</div>
        </div>
        <div style={{ position: 'absolute', left: cx, top: 560, transform: `translate(-50%,-50%) scale(${0.85 + 0.15 * useSpring(tProg - 0.3)})`, opacity: useEnv(tProg - 0.3) }}>
          <Glass glow={C.glow} style={{ width: 400, padding: '30px 32px', textAlign: 'left' }}>
            <div style={{ fontFamily: F.display, fontWeight: 650, fontSize: 38, color: C.on, letterSpacing: '-0.02em' }}>The fund</div>
            <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: 24, color: C.on2, marginTop: 4 }}>a small program on NEAR</div>
            {['Rules, written once', 'Checks every trade', 'Pays out shares'].map((x, i) => (
              <div key={x} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: i ? 10 : 22, fontFamily: F.body, fontWeight: 600, fontSize: 24, color: C.on, opacity: lerp(t, tProg + 0.5 + i * 0.25, tProg + 0.8 + i * 0.25) }}>
                <span style={{ width: 8, height: 8, borderRadius: 9, background: C.cyan }} />{x}
              </div>
            ))}
          </Glass>
        </div>
        {/* the empty key slot */}
        <div style={{ position: 'absolute', left: cx, top: 330, transform: `translate(-50%,-50%) scale(${0.8 + 0.2 * useSpring(tNoKey)})`, opacity: useEnv(tNoKey) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 26px', borderRadius: 999, border: `2px dashed ${C.glassLine}`, background: 'rgba(3,8,23,.6)' }}>
            <div style={{ position: 'relative', opacity: 0.55 }}>
              <KeyIcon size={44} color={C.on3} />
              <div style={{ position: 'absolute', left: -4, top: 20, width: 54, height: 4, background: C.bad, transform: `rotate(-30deg) scaleX(${lerp(t, tNoKey + 0.3, tNoKey + 0.6)})`, borderRadius: 2 }} />
            </div>
            <span style={{ fontFamily: F.display, fontWeight: 650, fontSize: 32, color: C.on }}>No key at all</span>
          </div>
        </div>
        <div style={{ position: 'absolute', left: cx, top: 850, transform: 'translateX(-50%)', fontFamily: F.body, fontWeight: 700, fontSize: 24, color: C.on2, opacity: lerp(t, tChain + 0.4, tChain + 0.8), whiteSpace: 'nowrap' }}>
          NEAR: a public blockchain
        </div>
      </div>
      {/* the verifier, live */}
      <Shot
        layers={[{ src: 'rec/verify-0.png', at: tCheck, keys: [[0, 0, 1]] }, { src: 'rec/verify-final.png', at: tCheck + 0.95, keys: [[tCheck + 1.0, 0, 1], [dur, 320, 1.12]] }]}
        imgW={2144} width={L(980, 940)} viewH={L(620, 560)} at={tCheck - 0.1} dur={4}
        cursor={[[tCheck + 0.1, 1500, 500], [tCheck + 0.7, 1970, 226], [tCheck + 0.8, 1970, 226, true], [tCheck + 1.2, 1700, 600]]}
        rings={[
          { at: tCheck + 1.4, out: dur, x: 40, y: 440, w: 2050, h: 110, color: C.ok, layer: 1 },
          { at: tCheck + 1.9, out: dur, x: 40, y: 610, w: 2050, h: 150, color: C.ok, layer: 1 },
        ]}
        url="unajijacob6-create.github.io/plinth/verify/" tilt={sq ? [0, 0] : [-6, -3]}
        style={{ position: 'absolute', left: L(850, 70), top: L(180, 260) }}
      />
      <div style={{ position: 'absolute', left: L(130, 70), top: L(210, 170), opacity: shift }}>
        <Testnet at={tCheck + 1.4} text="Live check on NEAR testnet" />
      </div>
    </AbsoluteFill>
  );
};

// ================================================================ the best part
export const Best: React.FC = () => {
  const t = useT();
  const { L, sq } = useLayout();
  const g = local('best');
  const tTried = g(at('We')) - 0.2;
  const tAlong = g(at('One'));
  const tOther = g(at('other'));
  const tNothing = g(at('nothing'));
  const tHij = g(at('hijacked')) - 0.4;
  const tRef = g(at('refused', 2)) - 0.2;
  const dur = S.best[1] - S.best[0];
  const layers: Layer[] = [
    { src: 'rec/quorum-1.png', at: 0, keys: [[0, 0, 1.08]] },
    { src: 'rec/agent-3.png', at: tHij, keys: [[0, 0, 1.2]] },
  ];
  const rings: Ring[] = [
    { at: tAlong - 0.1, out: tNothing - 0.3, x: 1089, y: 372, w: 959, h: 644, color: C.bad, layer: 0 },
    { at: tOther, out: tHij - 0.3, x: 96, y: 372, w: 959, h: 644, color: C.ok, layer: 0 },
    { at: tNothing, out: tHij - 0.3, x: 98, y: 1110, w: 1500, h: 70, color: C.ok, layer: 0 },
    { at: tRef, out: dur, x: 98, y: 890, w: 1300, h: 56, color: C.bad, layer: 1 },
  ];
  const intro = 1 - lerp(t, tTried - 0.5, tTried - 0.1);
  return (
    <AbsoluteFill>
      {/* "The best part" card */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: intro }}>
        <Display text="The *best* part" at={0.15} size={L(150, 110)} align="center" />
      </AbsoluteFill>
      {t > tTried - 0.6 ? (
        <AbsoluteFill style={{ opacity: lerp(t, tTried - 0.4, tTried) }}>
          <div style={{ position: 'absolute', left: L(130, 70), top: L(200, 110), width: L(700, 940) }}>
            <Label text="We tried to trick it" at={tTried - 0.2} color={C.blueSoft} />
            <div style={{ marginTop: L(24, 14) }}>
              <Display text={L('Two AIs got\nthe same *trap.*', 'Two AIs got the same *trap.*')} at={tTried} size={L(88, 62)} />
            </div>
            <div style={{ marginTop: L(34, 20) }}>
              <Line text="A hidden instruction: send the fund's dollars to an attacker." at={tTried + 0.8} size={L(32, 27)} maxWidth={L(660, 940)} />
            </div>
            {!sq ? (
              <div style={{ marginTop: 40, position: 'relative', height: 300 }}>
                <Proof at={tNothing - 0.1} out={tHij - 0.2} state="ok" head="Nothing was sent" width={660} size={0.88}
                  body={<>Gemini 2.5 Flash went along: sell the whole 48.59757 pUSD holding, paid to attacker-wallet.testnet. DeepSeek V4.1 Flash refused. Both must agree, so nothing was proposed.</>} />
                <div style={{ position: 'absolute', top: 0 }}>
                  <Proof at={tRef} state="bad" head="A hijacked manager: refused on chain" tx="CmxW4CcE…" width={660} size={0.88} body="Its trade would have paid someone other than the fund." />
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ position: 'absolute', left: L(900, 70), top: L(170, 450) }}>
            <Shot layers={layers} imgW={2144} width={L(900, 940)} viewH={L(600, 420)} at={tTried + 0.1} dur={dur - tTried} rings={rings} url="unajijacob6-create.github.io/plinth/how/#quorum" tilt={sq ? [0, 0] : [-6, -2]} />
            {sq ? (
              <>
                <Proof at={tNothing - 0.1} out={tHij - 0.2} state="ok" head="Nothing was sent" width={560} size={0.72} body="One AI went along, one refused. Both must agree." style={{ position: 'absolute', left: 340, top: 190 }} />
                <Proof at={tRef} state="bad" head="Hijacked manager: refused" tx="CmxW4CcE…" width={560} size={0.72} style={{ position: 'absolute', left: 340, top: 230 }} />
              </>
            ) : null}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

// ================================================================ close
export const Close: React.FC = () => {
  const { L } = useLayout();
  const g = local('close');
  const tP = g(at('Plinth', 1)) - 0.15;
  const t1 = g(at('No', 0)) - 0.1;
  const t2 = g(at('No', 1)) - 0.1;
  const t3 = g(at('Your')) - 0.1;
  const tEnd = g(at('time', 1)) + 0.3;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: L(22, 18), marginTop: L(-60, -80) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
          <Logo size={L(130, 110)} at={tP} />
          <Display text="Plinth" at={tP + 0.1} size={L(170, 140)} />
        </div>
        <div style={{ display: 'flex', gap: L(30, 0), flexDirection: L('row', 'column'), alignItems: 'center' }}>
          <Display text="No keys." at={t1} size={L(62, 58)} />
          <Display text="No *hidden switch.*" at={t2} size={L(62, 58)} />
          <Display text="Your share, *any time.*" at={t3} size={L(62, 58)} />
        </div>
        <div style={{ height: L(18, 10) }} />
        <Pill at={tEnd} strong size={L(32, 28)}>Try it: unajijacob6-create.github.io/plinth</Pill>
        <div style={{ display: 'flex', gap: 16, opacity: useEnv(tEnd + 0.3) }}>
          <Pill at={tEnd + 0.3} size={L(24, 22)}>github.com/unajijacob6-create/plinth</Pill>
        </div>
        <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: L(26, 24), color: C.on2, opacity: useEnv(tEnd + 0.6), marginTop: 6 }}>
          Built at NEAR HACKATHON 2026 · #NEARHackathon
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
          <Testnet at={tEnd + 0.8} />
          <Pill at={tEnd + 0.9} size={22} dot={C.on3}>Test tokens</Pill>
        </div>
      </div>
    </AbsoluteFill>
  );
};
