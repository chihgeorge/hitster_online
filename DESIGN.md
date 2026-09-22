---
# gstack: design-md-format=spec
name: HITSTER! Online
description: A playful, retro vinyl-record party game — bold outlined type, a warm orange/gold/mint palette, and small toy-like motion (spinning vinyl, sparkle) that make winning a round feel like a physical moment, not a form submission.
colors:
  primary: "#FF6B35"        # orange — CTAs, brand mark, the one accent everything else defers to
  primary-dark: "#E85520"   # orange, pressed/active state
  on-primary: "#FFF9F5"
  gold: "#FFD600"           # the current leader, celebration, "you're winning" moments only
  mint: "#00C896"           # correct answer / success
  danger: "#FF3B5C"         # time's up, wrong answer, destructive actions
  surface: "#FFFFFF"
  surface-warm: "#FFF0E8"   # panels, cards — warmer than pure white, pairs with --bg
  background: "#FFF9F5"
  ink: "#1A1A2E"             # primary text, also the dark surface for scoreboards/badges
  text: "#1A1A2E"
  text-muted: "#7B7B9A"
  text-faint: "#B0AFBC"
typography:
  display:
    fontFamily: "Nunito"
    fontWeight: 900
    fontSize: "clamp(1.5rem, 4vw, 3rem)"
    letterSpacing: "0em"
    note: "outlined variant: -webkit-text-stroke 1.5-2px var(--ink), paint-order stroke fill, color var(--primary) — used for the HITSTER! title mark only, not body headings"
  body:
    fontFamily: "'Noto Sans TC', var(--font-nunito), system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
    note: "Chinese-first — Noto Sans TC leads the stack since the UI is zh-TW by default"
  label:
    fontFamily: "Nunito"
    fontSize: "0.8125rem"
    letterSpacing: "0.02em"
  mono:
    fontFamily: "'DM Mono', monospace"
    fontFeature: tnum
    note: "countdown timers and scores only — fixed-width digits don't jitter while counting down"
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-primary-active:
    backgroundColor: "{colors.primary-dark}"
  panel:
    backgroundColor: "{colors.surface-warm}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  scoreboard-leader-chip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.gold}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
---

# HITSTER! Online

## Overview

**Creative North Star:** A living-room game night, not a web app — bold, toy-like, and legible from across a room, never a shrunk-down form.
**Product context:** A Traditional-Chinese-first web party game (Timeline mode + Lyrics mode) played on a shared big screen with phones as controllers; peers are Jackbox/Kahoot-style party games, but this one is music-trivia specific.
**Mode per surface:** `/play` (phone) = Operate; `/host` (phone, controller) = Operate; `/screen` (TV/projector) = Experience — passive, shared, room-distance viewing, no input.
**Reference sites:** none (established system, not researched this pass — see Decisions Log).
**Key characteristics:**
- Outlined, stroke-filled display type on the brand mark only — playful, not corporate
- Warm cream/orange ground, never stark white or dark-mode-by-default
- Small toy-like motion (spinning vinyl, sparkle) marks celebration moments, not used for micro-interactions
- Fixed-width mono digits anywhere a number counts down or changes live (timer, score)
- Chinese leads every UI string; English is present as a secondary line, not the primary voice

## Colors

