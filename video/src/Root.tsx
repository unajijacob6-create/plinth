import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, continueRender, delayRender, interpolate, staticFile } from 'remotion';
import { FPS } from './theme';
import { CLOSE_GAP, CLOSE_SPLIT, S, TOTAL_FRAMES, VO_OFFSET, WORDS, at, f } from './timeline';
import { Backdrop, Shell } from './components';
import { Captions } from './Captions';
import { Hook, NoKeys } from './scenes/Hook';
import { Propose, Quorum, Refuse } from './scenes/Contract';
import { Auto, Bug } from './scenes/Bug';
import { Close, Exit } from './scenes/Exit';

// Manrope (OFL) from the repo: api/_lib/fonts, copied to public/fonts.
const fontHandle = typeof window !== 'undefined' ? delayRender('fonts') : 0;
if (typeof window !== 'undefined') {
  const faces = [
    new FontFace('Manrope', `url(${staticFile('fonts/manrope-latin-500-normal.woff')})`, { weight: '500' }),
    new FontFace('Manrope', `url(${staticFile('fonts/manrope-latin-800-normal.woff')})`, { weight: '800' }),
  ];
  Promise.all(faces.map((ff) => ff.load())).then((loaded) => {
    loaded.forEach((ff) => (document.fonts as unknown as { add: (f: FontFace) => void }).add(ff));
    continueRender(fontHandle);
  });
}

const SCENES: [keyof typeof S, React.FC][] = [
  ['hook', Hook], ['keys', NoKeys], ['propose', Propose], ['refuse', Refuse], ['quorum', Quorum],
  ['bug', Bug], ['auto', Auto], ['exit', Exit], ['close', Close],
];

// Sound design, global seconds.
const SFX: [string, number, number][] = (() => {
  const out: [string, number, number][] = [];
  out.push(['impact', at('This') - 0.12, 0.55]);
  for (const k of ['keys', 'propose', 'refuse', 'quorum', 'bug', 'auto', 'exit', 'close'] as const) out.push(['whoosh', S[k][0] - 0.35, 0.22]);
  out.push(['tick', at('zero') - 0.1, 0.9]);
  out.push(['stamp', at('published') + 0.5, 0.9], ['stamp', at('byte'), 0.9]);
  for (let i = 0; i < 5; i++) out.push(['tick', at('signed') + 2.2 + i * 0.28, 0.7]);
  out.push(['deny', at('Refused', 0), 1], ['stamp', at('Refused', 0), 0.9]);
  out.push(['deny', at('Refused', 1), 1], ['stamp', at('Refused', 1), 0.9]);
  out.push(['stamp', at('nothing') - 0.1, 0.9]);
  out.push(['stamp', at('0.3') - 0.3 + 1.7, 0.8]);
  out.push(['stamp', at('Refunds') - 0.3 + 2.1, 0.8]);
  out.push(['tick', at('rebalance'), 0.9]);
  out.push(['stamp', at('OutLayer') - 0.2 + 2.6, 0.8], ['deny', at('enclave', 1) - 0.2 + 1.2, 0.8]);
  out.push(['stamp', at('Bob') - 0.9 + 1.8, 0.8]);
  out.push(['impact', at('Plinth', 1) - 0.15, 0.4]);
  return out;
})();

const speakingAt = (t: number) => WORDS.some((w) => t > w.s - 0.25 && t < w.e + 0.35);

const Soundtrack: React.FC = () => (
  <>
    <Sequence from={f(VO_OFFSET)} durationInFrames={f(CLOSE_SPLIT)}>
      <Audio src={staticFile('audio/vo.mp3')} trimAfter={f(CLOSE_SPLIT)} />
    </Sequence>
    <Sequence from={f(CLOSE_SPLIT + VO_OFFSET + CLOSE_GAP)}>
      <Audio src={staticFile('audio/vo.mp3')} trimBefore={f(CLOSE_SPLIT)} />
    </Sequence>
    {/* ambient bed (ElevenLabs sound generation, looped), ducked under the voice */}
    <Audio
      src={staticFile('sfx/pad.mp3')}
      loop
      volume={(fr) => {
        const t = fr / FPS;
        const fade = interpolate(t, [0, 1.5, TOTAL_FRAMES / FPS - 3, TOTAL_FRAMES / FPS], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return fade * (speakingAt(t) ? 0.075 : 0.16);
      }}
    />
    {SFX.map(([name, t, v], i) => (
      <Sequence key={i} from={Math.max(0, f(t))} durationInFrames={f(3)}>
        <Audio src={staticFile(`sfx/${name}.mp3`)} volume={v} />
      </Sequence>
    ))}
  </>
);

export const Main: React.FC = () => (
  <AbsoluteFill>
    <Backdrop />
    {SCENES.map(([k, C]) => {
      const [a, b] = S[k];
      const dur = b - a;
      return (
        <Sequence key={k} from={f(a)} durationInFrames={f(dur)} name={k}>
          <Shell dur={dur} inT={k === 'hook' ? 0.01 : 0.35} outT={k === 'close' ? 0.6 : 0.35}>
            <C />
          </Shell>
        </Sequence>
      );
    })}
    <Captions />
    <Soundtrack />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <>
    <Composition id="PlinthX" component={Main} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
    <Composition id="PlinthSquare" component={Main} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1080} height={1080} />
  </>
);
