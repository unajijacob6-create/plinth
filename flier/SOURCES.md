# Flier sources

## Marks

- **NEAR logo** (`assets/near-logo-white.svg`): NEAR's reversed (white) horizontal logo, the N symbol
  and the "near" wordmark, copied byte for byte and not modified.
  - Downloaded 2026-11-12 from
    `https://mintcdn.com/neardocs/qO2GD-gji1aakHqN/assets/logo_rev.svg`. That is the dark-mode
    logo of NEAR's official documentation site, docs.near.org. NEAR's old brand page,
    `https://pages.near.org/about/brand/`, now redirects to `https://docs.near.org/`, which serves
    this file.
  - sha256 `f76009dce4c0d4bbd4bda6c485e50b0376f3814d60ec73feb2a0e46a85873ca6`.
  - Checked against near.org: the inline header logo on `https://near.org/` uses the same N symbol
    and "near" letterforms, at a different scale.
  - How it is used: white on the dark background, at 30–40 px tall (smaller than the Plinth
    lockup), with clear space on every side. It appears only after the words "Built on". Nothing
    on the flier says or suggests that NEAR endorses or sponsors Plinth.
- **Plinth logo**: the three stacked bars from `LOGO` in `web/src/shell.ts`, with the same
  rectangles and the same classes. On the dark background, `b3` is `currentColor` (white), as in
  the site's dark header.

## Fonts (SIL Open Font License 1.1; licences in `assets/fonts/`)

- Inter Tight (variable) and Instrument Serif Italic: copied from `web/src/fonts/`.
- Manrope (variable, Latin): copied from `node_modules/@fontsource-variable/manrope/files/`.

## Generated

- `assets/qr.svg`: made by `render.mjs` with the npm package `qrcode` 1.5.4. It encodes
  `https://unajijacob6-create.github.io/plinth/` at error correction M, dark #030817 on white,
  with a 4-module quiet zone. On each render, `render.mjs` decodes the QR code from the finished
  PNG with `jsqr` 1.4.0, at full size and at half size.
- The hero object, icons, glow, grid and wires are SVG and CSS written for this flier, in
  `flier.js` and `flier.css`. The flier uses no stock images, no AI-generated images and no
  logos from other brands.

## Facts on the flier

| Text on the flier | Source |
|---|---|
| My submission for NEAR HACKATHON 2026 | README: "Built at the NEAR HACKATHON (November 2026) by Unaji Jacob" |
| A shared fund *nobody can change.* | Site hero, `web/index.html` |
| People pool tokens … take their share out at any time. | Site hero sub-line, `web/index.html` |
| No keys: nobody can change it, not even its creator | README "No keys" (0 access keys; code pinned by hash); `web/index.html` ("not even the people who built it") |
| The manager only suggests; the contract refuses anything outside the rules | README, "The manager … can only **propose** a swap", and "Trades" (`check_trade`) |
| A hijacked manager was refused on chain | `data/agent-run.json`, case `hijacked`: `accepted: false`, "quote must deliver to this fund and refund to its relay on NEAR", tx `CmxW4CcE…` |
| Leave any time: your slice of every token, no permission needed | README "Exit": `redeem(shares)` pays the same fraction of every token; "In-kind exit needs no third party" |
| 0 access keys on the fund, its relay and the factory | README "What the chain proves"; `data/open-fund.json` `access_keys: 0`; `data/testnet-run.json` `access_keys_after_create: 0` |
| Two AIs must agree: one tricked, one held, nothing was sent | `data/quorum-run.json`, case `injected`: Gemini voted to trade to `attacker-wallet.testnet`, DeepSeek held, `quorum.agreed: false`, `accepted: null` (nothing proposed) |
| A bug, fixed in the open: found, proved and fixed in our earlier funds | README, "The known issue": releases 0.1 and 0.2, found on 2026-11-10, proved with a sandbox proof of concept, fixed in 0.3; `data/releases.json` `known_issue` |
| Rebuilt byte for byte: release 0.3 code, from its source | `data/releases.json` 0.3 `reproducible` (image and digest, 311,122 bytes); README "Reproducible" |
| NEAR testnet · test tokens | README: "Everything here is on NEAR testnet"; pUSD "is a test token … it is not money" |
| Built on NEAR | README (NEAR testnet; NEP-591 global contract) |
| unajijacob6-create.github.io/plinth, github.com/unajijacob6-create/plinth | README "Try it" and "Credits" |
| by Unaji Jacob | README: "by Unaji Jacob"; "Copyright (c) 2026 Unaji Jacob" |
| #NEARHackathon | Hashtag asked for in the brief |
