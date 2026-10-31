# Off-screen indicators ("ring radar") — research, diagnosis, target design

> **Status (2026-10-31):** Wave 1 of plan `sparkling-wondering-rose` — the
> researched replacement for the 2026-06 "tuned from first principles" version
> of this doc (which listed a deeper research pass as its open follow-up).
> Sections 1–2 describe the code **as it is today**; sections 3–5 are the
> **target** design that Wave 2 implements. Code: `src/client/render/HaloRadar.ts`
> + `src/client/render/halo/*`.

## 0. Summary

Playtest verdict: icons draw **too close, too big, too opaque**, and they still
appear for things that are visible on screen. The root cause is one design
choice, not bad tuning: **distance is encoded as ring radius**, so the nearest
(most important) contacts are pulled into the middle of the play area, drawn at
the largest size, at constant full opacity. The research consensus is the
opposite: put proxies **at the screen periphery**, use position for
**direction only**, and carry distance on **size + opacity**. Defaults differ
**by device** (touch vs desktop), and every look/which-objects choice becomes a
per-player, per-device, database-persisted setting.

## 1. What the code does today (verified from source)

Pipeline (`HaloRadar.update`, per frame): gather drones/structures from the swarm
mirror + remote ships → drop anything whose **centre point** is inside the
viewport shrunk by a dead-zone → sort nearest-first, cap 64 → 15° wedge grouping
beyond a banded grouping distance → project → spring-smooth → fade-in.

| Constant | Value | Effect |
|---|---|---|
| `INNER_RADIUS_FRAC` / clamp | 0.24·screenMin, 70–240 px | where the NEAREST contacts sit — mid play area |
| `OUTER_RADIUS_FRAC` / clamp | 0.48·screenMin, 160–400 px | where far contacts sit |
| `DIST_MIN` / `DIST_MAX` | 1200 / 7500 u | distance band mapped onto the radius |
| `EXP_CURVE_K` | 12 | saturation: t≈0.78 @2 km, 0.92 @2.5 km, 0.97 @3 km |
| `ARROW_SCALE_NEAR/FAR` | 1.15 / 0.65 | biggest glyph = nearest = innermost |
| `GLYPH_RADIUS` (+grouped) | 7 (9) px; touch ×0.65 | |
| glyph alpha | fill 0.92, stroke 0.85, hostile glow 0.4 (r 11) | **constant** — no distance fade |
| `DEAD_ZONE_PX` | 48 desktop / 28 touch | viewport inset for the on-screen test |
| `RADAR_MAX_DISTANCE` | 10 000 u | hard cutoff (pop-out, no fade) |
| `HALO_APPEAR_FADE_MS` | 160 | only opacity animation |

### Defects

1. **Too close.** Anything nearer than 1200 u clamps to the inner ring at
   70–240 px from the ship — inside the focus region. The radii ignore zoom and
   have no relation to where the screen edge actually is in world units.
2. **Distance is unreadable beyond ~2.5–3 km.** The k=12 curve saturates, so
   everything farther is glued to the outer ring at the same size.
3. **Too big where it matters most.** Size peaks exactly at the innermost ring.
4. **Too opaque.** Opacity never varies with distance (the old doc's table said
   "fade" — only scale was ever implemented).
5. **Visible objects get icons.** The test uses the object's centre point
   against an *inset* rectangle, so an object visible near the edge — or
   partly on screen — keeps its icon.
6. **Worker-isolated store read (desktop).** `HaloRadar` reads `useUIStore`
   directly; on the desktop OffscreenCanvas worker that is a frozen copy
   (`DOCKED`/`pilot`), so the transit-clear and the spectator camera-centred
   ring never run there. (Touch uses the main-thread renderer, so phones never
   had this.) Separately, the main-thread path clears the ring for all of
   SPOOLING — the 30 s window in which drones can attack you.
7. **Not configurable** in any way.

## 2. Research and industry practice

