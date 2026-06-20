# Off-screen indicators (the halo ring / edge arrows)

> Equinox Phase 3, WS-B. Companion to `src/client/render/HaloRadar.ts` and the
> pure helpers under `src/client/render/halo/` (`projection.ts`,
> `wedgeGrouping.ts`, `arrowGraphics.ts`, `visibility.ts`).
>
> **Status:** the constants below were tuned to sensible industry-standard
> values from first principles + general game-UI practice. A deeper
> `/deep-research` pass (with cited primary sources) is a **follow-up** — see
> "Open follow-up" at the end.

## What the feature is

EQX Peri renders a **halo ring** of glyphs around the player's ship that points
at off-screen points-of-interest (hostile drones ★, neutral drones ◆, remote
player ships ▲, structures ⬢). It is the standard "off-screen target
indicator" pattern: when a relevant entity is outside the viewport, a marker
sits on a ring (or screen edge) at the bearing toward it, so the player knows
*what* is out there and *which way* to turn. Asteroids, scrap and lingering
hulls are deliberately excluded — the ring shows threats and bases, not
clutter.

This doc captures the design constants and the **industry standards they were
tuned against** so future tuning has a baseline rather than re-deriving the
numbers each time.

## Industry standards for off-screen indicators

These are the recurring conventions across action / space / shooter games and
game-UX writing. They are the rationale behind the EQX constants; treat them as
a baseline, not gospel.

### 1. Clustering / aggregation thresholds

A naive "one marker per entity" indicator becomes unreadable the moment more
than a handful of entities are off-screen — a swarm of 50 drones produces 50
overlapping arrows. Every mature implementation **aggregates**:

- **Angular bucketing (wedges).** Divide the ring into angular sectors and show
  *one* representative marker per occupied sector, often with a count badge.
  Sector sizes in the wild cluster around **10°–20°** (so ~18–36 buckets around
  a full ring). EQX uses **15° → 24 wedges** (`RADAR_WEDGE_DEG`).
- **Proximity / distance-banded grouping.** Whether two entities "count as one"
  should depend on how far away the *cluster* is: two ships 200 u apart read as
  two distinct contacts when they're right next to you, but as a single blob
  when they're 8 km away (their angular separation collapses). The standard is
  a **grouping radius that scales with distance** — tighter when the action is
  close, looser when it's far. EQX bands the grouping distance from **250 u**
  (closest) up to **2000 u** (far) via `groupingDistanceForBand(closestDist)`.
- **A hard cap on simultaneous markers.** Even after grouping, cap the total
  (commonly **~8 on consoles, up to a few dozen on a big screen**) and drop the
  farthest. EQX caps at **`MAX_ARROWS = 64`**, closest-first.

### 2. Dead-zone / hysteresis band (anti-flicker)

A contact hovering *exactly* on the viewport boundary will, frame to frame,
jitter just inside then just outside the edge — making its indicator **flicker
on and off**. The universal fix is a **hysteresis band** (a "dead zone"): the
rectangle used for the "is it on screen?" test is **inset from the true
viewport edge by a fixed margin**, so a contact has to clearly cross *into* the
inset region before its indicator is suppressed, and clearly cross *out* before
it returns. Practical inset widths are around **3–6% of the shorter screen
dimension** (roughly **30–60 px** on a desktop, smaller on a phone). EQX uses
**`DEAD_ZONE_PX_DESKTOP = 48`** and **`DEAD_ZONE_PX_MOBILE = 28`**
(`getVisibleBoundsWithDeadZone`).

> A subtler variant uses *two* thresholds (a wider "appear" boundary and a
> narrower "disappear" boundary). EQX uses a single inset band, which is the
> simplest form of the same idea and sufficient for the observed flicker.

### 3. On-screen suppression — exclude at candidate-build, not via a timer

An entity that is **already visible on screen** needs no off-screen indicator;
showing one is redundant and (worse) produces a "pop in → zoom → vanish"
artefact when the suppression is driven by a *timer* (the indicator appears,
animates, then a half-second later realises the entity is on screen and hides).
The standard is to **exclude on-screen entities at the moment you build the
indicator candidate list**, purely from current geometry — never on a delay.
EQX does this in `HaloRadar.update` via the pure `isEntityOnScreen` test against
the dead-zone-inset bounds, replacing the old `ON_SCREEN_HIDE_MS = 500` timer.

