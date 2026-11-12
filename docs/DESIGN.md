# Plinth site: design rules

The website (`web/`) follows the ten principles below. The tokens live in `web/src/base.css` (`:root`).
Change a token there rather than writing a new value in a component. When you add something to a
page, find the component below that already does the job and reuse it.

## Tokens

| Group | Tokens | Rule |
|---|---|---|
| Colour, 60-30-10 | `--bg` `--surface` `--surface-2` (60%), `--ink` `--ink-2` `--ink-3` (30%), `--blue` (10%) | One accent. `--blue-ink` is the same accent, dark enough for small text. |
| State colour | `--ok` (settled, verified), `--bad` (refused, failing) | Only on a small dot, icon or one-word state. Never decoration, and never two state pills side by side. |
| Night band | `--night` `--night-2` `--on-night` `--on-night-2` | Only the hero band at the top of Home, How, Verify and Security, and Home's closing band. |
| Contrast | text on `--bg`/`--surface`: `--ink` 17:1, `--ink-2` 7:1, `--ink-3` 5.3:1, `--blue-ink` 6:1 | Body text at least 4.5:1, large text at least 3:1. `--blue` (4.2:1) is for large text and shapes only. |
| Spacing | `--sp-1` … `--sp-12` (4 8 12 16 24 32 48 64 80 96 128 160 px) | Every gap uses the scale. Inside a group: `--sp-2`…`--sp-4`. Between groups: `--sp-5`…`--sp-7`. Between sections: `--section` (96 px on a phone, 160 px on a wide screen). |
| Shape | `--r-control` 12, `--r-inner` 16, `--r-card` 24, pill 999 | One radius per kind of thing: controls, panels inside a card, cards. Buttons and tags are pills. |
| Border and shadow | `--border`, `--shadow`, `--shadow-hover` | Every card has the same border and shadow. Hover lifts with `--shadow-hover`. |
| Motion | `--ease`, `--dur-ui` 200 ms, `--dur-reveal` 600 ms | UI changes use `--dur-ui` and arrivals use `--dur-reveal`, always with `--ease`. Line drawings take 700 ms. Ambient loops (hero light, stars, marquee, diagrams) are slow and continuous. Reduced motion turns all of it off. |
| Measure | `--measure` 66ch, body line-height 1.65 | Body text never runs wider than about 66 characters. |
| Targets | `--tap` 44 px, `--field` 48 px | Every control is at least 44 px tall, and inputs are 48 px. |

## Type: four levels

Each level differs from the next in size and in weight. Nothing sits between two levels.

| Level | Face and weight | Sizes | Used for |
|---|---|---|---|
| 1 Display | Inter Tight 600, tight tracking, one italic Instrument Serif phrase | `--fs-display` (hero, 46–96), `--fs-title` (page title, 44–80), `--fs-h2` (section title, 36–56), `--fs-stat` (live numbers) | One focal point per section |
| 2 Heading | Inter Tight 650 (`--w-heading`) | `--fs-h3` (24–32) | Card and panel titles, a case's decision, key numbers inside a card |
| 3 Body | Manrope 400–500 | `--fs-base` (17/18); `--fs-lead` only directly under a display title; `--fs-sm` (15) for secondary text in `--ink-2`/`--ink-3` | Reading. A list item's title is body size at heading weight. |
| 4 Label | Manrope 700 (`--w-label`), sentence case | `--fs-label` (15) | Labels above values, tags, form labels, step counters, eyebrows (a short blue dash plus the label) |

Numbers are tabular everywhere. There are no tiny uppercase labels; colour sets how quiet a label is, not size.

## Components

- **Section head**: label (dash and text), display title with one italic accent, an optional lead.
  It is left-aligned. Only the hero and the closing band are centred.
- **Card** (`.soft`, `.fund`, `.case`, `.card`, the launch stage): `--surface`, `--border`, `--r-card`,
  `--shadow`. Each card has one heading, and its groups are separated by `--sp-6`.
