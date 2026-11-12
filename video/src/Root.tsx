import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C, F, FPS } from './theme';
import { S, SEGS, TOTAL_FRAMES, TOTAL_SECONDS, WORDS, at, f } from './timeline';
import { Backdrop, Logo, Pill, Shell, lerp } from './components';
import { Captions } from './Captions';
import { Behind, Best, Close, Hook, Step1, Step2, Step3, Step4, Title } from './scenes';

// Fonts: Inter Tight and Instrument Serif (the site's display faces) and Manrope, all OFL, from the repo.
const fontHandle = typeof window !== 'undefined' ? delayRender('fonts') : 0;
if (typeof window !== 'undefined') {
  const faces = [
    new FontFace('Inter Tight', `url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')})`, { weight: '100 900' }),
    new FontFace('Instrument Serif', `url(${staticFile('fonts/instrument-serif-latin-400-italic.woff2')})`, { style: 'italic', weight: '400' }),
    new FontFace('Manrope', `url(${staticFile('fonts/manrope-latin-500-normal.woff')})`, { weight: '500' }),
    new FontFace('Manrope', `url(${staticFile('fonts/manrope-latin-800-normal.woff')})`, { weight: '600 800' }),
  ];
  Promise.all(faces.map((ff) => ff.load())).then((loaded) => {
    loaded.forEach((ff) => (document.fonts as unknown as { add: (f: FontFace) => void }).add(ff));
    continueRender(fontHandle);
  });
}

const SCENES: [keyof typeof S, React.FC][] = [
  ['hook', Hook], ['title', Title], ['s1', Step1], ['s2', Step2], ['s3', Step3], ['s4', Step4], ['behind', Behind], ['best', Best], ['close', Close],
];

// Sound design, video seconds.
const SFX: [string, number, number][] = (() => {
  const o: [string, number, number][] = [];
  for (const k of ['title', 's1', 's2', 's3', 's4', 'behind', 'best', 'close'] as const) o.push(['whoosh', S[k][0] - 0.3, 0.2]);
  o.push(['stamp', at('change', 0) + 0.15, 0.7], ['stamp', at('pause'), 0.7], ['stamp', at('stop'), 0.7]);
  o.push(['impact', at('Plinth') - 0.15, 0.45]);
  const t0 = at('Pick') - 1.0;
  for (const d of [0.9, 2.1, 3.3, 4.5]) o.push(['tick', S.s1[0] + t0 + d - 0.12, 0.8]);
  o.push(['stamp', at('shares') + 0.2, 0.8]);
  o.push(['deny', at('Anything') + 0.2, 1], ['stamp', at('Anything') + 0.2, 0.8]);
  o.push(['tick', S.s4[0] + 1.75, 0.8], ['stamp', S.s4[0] + 2.9, 0.8]);
  o.push(['tick', at('Anyone') - 0.4 + 0.8, 0.8], ['stamp', at('Anyone') - 0.4 + 1.4, 0.6]);
  o.push(['impact', S.best[0] + 0.1, 0.35]);
  o.push(['deny', at('One'), 0.8], ['stamp', at('nothing') - 0.1, 0.8], ['deny', at('refused', 2) - 0.2, 1]);
  o.push(['impact', at('Plinth', 1) - 0.15, 0.4]);
  return o;
})();

const speakingAt = (t: number) => WORDS.some((w) => t > w.s - 0.25 && t < w.e + 0.35);

const Soundtrack: React.FC = () => (
  <>
    {SEGS.map(([a, b, v], i) => (
      <Sequence key={i} from={f(v)} durationInFrames={f(b - a) + 1}>
        <Audio src={staticFile('audio/vo.mp3')} trimBefore={f(a)} trimAfter={f(b)} />
      </Sequence>
    ))}
    {/* ambient bed (ElevenLabs sound generation, looped), ducked under the voice; no music */}
    <Audio
      src={staticFile('sfx/pad.mp3')}
      loop
      volume={(fr) => {
        const t = fr / FPS;
        const fade = interpolate(t, [0, 1.5, TOTAL_SECONDS - 3, TOTAL_SECONDS], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return fade * (speakingAt(t) ? 0.07 : 0.15);
      }}
    />
    {SFX.map(([name, t, v], i) => (
      <Sequence key={i} from={Math.max(0, f(t))} durationInFrames={f(3)}>
        <Audio src={staticFile(`sfx/${name}.mp3`)} volume={v} />
      </Sequence>
    ))}
  </>
);

/** Brand bar during the walkthrough: logo left, honesty badges right (like the site's nav). */
const Header: React.FC<{ sq: boolean }> = ({ sq }) => {
  const t = useCurrentFrame() / FPS;
  const a = Math.min(lerp(t, S.s1[0] - 0.2, S.s1[0] + 0.4), 1 - lerp(t, S.close[0] - 0.6, S.close[0] - 0.1));
  if (a <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: sq ? 70 : 130, right: sq ? 70 : 130, top: sq ? 36 : 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: a }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Logo size={40} at={0} />
        <span style={{ fontFamily: F.display, fontWeight: 650, fontSize: 32, color: C.on, letterSpacing: '-0.02em' }}>Plinth</span>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <Pill at={0} dot="#f5c451" size={20}>NEAR testnet</Pill>
        {sq ? null : <Pill at={0} dot={C.on3} size={20}>Test tokens</Pill>}
      </div>
    </div>
  );
};

export const Main: React.FC<{ sq?: boolean }> = ({ sq = false }) => (
  <AbsoluteFill>
    <Backdrop />
    {SCENES.map(([k, Comp]) => {
      const [a, b] = S[k];
      return (
        <Sequence key={k} from={f(a)} durationInFrames={f(b - a)} name={k}>
          <Shell dur={b - a} inT={k === 'hook' ? 0.01 : 0.4} outT={k === 'close' ? 0.8 : 0.4}>
            <Comp />
          </Shell>
        </Sequence>
      );
    })}
    <Header sq={sq} />
    <Captions />
    <Soundtrack />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <>
    <Composition id="PlinthX" component={Main} defaultProps={{ sq: false }} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
    <Composition id="PlinthSquare" component={Main} defaultProps={{ sq: true }} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1080} height={1080} />
  </>
);
