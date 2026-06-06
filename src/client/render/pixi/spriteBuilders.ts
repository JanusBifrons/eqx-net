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

import { Graphics } from 'pixi.js';
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { getShipKind, type ShipShape, type WeaponMount } from '../../../shared-types/shipKinds.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';

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
  const g = new Graphics();
  const scale = shape.scale;
  g.poly(shape.points.map(([x, y]) => ({ x: x * scale, y: y * scale })));
  g.fill({ color: tintOverride ?? shape.color });
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

/** Resolve `ShipRenderState.kind` to a concrete shape, with fallback. */
export function shapeForKind(kindId: string | undefined): ShipShape {
  return getShipKind(kindId).shape;
}

/** Drain colour and tilt it grey for the Phase 4 wreck silhouette. Take
 *  ~30 % of the original RGB and mix in a desaturated grey so the wreck
 *  reads as "broken ship of that kind" without screaming the kind's
 *  brand colour. */
export function desaturate(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const grey = Math.round((r + g + b) / 3);
  // 30% original, 70% grey — gives a smoky, drained tone.
  const mix = (c: number) => Math.round(c * 0.30 + grey * 0.70);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * Baseline thrust flame — shown whenever a ship is accelerating, regardless
 * of boost. Two concentric tapered triangles (outer orange, inner yellow-white
 * core). Aligned to the ship's local frame; the renderer inherits the ship's
 * rotation by adding the flame as a child of the sprite.
 */
const THRUST_FLAME_COLOR_OUTER = 0xff7733;
const THRUST_FLAME_COLOR_CORE = 0xffee99;
export function buildThrustFlameGfx(): Graphics {
  const g = new Graphics();
  // Outer plume — tapered triangle pointing astern (local +y in pixi).
  // Ship body extends from y=-16 (nose) to y=10 (tail); flame starts at y=10.
  g.poly([
    { x: -7, y: 10 },
    { x:  7, y: 10 },
    { x:  0, y: 36 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Inner core — brighter, narrower.
  g.poly([
    { x: -3, y: 10 },
    { x:  3, y: 10 },
    { x:  0, y: 24 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_CORE, alpha: 0.95 });
  return g;
}

/**
 * Boost exhaust flame — layered ON TOP of the thrust flame while a ship is
 * boosting. Longer, wider, with a bluish-white plasma core to read as
 * "hotter / more energetic" than the baseline thrust flame.
 */
const BOOST_FLAME_COLOR_OUTER = 0xff5511;
const BOOST_FLAME_COLOR_CORE = 0xffee99;
const BOOST_FLAME_COLOR_PLASMA = 0x88ccff;
export function buildBoostFlameGfx(): Graphics {
  const g = new Graphics();
  // Extended outer plume — wider base, longer tail.
  g.poly([
    { x: -10, y: 10 },
    { x:  10, y: 10 },
    { x:   0, y: 54 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Mid yellow-white layer — bridges outer orange to plasma core.
  g.poly([
    { x: -5, y: 10 },
    { x:  5, y: 10 },
    { x:  0, y: 40 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_CORE, alpha: 0.95 });
  // Plasma core — bluish-white spike to suggest extreme heat.
  g.poly([
    { x: -2, y: 10 },
    { x:  2, y: 10 },
    { x:  0, y: 28 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_PLASMA, alpha: 0.9 });
  return g;
}

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

/** Regular-polygon side count per structure subtype — gives each kind a
 *  distinct silhouette without bespoke hand-authored hulls. Hubs read as
 *  many-sided (octagon/hexagon); leaves are simpler shapes. */
const STRUCTURE_SIDES: Record<string, number> = {
  capital: 8,
  connector: 6,
  solar: 4,
  miner: 5,
  turret: 3,
};

/**
 * Structure visual (pose-core kind 2) — a regular polygon tinted with the
 * subtype's catalogue `color`, sided per `STRUCTURE_SIDES`. Drawn in math space
 * (Y-up) like the other builders; the renderer rotates by `-angle`. An unknown
 * subtype falls back to the Capital's look (matching the catalogue's forgiving
 * `getStructureKind`).
 */
export function buildStructureGfx(structureKindId: string | undefined, radius: number): Graphics {
  const g = new Graphics();
  const kind = getStructureKind(structureKindId);
  const sides = STRUCTURE_SIDES[kind.id] ?? 6;
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < sides; i++) {
    // Start at the top (-y in pixi screen space) and go clockwise.
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    verts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  g.poly(verts);
  g.fill({ color: kind.color });
  g.poly(verts);
  g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
  // Core dot so small structures stay legible.
  g.circle(0, 0, Math.max(2, radius * 0.18));
  g.fill({ color: 0xffffff, alpha: 0.85 });
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
