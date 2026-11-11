import rawWords from './words.json';
import { FPS } from './theme';

// The voiceover is one ElevenLabs generation (public/audio/vo.mp3). It is played in two pieces:
// everything up to "Plinth." starts at VO_OFFSET, and the closing line gets CLOSE_GAP more air.
export const VO_OFFSET = 0.3;
export const CLOSE_SPLIT = 79.62; // source seconds, in the silence before "Plinth."
export const CLOSE_GAP = 0.6;
export const TOTAL_SECONDS = 88.5;
export const TOTAL_FRAMES = Math.round(TOTAL_SECONDS * FPS);

export const vt = (src: number) => src + VO_OFFSET + (src >= CLOSE_SPLIT ? CLOSE_GAP : 0);

export type Word = { w: string; s: number; e: number };
// Spoken numbers are shown as figures in the captions.
const MERGE: [string[], string][] = [
  [['zero', 'point', 'one'], '0.1'],
  [['zero', 'point', 'two'], '0.2'],
  [['Zero', 'point', 'three'], '0.3'],
  [['Thirty', 'percent'], '30%'],
  [['forty', 'percent'], '40%'],
];
const clean = (w: string) => w.replace(/[.,!?]/g, '');
export const WORDS: Word[] = (() => {
  const src = (rawWords as Word[]).map((w) => ({ ...w, s: vt(w.s), e: vt(w.e) }));
  const out: Word[] = [];
  for (let i = 0; i < src.length; i++) {
    let merged = false;
    for (const [seq, rep] of MERGE) {
      if (seq.every((s, k) => src[i + k] && clean(src[i + k].w) === s)) {
        const last = src[i + seq.length - 1];
        const punct = last.w.match(/[.,!?]$/)?.[0] ?? '';
        out.push({ w: rep + punct, s: src[i].s, e: last.e });
        i += seq.length - 1;
        merged = true;
        break;
      }
    }
    if (!merged) out.push(src[i]);
  }
  return out;
})();

// Global time (s) at which the n-th occurrence of a word starts.
export const at = (word: string, nth = 0) => {
  const hits = WORDS.filter((w) => clean(w.w) === clean(word));
  if (!hits[nth]) throw new Error(`word not found: ${word} #${nth}`);
  return hits[nth].s;
};

// Scenes, in global seconds.
export const S = {
  hook: [0, 6.85],
  keys: [6.85, 18.55],
  propose: [18.55, 27.75],
  refuse: [27.75, 34.7],
  quorum: [34.7, 45.25],
  bug: [45.25, 61.1],
  auto: [61.1, 73.35],
  exit: [73.35, 80.3],
  close: [80.3, TOTAL_SECONDS],
} as const;
export const f = (s: number) => Math.round(s * FPS);
