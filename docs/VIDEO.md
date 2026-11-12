# Demo video

An 83.5-second explainer for X and the NEAR HACKATHON submission, rendered from code with
[Remotion](https://www.remotion.dev) (React). Everything is in `video/`.

Version 2 (current) is a walkthrough. It opens with the problem in plain words, then says "This is
Plinth, built on NEAR". Four numbered steps follow, each with the same layout: a step label, a big
title, one line of explanation, and the real live site in a browser frame. After them come a short
"Behind the scenes, on NEAR" diagram with the live verifier, and "The best part" (the tests where an
AI was tricked and a hijacked manager tried). It closes with the name, the links and honesty badges.
It is set in the site's night-band style (Inter Tight with an Instrument Serif italic accent, blue
glow; `web/src/base.css`, `docs/DESIGN.md`). Full-sentence subtitles run through the whole film.

| file | what |
|---|---|
| `video/out/plinth-x.mp4` | 1920×1080, 30 fps, H.264 High yuv420p + AAC 48 kHz, 83.5 s, about 36 MB, burned-in subtitles |
| `video/out/plinth-x-square.mp4` | 1080×1080 cut of the same composition, re-laid out (not cropped), 83.5 s, about 21 MB |
| `video/out/poster.png` | 1920×1080 preview frame (the closing card) |
| `video/out/plinth-x-v1.mp4`, `plinth-x-square-v1.mp4`, `poster-v1.png` | version 1 (88.5 s motion-graphics cut), kept for reference |
| `video/script.md` | the narration with the source of every fact on screen |

`video/out/`, `video/node_modules/` and `video/public/rec/` (screen captures) are git-ignored.

## Re-render

```bash
cd video
npm ci
npm run record          # re-capture the live site into public/rec/ (uses the repo's Playwright: npm ci at the repo root)
npm run draft           # half-size check render, out/draft.mp4
npm run render          # out/plinth-x.mp4
npm run render:square   # out/plinth-x-square.mp4
npm run poster          # out/poster.png
npm run studio          # interactive preview
```

`public/rec/` must exist before rendering. `npm run record` creates it; it needs the live site and
NEAR testnet RPC. It connects no wallet and sends no transaction: it fills the launch form, clicks
through to the Review step, and stops there.

`remotion.config.ts` points Remotion at the preinstalled Chrome headless shell (`/opt/pw-browsers/...`).
On another machine, set `REMOTION_BROWSER` to a Chrome or Chromium binary.

`render` runs `tools/finalize.sh`. It re-encodes to TV-range yuv420p and normalises the audio with
two-pass `loudnorm` to -16 LUFS integrated, -1.5 dBTP. Measured on the final file: -16.2 LUFS, true
peak -1.4 dBTP.

Structure:

- `src/timeline.ts`: the voiceover pieces (`SEGS`), word timings and scene boundaries.
- `src/components.tsx`: display type, label, accent line, pills, proof cards, the browser frame with
  scroll, zoom, highlight rings and a cursor, and the night backdrop.
- `src/scenes.tsx`: one component per beat, laid out for both 16:9 and 1:1.
- `src/Captions.tsx`: full-sentence subtitles.
- `src/Root.tsx`: compositions, header and audio.

## Script

The narration and the source of every number, quote and transaction hash on screen are in
[`video/script.md`](../video/script.md). The facts come from `README.md`, `data/testnet-run.json`,
`data/agent-run.json` and `data/quorum-run.json`, and from the site's own wording (`web/index.html`).
The footage is the live site (https://unajijacob6-create.github.io/plinth/), recorded on 2026-11-12
against NEAR testnet. The opening (a key, "Rules changed", "Fund paused", "Withdrawals stopped") is
a generic illustration of the problem and names no one. Recorded outcomes carry "Recorded on NEAR
testnet" and a shortened transaction hash. A header with "NEAR testnet" and "Test tokens" stays up
through the walkthrough. The film claims no mainnet deployment, audit, users or yield.

## Audio

All audio is generated with ElevenLabs through the API:

- **Voiceover (v2, 2026-11-12):** `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
  - Model `eleven_multilingual_v2`, voice "Eric - Smooth, Trustworthy" (`cjVigY5qzO86Huf0OWal`, premade).
  - Settings: stability 0.55, similarity 0.75, style 0.15, speed 1.0, `mp3_44100_128`.
  - One generation, 192 words, 66.5 s of speech, placed in nine pieces.
  - The character alignment returned by the endpoint drives the subtitles and the scene timing
    (`video/tools/alignment.json` → `video/tools/words.py` → `video/src/words.json`).
  - Version 1 used two generations of the same voice on 2026-11-11.
- **Sound effects and ambient bed (2026-11-11):** `POST /v1/sound-generation`: tick, whoosh, deny,
  stamp, impact, and a 22-second looping pad used as a quiet bed, ducked under the voice. Files are in
  `video/public/sfx/`.
- **No music track:** the account's key has no `music_generation` permission (`POST /v1/music`
  returned 401). The film uses only the generated pad, rather than music with unclear licensing.

Licence note: ElevenLabs output may be used under the ElevenLabs Terms of Service for the account's
plan. The account could not use the Creator-tier output format, so it is on a lower tier. If it is
the free tier, ElevenLabs requires attribution and non-commercial use. A hackathon demo is
non-commercial; credit "Voice and sound: ElevenLabs" in the post to be safe.

## Credits and licences

- Fonts, all under the SIL Open Font License 1.1 (licence files in `video/public/fonts/`):
  - Inter Tight, copyright 2022 The Inter Project Authors.
  - Instrument Serif, copyright 2022 The Instrument Serif Project Authors.
  - Manrope, copyright 2019 The Manrope Project Authors.
  - The files are the site's own (`web/src/fonts/`) and `api/_lib/fonts/`.
- Remotion: [Remotion licence](https://www.remotion.dev/license) (free for individuals and small teams).
- Colours, logo and layout language: the Plinth site (`web/src/base.css`, `docs/DESIGN.md`).
- Voice and sound effects: ElevenLabs (see above).
- Reference material: the user supplied two other hackathon videos as a style reference (structure
  only). No footage, music, names or branding from them is used.
