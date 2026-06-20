/**
 * Pure visual-params for a grid connection segment (speed-dial-resource-
 * structures plan, Phase 3). Base model ported from eqx-peri's
 * `ConnectionRenderer`: an idle muted-blue line that brightens (alpha/width
 * pulse + glow) when it carried flow this pulse, fading over `FLASH_DURATION_MS`.
 * eqx-net adds a directional travelling comet (R2.2) shown ONLY while the edge
 * is actively flowing — idle connectors are a steady muted line with NO comet
 * (see `connectorVisualInto`).
 *
 * Zone-pure (no Pixi import) so the maths is unit-testable; the Graphics drawing
 * lives in `ConnectorRenderer.ts`.
 */
import { FLASH_DURATION_MS } from '../../../core/structures/structureGridConstants.js';

/** Idle (non-flowing) line tint — muted blue. */
export const CONNECTOR_IDLE_COLOR = 0x4488aa;
/** Mineral-flow tint (the single Phase-3 flow material). */
export const CONNECTOR_MINERAL_COLOR = 0xee8844;
/** Power-flow tint (reserved — power is aggregated, not flashed, in Phase 3). */
export const CONNECTOR_POWER_COLOR = 0x44ddff;
/** R2.2 — the travelling flow-pulse "packet" tint: a bright warm gold, distinct
 *  from both the idle wire and the mineral brighten so it reads as a moving
 *  energy packet, not just a brighter line. */
export const CONNECTOR_FLOW_PULSE_COLOR = 0xffe08a;
/** R2.2 — flow-pulse traversal period (ms): one packet crosses an edge in
 *  ~0.85 s (a touch faster than the 1 Hz grid pulse so the flow reads lively). */
export const CONNECTOR_PULSE_PERIOD_MS = 850;
/** Equinox Phase 8 — how long PAST `flashUntilMs` an edge stays "active" (comet
 *  on). A flowing edge is re-pulsed every `TRANSFER_PULSE_MS` (1 s) and its
 *  `flashUntilMs` is set 1 s ahead on each pulse; this grace beyond it bridges
 *  network jitter so a continuously-flowing edge's comet never flickers off
 *  between pulses. Once flow stops + the grace elapses, the edge goes idle
 *  (steady line, no comet). Module-local — only `connectorVisualInto` uses it. */
const FLOW_ACTIVE_GRACE_MS = 600;

export interface ConnectorVisual {
  color: number;
  alpha: number;
  width: number;
  /** Glow overlay alpha (0 ⇒ no glow). */
  glowAlpha: number;
  /** Glow overlay width. */
  glowWidth: number;
  // ── R2.2 directional flow pulse (only set by `connectorVisualInto`) ───────
  /** Draw the travelling comet this frame? (false on idle / preview lines). */
  pulseActive?: boolean;
  /** Comet phase position [0,1) along the client-local pulse clock (the renderer
   *  maps it onto SOURCE→DEST). */
  pulseT?: number;
  pulseColor?: number;
  pulseAlpha?: number;
  pulseWidth?: number;
  /** WS-D (#6) — a DOTTED-line dash pattern (world units), set ONLY on the
   *  'deferred' placement-preview class (could-but-won't connect). Pixi v8 has no
   *  native dashed stroke, so the renderer walks the segment emitting `on`-length
   *  dashes separated by `off`-length gaps. Absent (or `on <= 0`) ⇒ a solid line. */
  dash?: { on: number; off: number };
}

/** Comet segment endpoints (reused-into scratch — the renderer holds one). */
export interface CometSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Preview-line tints for the placement connection preview (Item C / WS-5
 *  R2.17). Green ⇒ the ghost WOULD connect here on placement; dim red ⇒ in range
 *  but the line of sight is blocked (asteroid / structure on the segment);
 *  bright red ⇒ would connect but is past the placement connection cap (overflow
 *  — the link will NOT form). Out-of-range segments are not drawn at all
 *  (skipped), so they need no colour. */
export const PREVIEW_OK_COLOR = 0x66ff88;
export const PREVIEW_BLOCKED_COLOR = 0xcc4444;
/** WS-5 (R2.17) — over-cap "would-connect" overflow. A saturated red, distinct
 *  from the dim LOS-blocked red, so the player reads "in range + legal but the
 *  cap is full, this one won't link". */
export const PREVIEW_OVERFLOW_COLOR = 0xff4422;
/** WS-D (#6) — the DOTTED-green "deferred" tint: an in-range, legal pairing that
 *  lost the multi-connect cap race (could-but-won't connect). A softer/cooler
 *  green than the solid `ok`/`selected` so the dotted line reads as "available
 *  but not chosen", NOT as an error (the old over-cap RED read as a problem). */
export const PREVIEW_DEFERRED_COLOR = 0x88ddaa;

