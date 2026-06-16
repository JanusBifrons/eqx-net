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

/** A placement-preview segment's outcome, mirroring `canConnect`'s result
 *  partition collapsed to what the preview draws. `overflow` (WS-5 R2.17) is a
 *  segment that WOULD connect but is past the `PLACEMENT_MAX_CONNECTIONS` cap. */
export type PreviewLineKind = 'ok' | 'blocked' | 'overflow' | 'skip';

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
  if (kind === 'ok') {
    const width = Math.max(1 / safeScale, 2);
    return {
      color: PREVIEW_OK_COLOR,
      alpha: 0.85,
      width,
      glowAlpha: 0.25,
      glowWidth: width * 3,
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
 * #14). When the edge is NOT carrying flow (`nowMs >= flashUntilMs`) it's a
 * steady idle muted-blue line with NO travelling comet. While it IS flowing
 * (a `grid_pulse` set `flashUntilMs` ahead of now) the wire brightens to
 * mineral + glow AND a travelling comet runs source→dest, both easing back over
 * the last `FLASH_DURATION_MS`. `phaseOffset` ∈ [0,1) desynchronises edges so
 * the grid reads as organic flow, not a global strobe; the comet's source→dest
 * direction is resolved by the renderer via `cometSegment`.
 *
 * Equinox Phase 8 (2026-06-16): reverted the Phase-7 "always-on floored comet"
 * (`f6cba2c`). That fix removed the idle branch + floored `pulseAlpha` so EVERY
 * built edge pulsed — idle connectors must NOT pulse. Idle = steady line, no
 * comet; only an actively-flowing edge shows the travelling pulse (the R2.2
 * design, as it was before Phase 7).
 */
export function connectorVisualInto(
  out: ConnectorVisual,
  flashUntilMs: number,
  nowMs: number,
  scale: number,
  phaseOffset = 0,
): ConnectorVisual {
  const safeScale = scale > 0 ? scale : 1;
  if (nowMs >= flashUntilMs) {
    // IDLE — not carrying flow. Steady muted-blue line, NO comet (the user's
    // Phase-8 fix: idle connectors must not pulse).
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
  // flashProgress 0 (just flashed) → 1 (about to go idle).
  const flashProgress = Math.min(1, Math.max(0, 1 - (flashUntilMs - nowMs) / FLASH_DURATION_MS));
  const width = Math.max(1 / safeScale, 2.5);
  out.color = CONNECTOR_MINERAL_COLOR;
  out.alpha = 0.9 - flashProgress * 0.5;
  out.width = width;
  out.glowAlpha = (1 - flashProgress) * 0.3;
  out.glowWidth = width * 3;
  // Travelling comet — continuous client phase clock; dims as the flow stops
  // (flashProgress → 1 in the window's last FLASH_DURATION_MS).
  out.pulseActive = true;
  out.pulseT = fract(nowMs / CONNECTOR_PULSE_PERIOD_MS + phaseOffset);
  out.pulseColor = CONNECTOR_FLOW_PULSE_COLOR;
  out.pulseAlpha = 0.95 * (1 - flashProgress);
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
