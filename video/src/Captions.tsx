import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { C, F } from './theme';
import { WORDS, Word } from './timeline';
import { lerp } from './components';

// Full-sentence subtitles: each sentence is shown whole while it is spoken; words already said are brighter.
type Sentence = { words: Word[]; s: number; e: number };
const SENTENCES: Sentence[] = (() => {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  WORDS.forEach((w) => {
    cur.push(w);
    if (/[.?!]$/.test(w.w)) { out.push({ words: cur, s: cur[0].s, e: w.e }); cur = []; }
  });
  if (cur.length) out.push({ words: cur, s: cur[0].s, e: cur[cur.length - 1].e });
  return out;
})();

export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const sq = width === height;
  const i = SENTENCES.findIndex((p, k) => t >= p.s - 0.12 && t < Math.min(p.e + 0.6, (SENTENCES[k + 1]?.s ?? 1e9) - 0.12));
  if (i < 0) return null;
  const p = SENTENCES[i];
  const a = Math.min(lerp(t, p.s - 0.12, p.s + 0.08), 1 - lerp(t, p.e + 0.4, p.e + 0.6));
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: sq ? 170 : 190, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: sq ? 40 : 46, background: 'linear-gradient(180deg, transparent, rgba(3,8,23,.75) 55%)' }}>
      <div style={{ fontFamily: F.body, fontWeight: 700, fontSize: sq ? 34 : 40, lineHeight: 1.3, textAlign: 'center', maxWidth: sq ? 960 : 1500, opacity: a, textShadow: '0 2px 12px rgba(0,0,0,.6)', letterSpacing: '-0.005em', height: void 0 }}>
        {p.words.map((w, k) => (
          <span key={k} style={{ color: t >= w.s - 0.03 ? '#ffffff' : C.on2 }}>{w.w}{k < p.words.length - 1 ? ' ' : ''}</span>
        ))}
      </div>
    </div>
  );
};