| # | Finding | Source |
|---|---|---|
| R1 | Every studied off-screen technique places its proxy **at the display border**, keeping the focus region free: Halo (arcs reaching in from the border), Wedge (isosceles triangles at the border, more accurate than Halo, esp. in corners), EdgeRadar (compressed border band). The game-industry default is the same: an indicator clamped to the screen edge with a margin. | Baudisch & Rosenholtz, *Halo*, CHI 2003 ([ref](https://bibtex.github.io/CHI-2003-BaudischR.html)); Gustafson, Baudisch, Gutwin & Irani, *Wedge*, CHI 2008 ([ref](https://dx.doi.org/10.1145/1357054.1357179), [slides](https://cs.uwaterloo.ca/~lank/CS889/s20/slides/02.Wedge.pdf)); Gustafson & Irani, *Comparing visualizations for tracking off-screen moving targets*, CHI EA 2007 ([ref](https://hci.cs.umanitoba.ca/Publications/details/comparing-visualizations-for-tracking-off-screen-moving-targets)); [Tuts+ edge indicators](https://code.tutsplus.com/positioning-on-screen-indicators-to-point-to-off-screen-targets--gamedev-6644t) |
| R2 | **Position = direction; distance on a separate channel.** Arrow-style proxies with a distance cue let users order targets by distance faster and more accurately than Halo. | Burigat, Chittaro & Gabrielli, MobileHCI 2006 (summarised in the Wedge paper + the 2017 AR follow-up, [ref](https://unpaywall.org/10.1145%2F3098279.3122124)) |
| R3 | **Clutter is the dominant failure** once several targets are off-screen: overlap must be avoided (Wedge rotates proxies until they stop colliding) and similar-bearing contacts aggregated. | Wedge, CHI 2008 |
| R4 | **Selective display + anti-flicker:** show only relevant classes; when an object repeatedly enters/exits the frame, suppress the re-emphasis (hysteresis on re-entry). | Riot Games patent US12029980, *Selective indication of off-screen object presence* ([ref](https://patents.google.com/patent/US12029980)) |
| R5 | **Per-category, per-player display profiles** are the established pattern for space games with many object classes (EVE: separate bracket profiles from overview profiles, per tab). | EVE Online forums: [brackets](https://forums.eveonline.com/t/brackets/131024), [bracket filtering](https://forums.eveonline.com/t/enabling-icons-for-wrecks-probes-etc-on-screen-but-not-overview/142754) |
| R6 | **Distance perception is compressive (Weber–Fechner):** a log mapping keeps near-range differences legible without saturating far ones. **Perceived size tracks area** (Stevens: exponent ≈0.7) — but our size ramp is an *ordinal* cue (nearer = bigger), not a quantity to be read off, so no proportional-symbol (Flannery) correction is needed; a single shaping exponent suffices. | Stevens' power law ([ref](https://www.cis.rit.edu/people/faculty/montag/vandplite/pages/chap_6/ch6p10.html)); proportional-symbol scaling ([ref](https://en.wikipedia.org/wiki/Proportional_symbol_map)) |
| R7 | **Indicators must not hide under HUD.** On touch, the thumb zones (joystick, fire/boost cluster) and corner chips occlude the screen edge exactly where edge indicators live; the indicator track must avoid them. | Mobile HUD layout practice; this project's slot layout (`src/client/layout/anchors.ts`) |
| R8 | **Legibility + colour-blind safety:** shapes must stay distinguishable at their minimum size, and colour must not be the only cue (red vs amber is a poor pair). | Game accessibility guidance; the existing shape-coded visual language (`entityVisuals.ts`) |

## 3. Target design (objective rules)

1. **Track at the periphery.** Icons sit on a rounded-rectangle track inset from
   the screen edge, at the point where the ray from the **screen centre** to the
   object's projected screen position meets the track (camera-relative — works
   identically in pilot, spectator and during a camera glide).
2. **No icon for anything with any part visible.** Test the object's bounding
   circle against the viewport; hide on any overlap, re-show only once it is
   fully outside by a hysteresis margin.
3. **Distance → size + opacity, never position.**
   `d_off` = world distance from the object to the viewport rectangle
   (point-to-rect, minus its radius — bearing-independent, continuous at
   corners); `t = ln(1 + d_off/d0) / ln(1 + Rv/d0)` clamped to [0,1]; size and
   alpha interpolate near→far by `t^sizeGamma`. Just off-screen always reads as
   "just off-screen", at any zoom.
4. **Fade, don't pop.** Absolute range cutoff `R` from the reference point;
   alpha ramps to 0 over the last `fadeBand` of `R`. Stale entities (no update
   for ~500 ms) are dropped. The interest radius is **not** a cap (out-of-interest
   entities still stream at the decimated rate).
5. **De-overlap along the edge** (sort by perimeter position, push apart to a
   minimum spacing), keep 15° wedge aggregation for far clusters, cap the count,
   priority hostile > player > neutral > structure.
6. **Avoid HUD exclusion zones** measured live from the slot hosts (+ safe area,
   + orientation) and pushed to the renderer; icons slide along the track out of
   them.
7. **Device-aware defaults and settings** (§4) — touch is its own design, not a
   scaled-down desktop.
8. **Categories are radar-only** (hostile, neutral, player, structure, asteroid,
   scrap, lingering); the first four reuse the shared `ENTITY_VISUALS` shapes and
   colours. Off-by-default categories are range-filtered before the sort.

## 4. Defaults

Sizes are CSS px (the renderer's resolution handles device pixel ratio).

| Setting | Desktop | Touch | Rationale |
|---|---|---|---|
| Edge inset | 20 px | 14 px + live HUD exclusions | R1, R7 — a small margin from the edge |
| Icon diameter near → far | 12 → 7 px | 10 → 6 px | R2/R6 ordinal size cue; touch screens are physically small |
| Hostile minimum | 8 px | 7 px | R8 — star shape stays legible |
| Opacity near → far | 0.75 → 0.20 | 0.85 → 0.35 | distance cue; higher floor on touch for outdoor/sunlight readability |
| Glow | hostile only, faint | hostile only, faint | "too opaque" — no glow by default |
| `d0` / `Rv` (log curve) | 500 u / 4000 u | 500 u / 4000 u | R6 — legible near band, unsaturated far band |
| Range `R` / fade band | 10 000 u / 15 % | 10 000 u / 15 % | R3 — fade, don't pop |
| Visibility hysteresis | 16 px | 12 px | R4 |
| Min spacing (de-overlap) | 12 px | 10 px | R3 |
| Max icons | 24 | 12 | R3 — fewer on a small screen |
| Categories on | hostile, player, neutral, structure | hostile, player, structure, neutral | asteroids / scrap / lingering off by default |

These are starting values to be **validated in the `radar-sandbox` room**
(objects at graded distances and bearings incl. corners, drones flying in/out
and across the edge) on a desktop viewport and a touch-emulated phone viewport
(portrait + landscape), then locked in tests. The configuration UI exists for
*customising*, not for finding these.

## 5. Configuration & persistence (Wave 2)

- One zod schema + version + per-device defaults in `src/shared-types/settings/radar.ts`.
- Saved in the server database per **user / player / ship** level and per
  **device class** (`desktop` | `touch`), resolved
  `default[device] → user[device] → player[device] → ship[device]`. A new
  device class starts from its own tuned defaults (never inherits the other
  device's overrides); the modal offers "copy from desktop/mobile".
  Player-level settings rely on the account-bound playerId (PR 3a,
  [player-identity.md](player-identity.md)).
- Live-editing modal (MUI `Dialog`, `xs`): global sliders, per-category
  toggle/shape/colour/size/opacity, reset to this device's defaults, save for
  all ships / this ship.

## 6. Invariants that still apply

- `HaloRadar.update()` is per-RAF → invariant #14: all new helpers allocation-free
  (scalar math + caller-owned scratch; `Camera.toScreenInto` /
  `getVisibleBoundsInto` instead of the allocating variants).
- Decision logic stays pure + unit-locked; Pixi painting stays in
  `arrowGraphics.ts` / `HaloRadar.ts`. Size/alpha go through `scale`/`alpha`;
  a glyph is repainted only on a shape/colour change.
- Nothing under `src/client/render/**` may read the Zustand store — state
  crosses into the renderer via setters / worker messages (the §1 defect 6 class).
- `pixiY = -gameY` for every world→screen projection.