/** WS-D (#6) — a 'deferred' dotted line's dash pattern (world units at scale 1):
 *  6 u on, 5 u off. Scaled by 1/zoom in `previewLineVisualParams` so the dotting
 *  density stays ~constant on screen (same idiom as the scale-aware line width). */
const PREVIEW_DASH_ON = 6;
const PREVIEW_DASH_OFF = 5;

/** A placement-preview segment's outcome, mirroring `canConnect`'s result
 *  partition collapsed to what the preview draws. `overflow` (WS-5 R2.17) is a
 *  segment that WOULD connect but is past the `PLACEMENT_MAX_CONNECTIONS` cap.
 *  WS-D (#6) restyles the would-connect partition into `selected` (SOLID green,
 *  the hub that WILL connect) vs `deferred` (DOTTED green, could-but-won't past
 *  the cap) — `ok`/`overflow` are kept as aliases for back-compat. */
export type PreviewLineKind =
  | 'ok'
  | 'selected'
  | 'deferred'
  | 'blocked'
  | 'overflow'
  | 'skip';

/**
 * Pure visual params for ONE placement-preview segment (ghost → existing
 * structure). Mirrors `connectorVisualParams` (scale-aware line width) but keyed
 * off the `canConnect` outcome rather than a flash window:
 *   - `ok`       → solid green (would connect, counted)
 *   - `blocked`  → dim red (in range, LOS blocked)
 *   - `overflow` → bright red (would connect but past the 6 cap — won't link)
 *   - `skip`     → alpha 0 (caller should not draw — out of range / ineligible)
 */
export function previewLineVisualParams(kind: PreviewLineKind, scale: number): ConnectorVisual {
  const safeScale = scale > 0 ? scale : 1;
  // WS-D (#6) — 'selected' is the restyle name for the chosen hub; keep 'ok' as
  // the back-compat alias (both = the SOLID green that WILL connect).
  if (kind === 'ok' || kind === 'selected') {
    const width = Math.max(1 / safeScale, 2);
    return {
      color: PREVIEW_OK_COLOR,
      alpha: 0.85,
      width,
      glowAlpha: 0.25,
      glowWidth: width * 3,
    };
  }
  if (kind === 'deferred') {
    // DOTTED green — in-range + legal but past the multi-connect cap (won't
    // link). A softer green than the solid selected line + a dash pattern (Pixi
    // v8 has no native dash → the renderer walks the segment). No glow: a dotted
    // glow smears into a solid line, defeating the dotting.
    const width = Math.max(1 / safeScale, 2);
    return {
      color: PREVIEW_DEFERRED_COLOR,
      alpha: 0.7,
      width,
      glowAlpha: 0,
      glowWidth: 0,
      dash: { on: PREVIEW_DASH_ON / safeScale, off: PREVIEW_DASH_OFF / safeScale },
    };
  }
  if (kind === 'overflow') {
    // Same weight as `ok` (it's a real, in-range, legal pairing) but red + a
    // fainter glow so it reads as "denied by the cap", not "would connect".
    const width = Math.max(1 / safeScale, 2);
    return {
      color: PREVIEW_OVERFLOW_COLOR,
      alpha: 0.6,
      width,
      glowAlpha: 0.18,
      glowWidth: width * 2.5,
    };
  }
  if (kind === 'blocked') {
    return {
      color: PREVIEW_BLOCKED_COLOR,
      alpha: 0.4,
      width: Math.max(1 / safeScale, 1),
      glowAlpha: 0,
      glowWidth: 0,
    };
  }
  // skip — not drawn.
  return { color: PREVIEW_OK_COLOR, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 };
}

// ── WS-10 (R2.3) — placement connection-RANGE ring ──────────────────────────
/** The ghost's connection-range ring tint — a soft cyan, dimmer + cooler than
 *  the green `ok` preview lines so it reads as "reach", not "would connect". */
export const RANGE_CIRCLE_COLOR = 0x66bbdd;

/** Pure visual params for the placement connection-range ring (R2.3) — the faint
 *  circle around the blueprint ghost showing how far it can connect. Colour +
 *  alpha are constant; the line stays ~1 screen-px by dividing by zoom (same
 *  scale-aware width idiom as the connector/preview lines). The RADIUS is
 *  geometry (per-kind `connectionRange` + ghost radius) and lives in the
 *  renderer, NOT here. */
export function rangeCircleVisualParams(scale: number): {
  color: number;
  alpha: number;
  width: number;
} {
  const safeScale = scale > 0 ? scale : 1;
  return { color: RANGE_CIRCLE_COLOR, alpha: 0.22, width: Math.max(1 / safeScale, 1) };
}

