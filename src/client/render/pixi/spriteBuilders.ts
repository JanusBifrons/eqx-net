/**
 * Pure Pixi `Graphics` builders for ship / drone / asteroid / projectile
 * / beam / explosion silhouettes. Extracted from the monolithic
 * `PixiRenderer.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 14).
 *
 * All builders construct a fresh `Graphics` and return it — no `this`
 * state, no caller-side side effects, no scene-graph membership. The
 * orchestrator decides where each goes. Constants are local to this
 * module; the orchestrator imports the SHIP_HITBOX_RADIUS /
 * HITBOX_COLOR / DAMAGE_FLASH_COLOR / SERVER_GHOST_COLOR via re-export.
 */

import { Graphics, Text, TextStyle } from 'pixi.js';
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { shipScrapGroups } from '@core/geometry/shipScrapGroups';
import { shipShapeScale } from '@core/geometry/shipHullOutline';
import {
  getShipKind,
  type ShipShape,
  type ShipCompositeShape,
  type ShipPart,
  type WeaponMount,
} from '../../../shared-types/shipKinds.js';
import { getStructureKind, structureHullPoints } from '../../../shared-types/structureKinds.js';

export const SHIP_HITBOX_RADIUS = 12; // must match World.ts SHIP_RADIUS
export const HITBOX_COLOR = 0xff0066;
export const SERVER_GHOST_COLOR = 0xff4400;
const ASTEROID_COLOR = 0x886644;
const ASTEROID_OUTLINE = 0xbb9966;
const DRONE_FILL_COLOR = 0xff3366;
const DRONE_OUTLINE_COLOR = 0xffaacc;
const DRONE_CORE_COLOR = 0xffeeaa;
const PROJECTILE_COLOR = 0xffdd44;
const GHOST_PROJECTILE_COLOR = 0xff8800;
const LASER_BEAM_COLOR = 0x00eeff;
const LASER_CORE_COLOR = 0xffffff;
const LASER_BOLT_OUTER = 0xff2244;
const LASER_BOLT_CORE = 0xffffff;
// Soft pink tint — multiplied with each ship's base colour, this gives a
// legible "I just got hit" flash without crushing the green/blue hull tone.
// (0xff2222 was the original but tinted local-ship green nearly black.)
export const DAMAGE_FLASH_COLOR = 0xffaaaa;

/**
 * Convert a `ShipShape` from the catalogue into a Pixi `Graphics`. The polygon
 * is drawn from the shape's points (entity-local space, nose at -y, tail at
 * +y) scaled by `shape.scale`. `tintOverride` lets the caller apply the
 * legacy "local = green, remote = blue" colour scheme on top of the kind's
 * native colour (the local tint is applied as a fill colour override; the
 * kind colour is used otherwise so all three kinds remain visually distinct).
 *
 * The dashed hitbox circle stays kind-agnostic — it always traces the
 * collider radius, which the catalogue keeps in sync with the polygon's
 * visual extent so collisions feel honest.
 */
