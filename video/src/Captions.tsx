import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from './theme';
import { S, WORDS, Word, at } from './timeline';
import { lerp } from './components';

type Phrase = { words: Word[]; s: number; e: number };

const PHRASES: Phrase[] = (() => {
  const out: Phrase[] = [];
  let cur: Word[] = [];
  const push = () => { if (cur.length) out.push({ words: cur, s: cur[0].s, e: cur[cur.length - 1].e }); cur = []; };
  WORDS.forEach((w, i) => {
    const prev = WORDS[i - 1];
    const chars = cur.map((x) => x.w).join(' ').length + w.w.length;
    if (cur.length && (/[.!?]$/.test(prev.w) || (/,$/.test(prev.w) && cur.length >= 2) || cur.length >= 6 || chars > 34 || w.s - prev.e > 0.45)) push();
    cur.push(w);
  });
  push();
  return out;
})();

// Lines already on screen as big type: no caption on top of them.
const QUIET: [number, number][] = [
  [S.hook[0], S.hook[1]],
  [at('The', 1) - 0.1, at('A') - 0.05], // "The contract decides."
  [S.bug[0], at('Releases') - 0.05], // "We found a bug in our own funds."
  [at('Or') - 0.1, at('Anyone', 1) - 0.05], // "Or skip the manager."
  [S.close[0], S.close[1] + 1],
];

export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const sq = width === height;
  if (QUIET.some(([a, b]) => t >= a && t < b)) return null;
  const idx = PHRASES.findIndex((p, i) => t >= p.s - 0.08 && t < Math.min(p.e + 0.5, (PHRASES[i + 1]?.s ?? 1e9) - 0.08));
  if (idx < 0) return null;
  const p = PHRASES[idx];
  const inP = lerp(t, p.s - 0.08, p.s + 0.12);
  const size = sq ? 46 : 52;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: sq ? 56 : 64, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.2, letterSpacing: '-0.01em', padding: '14px 30px 16px', borderRadius: 18,
          background: 'rgba(5, 8, 15, 0.78)', border: `1px solid ${C.line}`, boxShadow: '0 20px 50px -20px #000',
          opacity: inP, transform: `translateY(${(1 - inP) * 14}px)`, maxWidth: sq ? 980 : 1500, textAlign: 'center',
        }}
      >
        {p.words.map((w, i) => {
          const spoken = t >= w.s - 0.02;
          return (
            <span key={i} style={{ color: spoken ? C.ink : C.ink3 }}>
              {w.w}
              {i < p.words.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
};