/** Positive fractional part (`x - floor(x)`, always in [0,1)). */
function fract(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

/**
 * Visual params for a connection given its flash window — written INTO `out`
 * (no allocation; the renderer hot path holds one scratch struct, invariant
 * #14).
 *
 * - **IDLE** — never flowed (`flashUntilMs <= 0` sentinel) OR the last flow
 *   pulse + `FLOW_ACTIVE_GRACE_MS` has elapsed: a steady muted-blue line with
 *   NO travelling comet. Idle connectors must NOT pulse.
 * - **ACTIVE** (carrying flow) — the wire is mineral-tinted + glowing and a
 *   travelling comet runs source→dest (`phaseOffset` ∈ [0,1) desynchronises
 *   edges so the grid reads as organic flow, not a global strobe; direction is
 *   resolved by the renderer via `cometSegment`). Each `grid_pulse` gives a 1 Hz
 *   brighten "beat" easing over `FLASH_DURATION_MS`, but the line + comet are
 *   FLOORED so they NEVER fade out between cycles.
 *
 * Equinox history: the R2.2 pulse faded the comet to 0 over the last 300 ms of
 * every 1 s cycle ("fade out between cycles"); Phase 7 (`f6cba2c`) over-
 * corrected by flooring the comet ALWAYS — so idle connectors pulsed too.
 * Phase 8 splits the two: idle = no comet; active = a floored 1 Hz beat that
 * never fades out. The grace bridges grid-pulse jitter so a continuously-
 * flowing edge's comet doesn't flicker off at the cycle boundary.
 */
export function connectorVisualInto(
  out: ConnectorVisual,
  flashUntilMs: number,
  nowMs: number,
  scale: number,
  phaseOffset = 0,
): ConnectorVisual {
  const safeScale = scale > 0 ? scale : 1;
  if (flashUntilMs <= 0 || nowMs >= flashUntilMs + FLOW_ACTIVE_GRACE_MS) {
    // IDLE — never flowed, or flow stopped + grace elapsed. Steady muted-blue
    // line, NO travelling comet (Phase-8: idle connectors must not pulse).
    out.color = CONNECTOR_IDLE_COLOR;
    out.alpha = 0.3;
    out.width = Math.max(1 / safeScale, 1);
    out.glowAlpha = 0;
    out.glowWidth = 0;
    out.pulseActive = false;
    out.pulseT = 0;
    out.pulseColor = CONNECTOR_FLOW_PULSE_COLOR;
    out.pulseAlpha = 0;
    out.pulseWidth = 0;
    return out;
  }
  // ACTIVE (carrying flow). `beat` is the 1 Hz brighten: 1 just after a pulse,
  // easing to 0 over FLASH_DURATION_MS (and 0 through the post-flow grace). The
  // line + comet are FLOORED so they never fade out between cycles — only the
  // brightness beats. `pulseT` advances continuously = direction-of-flow cue.
  const flashProgress = Math.min(1, Math.max(0, 1 - (flashUntilMs - nowMs) / FLASH_DURATION_MS));
  const beat = 1 - flashProgress;
  const width = Math.max(1 / safeScale, 2.5);
  out.color = CONNECTOR_MINERAL_COLOR;
  out.alpha = 0.6 + 0.3 * beat; // 0.6 floor → 0.9 on the beat
  out.width = width;
  out.glowAlpha = 0.15 + 0.15 * beat; // 0.15 floor → 0.30 on the beat
  out.glowWidth = width * 3;
  out.pulseActive = true;
  out.pulseT = fract(nowMs / CONNECTOR_PULSE_PERIOD_MS + phaseOffset);
  out.pulseColor = CONNECTOR_FLOW_PULSE_COLOR;
  out.pulseAlpha = 0.55 + 0.4 * beat; // 0.55 floor → 0.95 on the beat (never 0 while flowing)
  out.pulseWidth = Math.max(2 / safeScale, 3.5);
  return out;
}

/**
 * Allocating wrapper for `connectorVisualInto` — returns a fresh struct. Used by
 * tests and any non-hot caller; the per-frame renderer path uses
 * `connectorVisualInto` with a reused scratch.
 */
export function connectorVisualParams(
  flashUntilMs: number,
  nowMs: number,
  scale: number,
): ConnectorVisual {
  return connectorVisualInto(
    { color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 },
    flashUntilMs,
    nowMs,
    scale,
  );
}

/** Comet "packet" half-length in screen pixels (kept ~constant on screen by
 *  dividing by zoom). */
const COMET_HALF_PX = 12;

/**
 * R2.2 — the travelling-comet segment endpoints along an edge, written INTO
 * `out` (no allocation). `t` is the pulse phase [0,1); `sourceIsLo` is whether
 * the lower-id endpoint `(ax,ay)` is the flow SOURCE — when true the comet runs
 * a→b as phase 0→1, otherwise it runs b→a (so it ALWAYS travels source→dest,
 * the visible direction cue). Coords are in whatever space the caller passes
 * (the renderer passes Pixi-space, already Y-negated) — pure linear interp, so
 * the space is irrelevant. The segment is clamped to the edge at the ends.
 */
export function cometSegment(
  out: CometSegment,
  t: number,
  sourceIsLo: boolean,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  scale: number,
): CometSegment {
  const tt = sourceIsLo ? t : 1 - t;
  const dx = bx - ax;
  const dy = by - ay;
  const edgeLen = Math.hypot(dx, dy);
  const safeScale = scale > 0 ? scale : 1;
  const dt = edgeLen > 0.001 ? Math.min(0.45, Math.max(COMET_HALF_PX / safeScale, COMET_HALF_PX) / edgeLen) : 0;
  const t0 = Math.max(0, tt - dt);
  const t1 = Math.min(1, tt + dt);
  out.x0 = ax + dx * t0;
  out.y0 = ay + dy * t0;
  out.x1 = ax + dx * t1;
  out.y1 = ay + dy * t1;
  return out;
}

// ── R2.19 — shield-wall visuals (make it read as an energy BARRIER, not a wire)
/** Cyan-white shield-wall core — deliberately OUTSIDE the connector palette
 *  (idle 0x4488aa / mineral 0xee8844 / flow-pulse gold 0xffe08a) so the wall is
 *  never confused with a connector link (R2.19). */
export const SHIELD_WALL_CORE_COLOR = 0x99eeff;
/** Saturated cyan field-glow behind the rails. */
export const SHIELD_WALL_GLOW_COLOR = 0x33ccff;
/** Near-white travelling shimmer (the "live energy" sweep). */
export const SHIELD_WALL_SHIMMER_COLOR = 0xeaffff;
/** Down (stunned / unpowered) wall — a dim flickering red line ships pass. */
export const SHIELD_WALL_DOWN_COLOR = 0x664444;
/** Shimmer sweep period (ms). */
export const SHIELD_WALL_SHIMMER_PERIOD_MS = 1200;

export interface ShieldWallVisual {
  active: boolean;
  glowColor: number;
  glowAlpha: number;
  glowWidth: number;
  railColor: number;
  railAlpha: number;
  railWidth: number;
  /** Perpendicular half-offset (world units) of the two band rails from the
   *  centreline — 0 ⇒ a single centre line (the down state). The band slab is
   *  what reads as an area BARRIER rather than a 1-D wire. */
  halfThickness: number;
  /** Travelling shimmer phase [0,1) along the span (active only). */
  shimmerT: number;
  shimmerColor: number;
  shimmerAlpha: number;
  shimmerWidth: number;
}

/**
 * R2.19 — pure visual params for the shield wall, written INTO `out` (no alloc).
 * ACTIVE: a translucent cyan-white energy BARRIER — a glow field + two parallel
 * rails offset along the span normal (the renderer applies `halfThickness`) +
 * an animated shimmer sweeping the span. DOWN: the existing dim red flicker (a
 * single line, `halfThickness = 0`) ships can pass. The hue + the band geometry
 * + the shimmer together make it unmistakable next to a thin connector link.
 */
export function shieldWallVisualParams(
  out: ShieldWallVisual,
  active: boolean,
  nowMs: number,
  scale: number,
): ShieldWallVisual {
  const safeScale = scale > 0 ? scale : 1;
  const w = Math.max(2 / safeScale, 6);
  if (active) {
    out.active = true;
    out.glowColor = SHIELD_WALL_GLOW_COLOR;
    // Slow "breathing" of the field so an idle-but-up wall still reads as live.
    out.glowAlpha = 0.16 + 0.06 * Math.sin(nowMs * 0.004);
    out.glowWidth = w * 3.5;
    out.railColor = SHIELD_WALL_CORE_COLOR;
    out.railAlpha = 0.85;
    out.railWidth = Math.max(1.5 / safeScale, 2.5);
    out.halfThickness = w * 0.9;
    out.shimmerT = fract(nowMs / SHIELD_WALL_SHIMMER_PERIOD_MS);
    out.shimmerColor = SHIELD_WALL_SHIMMER_COLOR;
    out.shimmerAlpha = 0.9;
    out.shimmerWidth = w * 0.6;
    return out;
  }
  out.active = false;
  out.glowColor = SHIELD_WALL_DOWN_COLOR;
  out.glowAlpha = 0;
  out.glowWidth = 0;
  out.railColor = SHIELD_WALL_DOWN_COLOR;
  out.railAlpha = Math.sin(nowMs * 0.01) * 0.12 + 0.18; // dim red flicker
  out.railWidth = w;
  out.halfThickness = 0; // single line, not a band
  out.shimmerT = 0;
  out.shimmerColor = SHIELD_WALL_DOWN_COLOR;
  out.shimmerAlpha = 0;
  out.shimmerWidth = 0;
  return out;
}