### 4. Fade-in / distance ramp

Indicators commonly **scale and/or fade with distance** so a glanceable sense
of range is conveyed: closer contacts read as larger / more urgent, distant
ones as smaller / quieter dots that sit at the outer ring. A non-linear
(exponential-saturation) ramp is common so the "reactive" band sits at
realistic engagement range and far contacts are simply glued to the edge. EQX
uses a `1 - exp(-k·t)` curve (`projection.ts`, `EXP_CURVE_K = 12`) mapping
world distance `[DIST_MIN, DIST_MAX]` to the ring radius `[inner, outer]` and a
near→far arrow scale `[1.15, 0.65]`.

### 5. Mobile vs desktop

Phones have **less screen area, smaller absolute glyphs, and thumb-occluded
corners**. Standard adaptations:

- **Smaller indicator glyphs** (a marker sized for a 27" monitor is oversized
  on a 6" phone). EQX scales the glyph radius to **~0.65×** on touch
  (`HALO_GLYPH_TOUCH_SCALE`, `haloGlyphRadius(grouped, isTouch)`), keeping the
  touch glyph 60–70% of desktop.
- **A tighter dead-zone band** (a 48 px band is a larger *fraction* of a phone
  screen than of a monitor). EQX: 28 px on mobile vs 48 px on desktop.
- Keeping indicators clear of thumb / HUD zones — handled by EQX's ring radius
  fractions (`INNER/OUTER_RADIUS_FRAC` against the shorter screen dimension)
  rather than this WS.

## How the EQX constants map to the standards

| Standard | EQX constant | Value | File |
|---|---|---|---|
| Angular wedge size | `RADAR_WEDGE_DEG` / `RADAR_WEDGE_COUNT` | 15° / 24 | `halo/wedgeGrouping.ts` |
| Distance-banded grouping | `groupingDistanceForBand` (`MIN`→`MAX` over `RAMP`) | 250 → 2000 u over 6000 u | `halo/wedgeGrouping.ts` |
| Max simultaneous markers | `MAX_ARROWS` | 64 | `HaloRadar.ts` |
| Dead-zone band (desktop) | `DEAD_ZONE_PX_DESKTOP` | 48 px | `halo/visibility.ts` |
| Dead-zone band (mobile) | `DEAD_ZONE_PX_MOBILE` | 28 px | `halo/visibility.ts` |
| On-screen suppression | `isEntityOnScreen` at candidate-build | — | `halo/visibility.ts` |
| Distance fade/scale ramp | `EXP_CURVE_K`, `ARROW_SCALE_NEAR/FAR` | 12, 1.15/0.65 | `halo/projection.ts` |
| Mobile glyph scale | `HALO_GLYPH_TOUCH_SCALE` | 0.65 | `halo/arrowGraphics.ts` |

## Invariants

- `HaloRadar.update()` runs per-RAF → **invariant #14**: every helper added
  here is allocation-free (scalar math + caller-owned scratch). `isEntityOnScreen`
  and `getVisibleBoundsWithDeadZone` take a reused `out` rect; the banded
  grouping distance is a scalar.
- All decision logic is **pure + unit-locked** (`bandedGrouping.test.ts`,
  `visibility.test.ts`, `arrowGraphics.radiusScale.test.ts`) — the Pixi
  painting stays in `arrowGraphics.ts` / `HaloRadar.ts`, the branching is pure
  (per the Phase A3 "renderer decision logic extraction" rule).
- The dead-zone test flips game-space Y → Pixi Y (`pixiY = -gameY`) before the
  bounds comparison — the `pixiY = -gameY` convention every renderer site obeys.

## Open follow-up

A deeper **`/deep-research`** pass with cited primary sources (specific game UX
case studies, accessibility guidance on edge-indicator flicker, measured
dead-zone widths from shipped titles) is a follow-up. The constants above are
tuned to sensible standard values from general practice; the research pass would
let us cite and, if warranted, re-tune them with evidence.
