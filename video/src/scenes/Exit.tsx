import React from 'react';
import { AbsoluteFill, Easing } from 'remotion';
import { C, FONT } from '../theme';
import { S, at } from '../timeline';
import { BrowserFrame, Chip, Counter, Logo, Panel, Stamp, Testnet, Words, lerp, useEnv, useLayout, useSpring, useT } from '../components';

/** 6. Exit in kind: Bob leaves with 40% of each token. */
export const Exit: React.FC = () => {
  const t = useT();
  const { L, sq } = useLayout();
  const o = S.exit[0];
  const g = (x: number) => x - o;
  const tBob = g(at('Bob')) - 0.9;
  const dur = S.exit[1] - o;
  const split = lerp(t, tBob + 0.9, tBob + 1.7, 0, 1, Easing.inOut(Easing.cubic));
  const tokens = [
    { name: 'pUSD', total: 89.9955, bob: 35.9982, dec: 4, color: C.blue },
    { name: 'wNEAR', total: 0.021, bob: 0.0084, dec: 4, color: C.cyan },
  ];
  const barW = L(820, 620);
  return (
    <AbsoluteFill>
      {/* A: the live fund card, anyone can leave */}
      <AbsoluteFill style={{ opacity: useEnv(0, tBob, 0.3, 0.3) }}>
        <div style={{ position: 'absolute', left: L(120, 70), top: L(300, 90), width: L(820, 940) }}>
          <Words text={L('Leave any time,\nwith your share\nof every token.', 'Leave any time, with your\nshare of every token.')} at={0.1} size={L(84, 58)} grad={['every', 'token.']} />
        </div>
        <div style={{ position: 'absolute', left: L(1060, 160), top: L(90, 300) }}>
          <BrowserFrame src="rec/card.png" imgW={1048} at={0.15} out={tBob} width={L(700, 760)} viewH={L(800, 640)} scroll={[0.6, tBob, 250, 520]} tilt={[-12, -6]} url="unajijacob6-create.github.io/plinth/?fund=fund-mwc4ll9q…" />
        </div>
      </AbsoluteFill>
      {/* B: Bob's redemption, real amounts */}
      <AbsoluteFill style={{ opacity: useEnv(tBob, dur - 0.3, 0.3, 0.3) }}>
        <div style={{ position: 'absolute', top: L(70, 80), left: L(120, 70) }}>
          <Words text="Bob redeems 40% of the shares." at={tBob} size={L(60, 48)} grad={['40%']} />
        </div>
        <Testnet at={tBob + 0.2} style={{ position: 'absolute', right: L(120, 70), top: L(84, 170) }} />
        <div style={{ position: 'absolute', left: L(120, 70), top: L(250, 260), display: 'flex', flexDirection: 'column', gap: L(50, 40) }}>
          {tokens.map((tk, i) => (
            <div key={tk.name} style={{ opacity: useEnv(tBob + 0.2 + i * 0.15) }}>
              <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 30, color: C.ink2, marginBottom: 12 }}>
                Fund held {tk.total} {tk.name}
              </div>
              <div style={{ position: 'relative', width: barW, height: 70 }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: 70, width: barW * 0.6 - 4, borderRadius: 12, background: `${tk.color}55`, border: `2px solid ${tk.color}` }} />
                <div style={{ position: 'absolute', left: barW * 0.6 + split * L(160, 40), top: split * L(0, 0), height: 70, width: barW * 0.4, borderRadius: 12, background: tk.color, boxShadow: `0 0 ${40 * split}px ${tk.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, fontWeight: 800, fontSize: 30, color: C.bg }}>
                  40%
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* Bob */}
        <div style={{ position: 'absolute', left: L(1530, 120), top: L(250, 690), opacity: useEnv(tBob + 1.2), transform: `scale(${0.8 + 0.2 * useSpring(tBob + 1.2)})`, transformOrigin: 'left top' }}>
          <Panel glow={C.ok} style={{ width: L(300, 840), padding: '24px 28px' }}>
            <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 36, color: C.ink }}>Bob received</div>
            <div style={{ display: 'flex', flexDirection: L('column', 'row'), gap: L(4, 30), marginTop: 8 }}>
              {tokens.map((tk) => (
                <div key={tk.name} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 38, color: tk.color }}>
                  <Counter to={tk.bob} at={tBob + 1.4} dur={1.0} decimals={tk.dec} /> <span style={{ fontSize: 26, color: C.ink2 }}>{tk.name}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div style={{ position: 'absolute', left: L(120, 70), top: L(700, sq ? 900 : 700), display: 'flex', gap: 24, alignItems: 'center' }}>
          <Stamp at={tBob + 2.2} verdict="REDEEMED IN KIND" tx="D1a37KJz…" reason="40,000,000 of 100,000,000 shares → 40% of each holding" color={C.ok} size={L(0.72, 0.6)} rot={-2} maxWidth={L(1000, 940)} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 7. Close. */
export const Close: React.FC = () => {
  const t = useT();
  const { L } = useLayout();
  const o = S.close[0];
  const g = (x: number) => x - o;
  const tP = g(at('Plinth', 1)) - 0.1;
  const lines: [string, number][] = [
    ['No keys.', g(at('No', 0))],
    ['No oracle.', g(at('No', 1))],
    ['No manager.', g(at('No', 2))],
  ];
  const tTest = g(at('testnet')) - 0.4;
  const push = 1 + lerp(t, 0, S.close[1] - o, 0, 0.04, Easing.linear);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${push})` }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: L(26, 22), marginTop: -40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <Logo size={L(120, 100)} at={tP} />
          <Words text="Plinth" at={tP + 0.1} size={L(130, 110)} />
        </div>
        <div style={{ display: 'flex', gap: L(44, 0), flexDirection: L('row', 'column'), alignItems: 'center' }}>
          {lines.map(([s, a]) => (
            <Words key={s} text={s} at={a - 0.05} size={L(78, 74)} grad={['keys.', 'oracle.', 'manager.']} stagger={0.05} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginTop: L(26, 20), flexWrap: 'wrap', justifyContent: 'center' }}>
          <Chip at={tTest} color={C.warn} size={L(30, 28)}>Testnet today</Chip>
          <Chip at={tTest + 0.15} color={C.cyan} size={L(30, 28)}>unajijacob6-create.github.io/plinth</Chip>
        </div>
        <div style={{ opacity: useEnv(tTest + 0.6), fontFamily: FONT, fontWeight: 800, fontSize: L(28, 26), letterSpacing: '0.2em', color: C.ink2, marginTop: 14 }}>
          BUILT AT NEAR HACKATHON
        </div>
      </div>
    </AbsoluteFill>
  );
};