**Strategy:** Full palette — primary (orange) carries the brand and CTAs, gold/mint/danger are semantic (leading/correct/urgent), never decorative.
**Light or dark:** Light, fixed. The use scene is a lit living room with a shared screen everyone (including phone-holders glancing up) needs to read at a glance — dark mode would fight the TV/projector's own brightness and offers no benefit here.
Gold signals "current leader" only — never used for a second accent or as a generic highlight. Mint and danger are strictly semantic (correct / urgent-or-wrong) so their meaning stays legible without a label. Ink (#1A1A2E) doubles as both body text on light panels and the dark ground for scoreboard/badge chips — one dark value, two jobs, rather than a second near-black token.

## Typography

Nunito (Google Fonts, weights 400-900) carries display and UI weight; Noto Sans TC (400/700/900) leads every string since the product is Traditional-Chinese-first, with Nunito as the Latin fallback in the same stack. DM Mono is reserved for anything numeric that changes live — a countdown or a score — so digits don't reflow the layout as they change. The outlined-stroke title treatment (`-webkit-text-stroke` + `paint-order: stroke fill`) is a brand mark, used for the "HITSTER!" wordmark only; it does not appear on section headings or body copy, which stay solid-fill Nunito/Noto Sans TC. No new faces were introduced for `/screen` — room-distance legibility comes from scaling existing sizes up, not from a different typeface.

## Layout

Two layout modes, deliberately different: `/host` and `/play` are phone-first, single-column, stacked sections sized for touch (44px+ targets). `/screen` is a **fixed 960×540 logical canvas**, scaled as one unit via `transform: scale()` to fit any physical screen and letterboxed outside 16:9 (ported from the Stage pattern in the sibling project critical-answer). Because the whole canvas scales together, `/screen` needs no separate breakpoints — relative spacing holds at 1080p, 4K, or a small laptop screen used as a "TV." `/screen`'s layout is coarser than the phone pages: a handful of large zones (round content, turn indicator, scoreboard) rather than the phone page's tighter stacked sections, since a TV is read at a glance from across a room, not scrolled.

## Elevation & Depth

Flat by default — panels are distinguished by fill color (`surface-warm` vs `surface`) and a 2px solid `ink` border, not shadow. No blur-based elevation system exists yet; introduce one only if a future surface genuinely needs stacking order communicated visually (e.g., a modal over `/screen`), and use an offset + soft-blur shadow then, never a zero-offset glow.

## Shapes

Radius scale: 8px (chips, small badges) / 12px (buttons, inputs) / 16px (panels, cards) / full (pills — turn indicator, room-code badge). Nested elements (e.g., a chip inside a panel) use the smaller radius so the visual "gap" from the outer edge reads correctly.

## Components

- **button-primary** (`Panel`/CTA buttons across `/host`, `/play`): solid `primary` fill, `on-primary` text, `md` radius; active/pressed state darkens to `primary-dark`. No hover state is designed — every surface is touch-first (`/host`, `/play`) or has no cursor at all (`/screen`).
- **panel** (setup forms, drawers, the QR panel): `surface-warm` fill, 2px `ink` border, `lg` radius. This is the one container shape reused everywhere a grouped block of controls or info needs a boundary — never nested (a panel inside a panel does not occur).
- **scoreboard-leader-chip** (new, `/screen` only): `ink` background, `gold` text/number, a crown or star glyph — the one place gold appears as a background-adjacent accent rather than pure text color, reserved for the single current leader.
- **card** (song rows, diagnostic table rows): plain `surface` fill, `md` radius, no border — distinguished from `panel` by having no boundary, since cards sit inside an already-bounded container (a table, a list).

## Do's and Don'ts

- Do: keep gold exclusively for "current leader" — introducing a second use (e.g., a generic "featured" tag) would break the one semantic read the color currently has.
- Do: scale `/screen` content up from existing sizes rather than inventing new type sizes — a 960×540 canvas at 4x on a 4K TV should look like the same design, bigger, not a redesign.
- Do: reserve DM Mono for numbers that change live (timer, score) — using it for static labels would suggest they're also live/counting.
- Don't: add a hover state to `/screen` — it has no cursor; any interactivity there is a design mistake (the whole point of the split is that `/screen` is read-only).
- Don't: nest a `panel` inside another `panel` — use `card` for the inner content instead.
- Don't: introduce a second display face for `/screen` "because it's a TV now" — the brand needs to stay recognizably the same app as `/host` and `/play`, scaled, not reskinned.

## Motion

- **Approach:** intentional, and deliberately calmer on `/screen` than on `/host`/`/play` — a shared, passive-viewing room reacts worse to busy motion than one person holding a phone, and a TV has no hover/cursor to drive micro-interactions with anyway.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms); the vinyl spin is a continuous 9s linear loop, not a duration-scale entrance/exit
- **The authored moments:** the vinyl-spin + sparkle pairing on a correct-answer/reveal moment, and (new) confetti + a bouncing trophy on the winner screen when the game ends — the two places decoration is allowed to be expressive; everywhere else motion stays functional (fades, no bounces or overshoot).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-22 | Documented the existing color/type/motion system (previously undocumented in code only) | Retroactive DESIGN.md for a system already proven across /host and /play; no research run, no new identity |
| 2026-09-22 | /screen (new): fixed 960x540 Stage canvas, coarser layout, calmer motion, giant DM Mono countdown, marquee scoreboard | New TV/projector surface for the host/screen split (see /plan-eng-review, same session); ported the Stage-scaling pattern from sibling project critical-answer, kept hitster's own palette/fonts rather than critical-answer's pixel-dungeon theme (considered and declined — full re-skin, ~3-5 days, and a content-fit mismatch: dungeon look on a music-trivia game) |
| 2026-09-22 | Guess-position marker ("?" block, orange token, no new color) + winner-screen confetti/trophy (second authored motion moment, existing palette only) | Both reuse existing tokens and the established `card`/`panel` visual language — no new colors, faces, or radii introduced; the winner screen is treated as a second deliberate celebration moment alongside the existing vinyl-spin + sparkle |
| 2026-09-22 | Faint generated vinyl-groove + music-note SVG background pattern (`.bg-vinyl-pattern`, existing orange/gold tokens, 4-8% opacity) on the two "waiting for people to join" surfaces — `/screen`'s lobby and the host lobby (while `phase === "lobby"`) | User-requested; no AI raster image generator available in this session (same constraint as the winner screen), so generated a CSS/SVG tile instead of a photo. Kept out of active gameplay phases on both surfaces — DESIGN.md's room-distance-legibility rule on `/screen` and the host's dense form UI both argue against a busy background once real content is on screen |
| 2026-09-22 | Reverted v0.8.0.0's bare `/screen` auto-create-on-load landing; restored an explicit "Create a Room" button on the homepage. Added a simple joined-player chip row (initial glyph + name, no new component) to `/screen`'s lobby | User caught the flaw: the site is public, so a page that creates a room just from being loaded is wrong (not offline/local-only as first assumed). Room creation now requires a deliberate click, same private host-link mechanism as before |
