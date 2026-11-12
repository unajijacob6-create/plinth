import rawWords from './words.json';
import { FPS } from './theme';

// The voiceover is one ElevenLabs generation (public/audio/vo.mp3), placed in pieces so each part of
// the story gets room on screen. Each segment: [source start, source end, video start] in seconds.
export const SEGS: [number, number, number][] = [
  [0, 10.75, 0.4], // the problem
  [10.75, 16.05, 12.1], // this is Plinth
  [16.05, 23.9, 18.4], // 01 set the rules once
  [23.9, 28.4, 27.6], // 02 put tokens in
  [28.4, 34.772, 33.6], // 03 the manager can only suggest
  [34.772, 38.2, 41.6], // 04 leave any time
  [38.2, 48.8, 48.6], // behind the scenes
  [48.8, 62.68, 60.4], // the best part
  [62.68, 66.6, 75.4], // close
];
export const TOTAL_SECONDS = 83.5;
export const TOTAL_FRAMES = Math.round(TOTAL_SECONDS * FPS);

export const vt = (src: number) => {
  const s = SEGS.find(([a, b]) => src >= a && src < b) ?? SEGS[SEGS.length - 1];
  return src - s[0] + s[2];
};

export type Word = { w: string; s: number; e: number };
export const WORDS: Word[] = (rawWords as Word[]).map((w) => ({ ...w, s: vt(w.s), e: vt(w.e) }));

const clean = (w: string) => w.replace(/[.,!?]/g, '');
/** Video time (s) at which the n-th occurrence of a word starts. */
export const at = (word: string, nth = 0) => {
  const hits = WORDS.filter((w) => clean(w.w) === clean(word));
  if (!hits[nth]) throw new Error(`word not found: ${word} #${nth}`);
  return hits[nth].s;
};

// Scenes, in video seconds.
export const S = {
  hook: [0, 11.7],
  title: [11.7, 17.9],
  s1: [17.9, 27.3],
  s2: [27.3, 33.3],
  s3: [33.3, 41.3],
  s4: [41.3, 48.3],
  behind: [48.3, 60.1],
  best: [60.1, 75.0],
  close: [75.0, TOTAL_SECONDS],
} as const;
export const f = (s: number) => Math.round(s * FPS);
