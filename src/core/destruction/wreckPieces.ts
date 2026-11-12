/**
 * Capital destruction S2a: turn a dying capital into wreck-piece rigid bodies
 * (docs/architecture/capital-destruction.md §S2).
 *
 * Pure: the server calls it once per capital death, then spawns one dynamic
 * body per returned piece. It runs `fractureHull` on the kind's 1× hull
 * outline (Pixi-up, the frame the S2b descriptor will name), then places each
 * piece in the world exactly where that part of the hull was:
 *  - the outline maps to the live collider's frame like `shipShapeToPolygon`
 *    (x·s, −y·s), then rotates by the ship's angle and moves to its position;
 *  - each body sits at its piece's centroid, its convex parts recentred there
 *    (CCW in math-up, so the Y flip reverses each ring);
 *  - mass ∝ area at the ship's own density (hull mass / hull area);
 *  - velocity is the rigid-body velocity of the hull at that point
 *    (v + ω × r) plus an outward push away from the kill point; spin is the
 *    ship's ω plus a seeded kick.
 *
 * Runs once per death (not hot-loop code); allocates freely.
 */
import { fractureHull, projectToOutline, FRACTURE_MAX_PIECES } from './fractureHull.js';
import { Rng, fnvMixU32 } from '../random/rng.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { massOf } from '../../shared-types/shipScale/tuning.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Outward push at the kill point, as a fraction of the kind's top speed
 *  (scaled by how violent the death was), so it follows ship size (#18). */
export const WRECK_PUSH_SPEED_FRAC = 0.25;
/** Largest seeded extra spin per piece (rad/s), before the size falloff. */
export const WRECK_SPIN_KICK = 0.12;
/** Wreck pieces coast, then settle into terrain. */
export const WRECK_LINEAR_DAMPING = 0.05;
export const WRECK_ANGULAR_DAMPING = 0.1;
/** Room-wide cap on live wreck bodies (each takes a physics slot). Owner:
 *  wrecks stay for ever; this is only a budget guard (the oldest wreck piece
 *  goes first, S2b revisits it with persistence). */
export const MAX_LIVE_WRECK_PIECES = 768;
/** The recent-damage window: damage over this many ticks (~3 s at 60 Hz). */
export const WRECK_RECENT_DAMAGE_TICKS = 180;

export interface WreckDeathPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

export interface WreckBuildInput {
  kindId: ShipKindId;
  pose: WreckDeathPose;
  /** World point the killing blow landed (projected onto the hull). */
  killWorld: Vec2 | null;
  /** Fallback when the hit had no point: the attacker's world position (the
   *  nearest hull point to it is used). Null ⇒ the hull point nearest the centre. */
  attackerWorld: Vec2 | null;
  seed: number;
  /** Final hit's damage / max hull. */
  killBlowDamage: number;
  /** Damage over the last ~3 s / max hull. */
  recentDamageRate: number;
}

export interface WreckPieceSpec {
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  /** Convex parts, body-local math-up, CCW, centred on (x, y). */
  parts: Vec2[][];
  /** World-unit area (scaled). */
  area: number;
  mass: number;
  /** Farthest part vertex from the centre (bounding circle). */
  radius: number;
}

export interface WreckBuild {
  pieces: WreckPieceSpec[];
  /** The kill point in the hull's 1× Pixi-up frame, on the outline (the
   *  S2b descriptor's killX/killY). */
  killLocal: Vec2;
  /** The kill point in world space (on the hull). */
  killWorldOnHull: Vec2;
}

/** World point → the hull's 1× Pixi-up frame, projected onto the outline. */
export function hullLocalKillPoint(kindId: ShipKindId, pose: WreckDeathPose, world: Vec2): Vec2 {
  const kind = getShipKind(kindId);
  const s = shipShapeScale(kind);
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const dx = world.x - pose.x;
  const dy = world.y - pose.y;
  const mx = dx * c + dy * sn;
  const my = -dx * sn + dy * c;
  return projectToOutline(shipHullOutline(kind), { x: mx / s, y: -my / s });
}

function ringArea(r: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Saturating 0..1 "how violent" from the two damage inputs. */
function violence(kb: number, rate: number): number {
  const f = (x: number): number => (x > 0 ? x / (x + 0.35) : 0);
  return 0.5 * f(kb) + 0.5 * f(rate);
}

export function buildWreckPieces(input: WreckBuildInput): WreckBuild {
  const kind = getShipKind(input.kindId);
  const hull = shipHullOutline(kind);
  const s = shipShapeScale(kind);
  const { pose } = input;
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const toWorld = (lx: number, ly: number): Vec2 => {
    // Pixi-up 1× → math-up scaled → world.
    const mx = lx * s;
    const my = -ly * s;
    return { x: pose.x + mx * c - my * sn, y: pose.y + mx * sn + my * c };
  };

  const target = input.killWorld ?? input.attackerWorld ?? { x: pose.x, y: pose.y };
  const killLocal = hullLocalKillPoint(input.kindId, pose, target);
  const killWorldOnHull = toWorld(killLocal.x, killLocal.y);

  const fractured = fractureHull({
    hull,
    seed: input.seed >>> 0,
    killPoint: killLocal,
    maxPieces: FRACTURE_MAX_PIECES,
    killBlowDamage: input.killBlowDamage,
    recentDamageRate: input.recentDamageRate,
  });

  const hullAreaWorld = ringArea(hull) * s * s;
  const density = hullAreaWorld > 0 ? massOf(kind, 1) / hullAreaWorld : 0;
  const push = WRECK_PUSH_SPEED_FRAC * kind.maxSpeed * (0.5 + violence(input.killBlowDamage, input.recentDamageRate));
  const spinRng = new Rng(fnvMixU32((input.seed >>> 0) ^ 0x3ec7, 0x5));

  const pieces: WreckPieceSpec[] = [];
  for (let i = 0; i < fractured.length; i++) {
    const p = fractured[i]!;
    const centre = toWorld(p.centroid.x, p.centroid.y);
    const cmx = p.centroid.x * s;
    const cmy = -p.centroid.y * s;
    let radius = 0;
    const parts: Vec2[][] = [];
    for (const part of p.convexParts) {
      const ring: Vec2[] = [];
      // The Y flip turns CCW into CW: walk backwards to stay CCW.
      for (let k = part.length - 1; k >= 0; k--) {
        const v = part[k]!;
        const x = v.x * s - cmx;
        const y = -v.y * s - cmy;
        ring.push({ x, y });
        const r = Math.sqrt(x * x + y * y);
        if (r > radius) radius = r;
      }
      parts.push(ring);
    }
    const area = p.area * s * s;
    const rx = centre.x - pose.x;
    const ry = centre.y - pose.y;
    let ox = centre.x - killWorldOnHull.x;
    let oy = centre.y - killWorldOnHull.y;
    const ol = Math.sqrt(ox * ox + oy * oy);
    if (ol > 1e-6) {
      ox /= ol;
      oy /= ol;
    } else {
      ox = 0;
      oy = 0;
    }
    const kick = (spinRng.u32() / 4294967296 - 0.5) * 2 * WRECK_SPIN_KICK;
    pieces.push({
      index: i,
      x: centre.x,
      y: centre.y,
      vx: pose.vx - pose.angvel * ry + ox * push,
      vy: pose.vy + pose.angvel * rx + oy * push,
      angle: pose.angle,
      angvel: pose.angvel + kick,
      parts,
      area,
      mass: Math.max(1e-3, density * area),
      radius,
    });
  }
  return { pieces, killLocal, killWorldOnHull };
}
