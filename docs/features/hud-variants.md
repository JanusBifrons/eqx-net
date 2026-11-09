# Experimental piloting HUDs (`?ui=a|b|c`)

> **Historical (2026-11-09).** The variant switch is retired: variant D (Fire Control) is the only HUD, and the legacy HUD, A/B/C and `?ui=` are deleted. See [weapon-groups-and-locking.md](weapon-groups-and-locking.md). This page is kept as the record of the experiment.

Branch `exp/hud-mobile-first`. Three switchable HUD layouts for flying and
fighting, built mobile-first (landscape phone first, portrait and desktop must
still work). With no `?ui` the legacy HUD is untouched.

## Why

On a phone the in-flight HUD was close to unplayable:

- Every HUD size switched on MUI `sm`, a **width** breakpoint. A landscape
  phone (844 px wide) got the desktop cards: the sector panel grew to
  ~350×170 px and, with shield/hull, cargo and wallet stacked under it, ran
  down into the joystick.
- With auto-fire off, the bottom-right row (dial + AUTO + FIRE + BOOST)
  overlapped the joystick.
- The joystick was fixed (nipplejs `static`), so a thumb that landed a little
  off it missed.
- "Auto" vs "manual" fire was shown only by the AUTO button's style.
- Nothing aimed: turrets picked targets, fixed guns fired off the nose.

## Picking a variant

Add `?ui=a`, `?ui=b` or `?ui=c` to the URL once; the choice is remembered in
`localStorage` (`eqxHudVariant`). `?ui=legacy` goes back. Demo helpers:
`?fakeCredits=1` drips wallet changes so the credits animation can be seen,
`?touchviz=1` draws finger dots for videos.

## Shared by all three

- **Floating move stick** (left ~44 % of the screen below the top strip). A
  faint ring rests bottom-left; touch anywhere in the zone and the stick
  appears under your thumb, release and it glides home. If your thumb runs
  past the ring, the ring is dragged along behind it, so reversing is instant.
  Steering is unchanged ("push where you want to face": `joystickToInput`).
- **Sizes follow the screen's short side** (`useHudScale`), not its width.
- **Tiny visuals, big touch areas**: small buttons carry an invisible ≥ 44 px
  hit area (`.eqx-holdbtn::before`).
- **Fonts**: Chakra Petch (labels) and JetBrains Mono (numbers), self-hosted.
  Colours live in `src/client/hud/tokens.ts`.
- **Fire mode colours**: cyan = auto (dim when armed, bright with a spinning
  pip when engaged), amber = manual (you are aiming / holding fire), grey =
  auto off. In the world, a cyan bracket marks the auto-locked target and an
  amber line + crosshair shows a manual aim.
- **Credits** roll like Cyberpunk 2077: a brief chromatic glitch, the changing
  digits scramble then count up, and a `+¢250` / `−¢80` delta floats off.
- **Sector**: one line (`Sol Prime · 3,-2`), tap for sovereignty/region. The
  idle "Nothing incoming" chip is hidden; real warnings still show.
- **Menu**: the speed dial sits top-right and opens downward, away from the
  thumbs.

## The variants

| | A — Corner Clusters | B — Twin-Stick | C — Smart Attack |
|---|---|---|---|
| Right thumb | Big FIRE, always shown. Auto: glows, hold to override. AUTO/MAN pill toggles mode | Floating AIM stick: drag = aim + fire (manual), release = back to auto | Attack button: tap = burst at the auto-lock, press-and-drag = aim + fire |
| Boost | Button left of FIRE | Small button above the aim stick | Satellite left of attack |
| Status | Three hairline bars top-left + credits | Arcs around your ship (Pixi) + tiny numbers | Capsule top-centre (segmented shield/hull ring, energy, credits) |
| Manual aim on touch | No (steer to aim) | Yes | Yes |

## Desktop

Same top layout per variant. Hold **left mouse** to aim at the cursor and fire
(release = back to auto; a quick click still selects), **right mouse** or
Shift = boost, **F** toggles auto, 1–9 pick weapon slots, WASD flies. A chip
bottom-right shows the fire mode.

## Manual aim (netcode)

The `input` message carries an optional `aim` world bearing while you aim. The
same shared helper turns turrets toward it, within their arcs, on the server
(`WeaponMountTicker`) and in client prediction (`tickLocalMountAim`); with no
aim, turrets pick targets as before. Ships with fixed guns turn to face the
aim instead. The `fire` message is unchanged. See the aim commits on the
branch and `tests/unit/manualAimParity.test.ts`.

## Tests

- `src/client/hud/hudPure.test.ts`: stick maths, credits scramble, variant and
  size resolution.
- `tests/e2e/hud-variants.spec.ts`: no HUD controls overlap at 844×390,
  390×844 and 1280×720 for each variant; the floating stick spawns under the
  thumb and glides home; no `?ui` keeps the legacy HUD.

## Videos

`pnpm showcase:hud` records each variant on a landscape phone, a portrait
phone and desktop (`showcase/shots/hudVariants.ts`).

## Not in scope (phase 1)

The drawer, main menu, spectator mode and building keep their current UI; the
fonts and tokens are ready for them later.
