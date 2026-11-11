# Demo video

An 88.5-second motion-graphics film for X and the NEAR HACKATHON submission, rendered from code with
[Remotion](https://www.remotion.dev) (React). Everything is in `video/`.

| file | what |
|---|---|
| `video/out/plinth-x.mp4` | 1920×1080, 30 fps, H.264 High yuv420p + AAC 48 kHz, 88.5 s, about 44 MB, burned-in captions |
| `video/out/plinth-x-square.mp4` | 1080×1080 cut of the same composition, re-laid out (not cropped), about 27 MB |
| `video/out/poster.png` | 1920×1080 preview frame (frame 2595, the closing card) |
| `video/script.md` | the narration with the source file of every fact on screen |

`video/out/`, `video/node_modules/` and `video/public/rec/` (screen captures) are git-ignored.

## Re-render

```bash
cd video
npm ci
npm run record          # optional: re-capture the live site into public/rec/ (uses the repo's Playwright: npm ci at the repo root)
npm run draft           # half-size check render, out/draft.mp4
npm run render          # out/plinth-x.mp4
npm run render:square   # out/plinth-x-square.mp4
npm run poster          # out/poster.png
npm run studio          # interactive preview
```

`public/rec/` must exist before rendering (run `npm run record`; it needs the live site and NEAR testnet RPC).
`remotion.config.ts` points Remotion at the preinstalled Chrome headless shell
(`/opt/pw-browsers/...`); set `REMOTION_BROWSER` to another Chrome/Chromium binary elsewhere.
`render` runs `tools/finalize.sh`, which re-encodes to TV-range yuv420p and normalises the audio
with two-pass `loudnorm` to -16 LUFS integrated, -1.5 dBTP (measured on the final file: -16.2 LUFS,
true peak -1.46 dBTP).

Structure: `src/timeline.ts` (word timings from the voiceover, scene boundaries), `src/components.tsx`
(kinetic type, nodes, edges with moving particles, transaction stamps, counters, browser frame,
backdrop), `src/scenes/*` (one component per story beat, laid out for both 16:9 and 1:1),
`src/Captions.tsx` (phrase captions highlighted word by word), `src/Root.tsx` (compositions, audio).

## Script

The narration and the source of every number, quote and transaction hash on screen are in
[`video/script.md`](../video/script.md). In short, all facts come from `README.md`,
`docs/SECURITY.md`, `data/releases.json`, `data/testnet-run.json`, `data/agent-run.json`,
`data/quorum-run.json` and `data/auto-run.json`; footage is the live site
(https://unajijacob6-create.github.io/plinth/) recorded on 2026-11-11 against NEAR testnet. The
old-release bounce diagram (releases 0.1/0.2) is illustrative and shows no amounts. Every result is
labelled "NEAR testnet"; the film claims no mainnet deployment, audit, users or yield.

## Audio

All audio is generated with ElevenLabs through the API, on 2026-11-11:

- **Voiceover:** `POST /v1/text-to-speech/{voice_id}/with-timestamps`, model `eleven_multilingual_v2`,
  voice "Eric - Smooth, Trustworthy" (`cjVigY5qzO86Huf0OWal`, premade), stability 0.55, similarity
  0.75, style 0.15, speed 1.05, `mp3_44100_128`. Two generations in total (a draft, then the final
  with tightened wording). The character alignment returned by the endpoint drives the captions and
  the scene timing (`video/tools/alignment.json` → `video/tools/words.py` → `video/src/words.json`).
- **Sound effects and ambient bed:** `POST /v1/sound-generation` (tick, whoosh, deny, stamp, impact,
  and a 22-second looping pad used as a quiet bed, ducked under the voice). Files in `video/public/sfx/`.
- **No music track:** the account's key has no `music_generation` permission (`POST /v1/music`
  returned 401), so there is no music beyond the generated pad, rather than anything with unclear
  licensing.

Licence note: ElevenLabs output may be used under the ElevenLabs Terms of Service for the
account's plan. The account could not use the Creator-tier output format, so it is on a lower tier;
if it is the free tier, ElevenLabs requires attribution and non-commercial use. A hackathon demo
is non-commercial; credit "Voice and sound: ElevenLabs" in the post to be safe.

## Credits and licences

- Font: Manrope, copyright 2019 The Manrope Project Authors (github.com/sharanda/manrope), SIL Open Font License 1.1 (`video/public/fonts/OFL.txt`; the
  woff files are the ones in `api/_lib/fonts/`).
- Remotion: [Remotion licence](https://www.remotion.dev/license) (free for individuals and small
  teams).
- Colours, logo and gradient: the Plinth site (`web/src/style.css`, `web/index.html`).
- Voice and sound effects: ElevenLabs (see above).