export function buildShipGfxFromShape(shape: ShipShape, tintOverride?: number): Graphics {
  // Composite ships (multi-part silhouette over one gross collision hull) take
  // a dedicated build path; everything else is the legacy single polygon.
  if (shape.kind === 'composite') return buildCompositeShipGfx(shape, tintOverride);
  const g = new Graphics();
  const scale = shape.scale;
  g.poly(shape.points.map(([x, y]) => ({ x: x * scale, y: y * scale })));
  g.fill({ color: tintOverride ?? shape.color });
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

/**
 * Pure per-part point transform — the `{x:(px+offsetX)*scale, y:(py+offsetY)*scale}`
 * mapping a composite part's local points go through before they hit
 * `Graphics.poly`. Extracted (like `spriteUpdateDecisions.ts`) so the geometry
 * is unit-testable without constructing a Pixi `Graphics` (not node-constructible).
 *
 * Same no-Y-flip convention as the polygon branch — the sprite transform owns
 * the world Y-flip (`sprite.y = -ship.y`), so the builder draws in catalogue
 * (Pixi-up) local space directly.
 */
export function transformCompositePartPoints(
  part: ShipPart,
  scale: number,
): Array<{ x: number; y: number }> {
  return part.points.map(([px, py]) => ({
    x: (px + part.offsetX) * scale,
    y: (py + part.offsetY) * scale,
  }));
}

/**
 * Build a composite ship's `Graphics` — ONE Graphics, one `poly`/`fill`(/`stroke`)
 * per part (drawn in part order so later parts layer on top), then the shared
 * dashed hitbox circle once at the end. `tintOverride` replaces every part's
 * fill colour exactly like the polygon branch's tint (local = green, etc.).
 *
 * The parts are drawn in catalogue (Pixi-up) local space at `shape.scale`; the
 * sprite transform handles the world Y-flip (same convention as the polygon
 * branch). Per-part `stroke` (with `strokeWidth ?? 1`) is drawn after the fill
 * when present.
 */
export function buildCompositeShipGfx(shape: ShipCompositeShape, tintOverride?: number): Graphics {
  const g = new Graphics();
  const scale = shape.scale;
  for (const part of shape.parts) {
    const pts = transformCompositePartPoints(part, scale);
    g.poly(pts);
    g.fill({ color: tintOverride ?? part.color });
    if (part.stroke != null) {
      g.poly(pts);
      g.stroke({ color: part.stroke, width: part.strokeWidth ?? 1 });
    }
  }
  // Shared dashed hitbox circle once at the end (same as the polygon path).
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

/** Resolve `ShipRenderState.kind` to a concrete shape, with fallback. */
export function shapeForKind(kindId: string | undefined): ShipShape {
  return getShipKind(kindId).shape;
}

// The legacy triangle thrust/boost flames were REMOVED by the engine-fx pass
// (plan `majestic-pie`, particle-only decision). The `EngineEmitter` particle
// plume is now the sole engine visual at every quality tier (the `minimal`
// tier emits a sparse plume rather than falling back to a flame). See
// `src/client/effects/perEffect/EngineEmitter.ts`.

export function buildAsteroidGfx(entityId: number, radius: number): Graphics {
  const g = new Graphics();
  // Same generator the server uses to build the convex-hull collider — both
  // sides seed from the same entityId, so the rendered silhouette matches the
  // physics shape exactly. Vertices are emitted in math-space (Y-up); the
  // sprite is rendered in Pixi screen space (Y-down) and rotated by `-angle`.
  // For symmetric polygons (ship/drone) the y-flip is invisible, but an
  // asymmetric polygon mismatches its collision hull as it rotates unless
  // every vertex's y is negated for drawing only.
  const mathVerts = generateAsteroidVertices(entityId, radius);
  const screenVerts = mathVerts.map((v) => ({ x: v.x, y: -v.y }));
  g.poly(screenVerts);
  g.fill({ color: ASTEROID_COLOR });
  g.poly(screenVerts);
  g.stroke({ color: ASTEROID_OUTLINE, width: 1.5 });
  return g;
}

/**
 * Scrap visual (pose-core kind 3): one composite COMPONENT broken off a dying
 * ship. Renders that component's recentred sub-shapes (silhouette + details)
 * from `shipScrapGroups(parentKind)[componentIndex]`, scaled by the parent's
 * `shape.scale`, in Pixi-up local space (the sprite transform handles the world
 * Y-flip, same convention as `buildCompositeShipGfx`). The piece keeps its part
 * colours so a destroyed ship visibly comes apart into its own pieces. Falls
 * back to a small grey chunk if the parent kind / component is unknown.
 */
export function buildScrapGfx(
  parentKindId: string | undefined,
  componentIndex: number,
): Graphics {
  const g = new Graphics();
  const group = shipScrapGroups(parentKindId)[componentIndex];
  if (!group) {
    g.poly([
      { x: -4, y: -4 },
      { x: 4, y: -4 },
      { x: 4, y: 4 },
      { x: -4, y: 4 },
    ]);
    g.fill({ color: 0x777777 });
    return g;
  }
  const scale = shipShapeScale(getShipKind(parentKindId));
  for (const part of group.parts) {
    const pts = part.points.map(([x, y]) => ({ x: x * scale, y: y * scale }));
    g.poly(pts);
    g.fill({ color: part.color });
    if (part.stroke != null) {
      g.poly(pts);
      g.stroke({ color: part.stroke, width: part.strokeWidth ?? 1 });
    }
  }
  return g;
}

/**
 * Drone visual — angular dart pointing along the body's forward direction
 * (`(-sin θ, cos θ)` per the World forward convention; renderer rotates by
 * `-angle` so the dart's local +y nose maps to world forward). Distinct
 * magenta-pink so drones never read as asteroids.
 */
export function buildDroneGfx(radius: number): Graphics {
  const g = new Graphics();
  // Outer dart silhouette, nose pointing local up (-y in pixi).
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.fill({ color: DRONE_FILL_COLOR });
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.stroke({ color: DRONE_OUTLINE_COLOR, width: 1.5 });
  // Glowing core dot so they remain visible at small radii.
  g.circle(0, 0, Math.max(2, radius * 0.25));
  g.fill({ color: DRONE_CORE_COLOR });
  return g;
}

/**
 * The structure silhouette's RENDER vertices — `structureHullPoints` (the
 * game-space, Y-up collider source) converted to Pixi space via the standard
 * `pixiY = -gameY` flip EVERY entity obeys (ships included). **Load-bearing for
 * ODD-sided structures** (turret = 3, miner = 5, shield_pylon = 7): a regular
 * polygon is NOT Y-flip-invariant unless its side-count is even, so drawing the
 * collider points DIRECTLY (the old `buildStructureGfx`, no flip) rendered the
 * triangle turret + pentagon miner UPSIDE-DOWN relative to their colliders —
 * R2.13: "the collision box is mostly right but the turret appears upside down".
 * Even-sided structures (capital 8 / connector 6 / solar 4 / battery 4) are
 * unchanged. `structureHullPoints` returns a FRESH array, so negating Y in place
 * is safe (the collider calls it separately). Called once per sprite create —
 * NOT a hot loop.
 */
export function structureRenderVerts(
  structureKindId: string | undefined,
  radius: number,
): Array<{ x: number; y: number }> {
  const kind = getStructureKind(structureKindId);
  const pts = structureHullPoints(kind.id, radius);
  for (let i = 0; i < pts.length; i++) pts[i]!.y = -pts[i]!.y;
  return pts;
}

/**
 * Structure visual (pose-core kind 2) — the regular polygon tinted with the
 * subtype's catalogue `color`. The silhouette is `structureRenderVerts` (the
 * game→Pixi Y-flip of the SINGLE hull-points source `structureHullPoints`, which
 * also forms the polygon collider at spawn — server `SwarmSpawner.spawnStructure`
 * + client `structureClientLeaf`), so the render matches the collider for
 * odd-sided shapes too (R2.13). The renderer additionally rotates the sprite by
 * `-angle`. Unknown subtype ⇒ the Capital's look (forgiving, like
 * `getStructureKind`).
 */
export function buildStructureGfx(structureKindId: string | undefined, radius: number): Graphics {
  const g = new Graphics();
  const kind = getStructureKind(structureKindId);
  const verts = structureRenderVerts(kind.id, radius);
  g.poly(verts);
  g.fill({ color: kind.color });
  g.poly(verts);
  g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
  // Core dot so small structures stay legible.
  g.circle(0, 0, Math.max(2, radius * 0.18));
  g.fill({ color: 0xffffff, alpha: 0.85 });
  return g;
}

/** WS-9 (R2.12) — short-form resource count for the Capital's world readout:
 *  999 → "999", 12_345 → "12.3k", 2_300_000 → "2.3M". A fraction-bar is useless
 *  (storageCapacity is 2,000,000), so the Capital shows the NUMBER. */
export function formatResources(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** P3.4 — oversample world-space structure text so it stays crisp when the
 *  camera zooms in. Pixi bakes glyph textures at the renderer's 1× resolution
 *  by default, which softens under magnification (the same low-res complaint
 *  the galaxy map had). Mirrors the galaxy-map label fix's oversample factor. */
const STRUCTURE_LABEL_RESOLUTION = 3;

let _capitalResStyle: TextStyle | undefined;
/** WS-9 (R2.12) — the Capital's world-space mineral-bank readout (a short amber
 *  number below the body). Built ONCE per capital sprite (invariant #14); the
 *  caller mutates `.text` only when the value changes (no per-frame re-raster).
 *  Tagged `label = 'capitalResource'`. */
export function buildCapitalResourceText(radius: number): Text {
  _capitalResStyle ??= new TextStyle({
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    fontWeight: '700',
    fill: 0xffe08a,
    stroke: { color: 0x000000, width: 3 },
  });
  // resolution + roundPixels: crisp under camera zoom (P3.4).
  const t = new Text({ text: '', style: _capitalResStyle, resolution: STRUCTURE_LABEL_RESOLUTION, roundPixels: true });
  t.anchor.set(0.5, 0);
  t.y = radius + 4; // below the body (Pixi y-down)
  t.label = 'capitalResource';
  return t;
}

/**
 * Mining-range ring (WS-4 Phase 5 / R2.16) — a faint dashed circle at the
 * Miner's `miningRange` radius, showing where it can extract from asteroids.
 * Built ONCE per miner sprite (never per-frame, invariant #14) and parented to
 * the structure sprite so it tracks the body; the ring is symmetric so the
 * sprite's `-angle` rotation is invisible. Tagged `label = 'minerRangeRing'`
 * so the renderer's once-per-sprite create path + the test can find it.
 *
 * Pixi v8 has no native dashed stroke, so the ring is a chain of ~40 short
 * independent chord dashes (each its own moveTo+lineTo, so the gaps stay clean
 * — consecutive arcs would draw a connecting line across each gap). At the
 * Miner's 800 u radius a half-degree-ish chord is visually indistinguishable
 * from an arc. Faint amber, low alpha — purely informational, never dominant.
 */
export function buildMinerRangeRingGfx(miningRange: number): Graphics {
  const g = new Graphics();
  g.label = 'minerRangeRing';
  if (!(miningRange > 0)) return g; // defensive — caller only passes miner ranges
  const dashes = 40;
  const dashArc = (Math.PI * 2) / dashes / 2; // half on / half off → even dotted ring
  for (let i = 0; i < dashes; i++) {
    const a0 = (i * 2 * Math.PI) / dashes;
    const a1 = a0 + dashArc;
    g.moveTo(Math.cos(a0) * miningRange, Math.sin(a0) * miningRange);
    g.lineTo(Math.cos(a1) * miningRange, Math.sin(a1) * miningRange);
  }
  g.stroke({ color: 0xeeaa66, width: 2, alpha: 0.22 });
  return g;
}

export function buildGhostGfx(): Graphics {
  const g = new Graphics();
  g.poly([{ x: 0, y: -14 }, { x: 10, y: 0 }, { x: 0, y: 14 }, { x: -10, y: 0 }]);
  g.fill({ color: SERVER_GHOST_COLOR, alpha: 0.55 });
  g.circle(0, 0, 12);
  g.stroke({ color: SERVER_GHOST_COLOR, width: 1.5, alpha: 0.9 });
  return g;
}

export function buildProjectileGfx(isGhost: boolean): Graphics {
  const g = new Graphics();
  const color = isGhost ? GHOST_PROJECTILE_COLOR : PROJECTILE_COLOR;
  g.circle(0, 0, 4);
  g.fill({ color, alpha: isGhost ? 0.7 : 1 });
  return g;
}

export function buildLaserBoltGfx(): Graphics {
  const g = new Graphics();
  // Outer glow — short bright line
  g.moveTo(0, -12).lineTo(0, 12);
  g.stroke({ color: LASER_BOLT_OUTER, width: 5, alpha: 0.5 });
  // Inner white core
  g.moveTo(0, -10).lineTo(0, 10);
  g.stroke({ color: LASER_BOLT_CORE, width: 2, alpha: 1 });
  return g;
}

export function buildBeamGfx(dx: number, dy: number): Graphics {
  const g = new Graphics();
  // Outer glow
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
  // Bright core
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
  return g;
}

/** Compute the world position of a mount's pivot given the host ship's pose.
 *  Multi-mount/turret refactor (Phase 2c). For legacy single-mount ships
 *  mount.localX/Y = (0, 0), so the result is just (shipX, shipY) — same as
 *  the pre-refactor "fire from ship centre" path. `mount` may be undefined
 *  when a pre-2c server omits `mountId` from a `laser_fired` event; in that
 *  case we fall back to ship centre (no offset). */
export function applyMountOffset(
  shipX: number,
  shipY: number,
  shipAngle: number,
  mount: WeaponMount | undefined,
): { x: number; y: number } {
  if (!mount) return { x: shipX, y: shipY };
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  return {
    x: shipX + (mount.localX * cosA - mount.localY * sinA),
    y: shipY + (mount.localX * sinA + mount.localY * cosA),
  };
}

/** Heat-seeking missile sprite. Orange triangular dart shape so it reads
 *  visibly different from the slim laser bolt. Drawn pointing up (-y);
 *  the renderer rotates to align with `MissileRenderState.angle`. */
export function buildMissileGfx(): Graphics {
  const g = new Graphics();
  // Body — slim orange dart, ~10×4 units.
  g.moveTo(0, -8).lineTo(3, 4).lineTo(0, 2).lineTo(-3, 4).lineTo(0, -8);
  g.fill({ color: 0xff8800, alpha: 1 });
  g.stroke({ color: 0xffcc55, width: 1, alpha: 0.9 });
  // Tail glow — small orange smudge at the back.
  g.circle(0, 4, 2.5);
  g.fill({ color: 0xff5500, alpha: 0.7 });
  return g;
}

/** Missile detonation sprite — bigger / brighter than the standard
 *  explosion. Sized to the splash radius via sprite.scale at draw time. */
export function buildMissileExplosionGfx(): Graphics {
  const g = new Graphics();
  // Inner core — bright yellow.
  g.circle(0, 0, 16);
  g.fill({ color: 0xffee88, alpha: 0.95 });
  // Mid ring — orange.
  g.circle(0, 0, 28);
  g.stroke({ color: 0xff7700, width: 4, alpha: 0.85 });
  // Outer fragments — radiating lines.
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const inner = 18;
    const outer = 36;
    g.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner)
      .lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
  }
  g.stroke({ color: 0xffaa00, width: 2, alpha: 0.9 });
  return g;
}

export function buildExplosionGfx(): Graphics {
  const g = new Graphics();
  // Simple starburst: 8 lines radiating from center.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const r = 20;
    g.moveTo(0, 0).lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  g.stroke({ color: 0xff6600, width: 2, alpha: 0.9 });
  g.circle(0, 0, 8);
  g.fill({ color: 0xffaa00, alpha: 0.8 });
  return g;
}