- **Panel inside a card** (`.panel`, `.kv`, `.vote`, `.said-box`, `.proof`): `--surface-2`, `--r-inner`, no shadow.
- **Status line** (`.outcome`): a small round icon carries the meaning (✓ green, ✕ red, – grey),
  followed by one sentence in ink.
- **Tag** (`.chip`, `.tag`): one outline style, 15 px/600, ink text. Refused and settled tags add one small coloured dot.
- **Buttons**: one primary (blue pill) per view for the main action. Everything else is a ghost or a
  link. Buttons press in on click.
- **Details on demand**: anything that is not needed at first glance goes in a `<details>` with a
  one-line summary. This covers a fund's rules and history, how a fund without a manager works, and the FAQ answers.
- **Carousel** (`web/src/carousel.ts`): one item at a time, scroll-snap, swipe, previous/next buttons, dots,
  arrow keys. Items that are off-screen are inert. There are no scrollbars inside a page.
- **Stepper** (the launch form): one step at a time, a numbered progress line, Back/Next, a check on
  each step, and a review at the end.
- **Diagrams**: hand-made SVG or HTML/CSS. Each one explains a real mechanism (tokens in, rules
  check, slice out; checks in turn; refunds through the refund account). No stock images or logos.

## What the user asked for, and the rule it became

| Feedback | Principle | Rule now in the code |
|---|---|---|
| "Everything is too compact" | Whitespace and measure; proximity | Spacing scale only; `--section` 96–160 px between sections; groups separated by gaps clearly larger than the gaps inside them; 66ch lines; 1.65 line height |
| "Colour riot" | Contrast and restraint (60-30-10) | One accent; state colour only on a dot or icon; no coloured pills; the dark summary and wallet blocks became white cards |
| Text "gives an odd feeling" | Readability of labels | No tiny uppercase; labels are sentence case at 15 px/700 |
| "Some text must be bolder and much bigger" | Visual hierarchy | Four type levels that differ in size and weight; card and panel titles at `--fs-h3`/650; labels at 700 |
| "The manager badge overlaps the next tab" | Alignment and grid | Tags sit inside their own box; nothing is absolutely positioned over a neighbour |
| "One at a time, scroll to the next" | Progressive disclosure; consistency | One carousel component for every set of cases |
| "One part stays still while the other moves" | Motion with purpose | No sticky column beside scrolling content; the launch form is a stepper instead of a form beside a frozen summary |
| "Clean and smooth" | Consistency; motion | One radius family, one shadow, one easing and two durations; heights reserved for content filled in after load, so nothing jumps |
| "More elements and animation" | Motion with purpose | Animated diagrams that each explain one mechanism; reveals on scroll; reduced motion is respected |
| "Understandable and organised" | Visual hierarchy; progressive disclosure | One focal point per section; essentials first, details in `<details>` |
| Interactive things must look interactive | Affordance and Fitts | Buttons are pills; links are blue-ink and underline on hover; at least 44 px targets; one primary action per view |

## Checklist for any change

1. Does each section have one focal point, and does the text use only the four levels?
2. Is colour the accent or a state, and does the text meet AA contrast?
3. Do the gaps come from the scale, with groups clearly further apart than the items inside them?
4. Is it left-aligned (unless it is the hero or closing band) on the page's one column grid?
5. Does it reuse an existing component with the same radius, border and shadow?
6. Are lines 75 characters or shorter, at line height 1.6 or more?
7. Is anything secondary behind a `<details>`?
8. Does any motion explain something, use the tokens, and switch off with reduced motion?
9. Is the main action the most prominent control, and is every target at least 44 px?
10. Are labels in sentence case, and are numbers tabular?

The smoke test (`web/tests/smoke.mjs`) checks the parts a machine can check: no code-like text,
targets of at least 44 px, no horizontal overflow, no scrollbars inside a page, and no console errors.
