/**
 * Force fields — one list of areas that push dynamic bodies each fixed step
 * (`PhysicsWorld.setForceField` / `removeForceField`). The server worker and
 * the client's prediction world run the same list, so a pushed ship never
 * judders (#15). Guide: docs/architecture/physics-worker.md "Force fields".
 *
 * Each kind declares whether it is **mass-scaled**:
 * - `massScaled: true` — the field sets an ACCELERATION; the per-step impulse
 *   is `mass × accel × dt`, so every body moves the same whatever its mass
 *   (a teleporter pad's closing push).
 * - `massScaled: false` — the field sets a FORCE; the per-step impulse is
 *   `force × dt`, so a heavy body barely moves ("mass still matters": the
 *   tractor beam).
 *
 * Kinds: `pad`, `tractor`. Gravity wells join the union as a new kind; the
 * per-step loop (`applyForceFields`) lives here, not in World.ts.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import { PAD_PUSH_ACCEL, padPushDir } from '../../shared-types/teleport.js';
import { tractorPull } from '../combat/tractorSpec.js';

/** v4 T2 — a teleporter pad's closing-iris push: every dynamic body
 *  straddling the pad edge (square, half-size `half`, centred on cx, cy) is
 *  nudged fully in or fully out (`padPushDir`) while `active`. */
export interface PadForceField {
  kind: 'pad';
  cx: number;
  cy: number;
  half: number;
  active: boolean;
}

/** Most beam-line bodies one tractor carries (fixed capacity, #14). */
export const TRACTOR_LINE_CAP = 8;

/**
 * Salvage PR 10 — a tractor beam locked onto ONE target body. Pulls the
 * target toward the emitter's muzzle with a fixed force that falls off with
 * distance; inside `hold` a critically damped spring cushion settles it so it
 * hovers instead of slamming into the hull. Bodies crossing the beam line
 * feel a weaker pull (`lineFrac`). Only the pulled bodies move: the emitter
 * feels no reaction (owner: "magic"). NOT mass-scaled: acceleration = F / m.
 * Formulas: `tractorImpulse`.
 */
export interface TractorForceField {
  kind: 'tractor';
  active: boolean;
  /** Muzzle (barrel tip), world units. The emitter moves, so the caller
   *  updates it every step. */
  mx: number;
  my: number;
  /** Muzzle velocity (u/s): the hold cushion damps the target's velocity
   *  RELATIVE to it, so a hovering load follows a moving emitter. */
  mvx: number;
  mvy: number;
  /** Entity id of the locked target body. */
  target: string;
  /** Entity id of the emitter's body: never pulled, even if listed. */
  emitter: string;
  /** F_mount: weapon force × `MOUNT_SIZE_TUNING[size].power` (force units). */
  force: number;
  /** Full force inside this distance; inverse-square falloff past it. */
  dRef: number;
  /** No force at or beyond this distance from the muzzle. */
  reach: number;
  /** Cushion radius: inside it the pull becomes the damped spring. */
  hold: number;
  /** Half-width of the beam line. The SERVER uses it to pick `lineIds`
   *  (shared segmentNearCircle / broadphase, PR 11); the worker trusts the
   *  list and runs no shape query (hostile review). */
  lineHalfWidth: number;
  /** A beam-line body feels `lineFrac × F(d)` toward the muzzle, no spring. */
  lineFrac: number;
  /** How many of `lineIds` are live (≤ TRACTOR_LINE_CAP). */
  lineCount: number;
  /** Bodies crossing the beam line, supplied by the server. Only the first
   *  `min(lineCount, TRACTOR_LINE_CAP)` entries are read. */
  lineIds: string[];
}

export type ForceField = PadForceField | TractorForceField;
export type ForceFieldKind = ForceField['kind'];

/** Per kind: does the field scale its push by the target's mass? */
export const FORCE_FIELD_MASS_SCALED: Readonly<Record<ForceFieldKind, boolean>> = {
  pad: true,
  // Owner 2026-11-15, "mass matters": a fixed force, acceleration = F / m.
  tractor: false,
};

/**
 * Copy `src` into the world's record for its id (`prev`), reusing `prev`
 * when the kind matches, so `setForceField` allocates only on the first set
 * of an id or a kind change (#14). Returns the record to store.
 */
export function storeForceField(prev: ForceField | undefined, src: ForceField): ForceField {
  if (src.kind === 'pad') {
    if (prev !== undefined && prev.kind === 'pad') {
      prev.cx = src.cx; prev.cy = src.cy; prev.half = src.half; prev.active = src.active;
      return prev;
    }
    return { kind: 'pad', cx: src.cx, cy: src.cy, half: src.half, active: src.active };
  }
  const t: TractorForceField = prev !== undefined && prev.kind === 'tractor'
    ? prev
    : {
      kind: 'tractor', active: false, mx: 0, my: 0, mvx: 0, mvy: 0, target: '', emitter: '',
      force: 0, dRef: 1, reach: 0, hold: 0, lineHalfWidth: 0, lineFrac: 0,
      lineCount: 0, lineIds: new Array<string>(TRACTOR_LINE_CAP).fill(''),
    };
  t.active = src.active; t.mx = src.mx; t.my = src.my; t.mvx = src.mvx; t.mvy = src.mvy;
  t.target = src.target; t.emitter = src.emitter; t.force = src.force; t.dRef = src.dRef;
  t.reach = src.reach; t.hold = src.hold; t.lineHalfWidth = src.lineHalfWidth; t.lineFrac = src.lineFrac;
  const n = Math.min(src.lineCount, TRACTOR_LINE_CAP, src.lineIds.length);
  for (let i = 0; i < n; i++) t.lineIds[i] = src.lineIds[i]!;
  t.lineCount = n;
  return t;
}

/**
 * The tractor's impulse on ONE body for one step of `dt` seconds, written to
 * `out` (toward the muzzle when positive pull). Pure and allocation-free.
 *
 * With d = |muzzle − body| and F_mount = `f.force`:
 * - d ≥ reach (or d = 0) → nothing (returns false).
 * - beam-line body (`line`): J = lineFrac × F(d) × dt toward the muzzle.
 * - target, d > hold: J = F(d) × dt toward the muzzle, where
 *   F(d) = F_mount × min(1, (dRef / d)²) (inverse square, capped).
 * - target, d ≤ hold: a critically damped spring resting at `hold`,
 *   k = F_mount / hold, c = 2√(k·m), force = k·(hold − d) outward − c·v_rel
 *   (v_rel = body velocity − muzzle velocity), magnitude clamped to F_mount;
 *   c is also capped at m / dt so one step never reverses v_rel.
 * Never scaled by mass (FORCE_FIELD_MASS_SCALED.tractor = false): a heavy
 * body gets the same impulse and so moves m× less.
 */
export function tractorImpulse(
  f: Readonly<TractorForceField>,
  px: number, py: number, vx: number, vy: number, mass: number,
  dt: number, line: boolean, out: { x: number; y: number },
): boolean {
  out.x = 0; out.y = 0;
  const dx = f.mx - px;
  const dy = f.my - py;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= f.reach || d <= 0 || f.force <= 0) return false;
  const ux = dx / d;
  const uy = dy / d;
  if (line || d > f.hold) {
    const pull = tractorPull(f.force, f.dRef, f.reach, d) * (line ? f.lineFrac : 1);
    out.x = ux * pull * dt;
    out.y = uy * pull * dt;
    return pull > 0;
  }
  const k = f.force / f.hold;
  const c = Math.min(2 * Math.sqrt(k * mass), mass / dt);
  const push = k * (f.hold - d); // outward, away from the muzzle
  let fx = -ux * push - c * (vx - f.mvx);
  let fy = -uy * push - c * (vy - f.mvy);
  const mag = Math.sqrt(fx * fx + fy * fy);
  if (mag > f.force) { fx *= f.force / mag; fy *= f.force / mag; }
  out.x = fx * dt;
  out.y = fy * dt;
  return true;
}

/** What `applyForceFields` needs of a world body. */
export interface ForceFieldBody {
  readonly body: RAPIER.RigidBody;
  readonly kind: { readonly radius: number };
}

const _padDir = { x: 0, y: 0 };
const _impulse = { x: 0, y: 0 };

/** Push every body one fixed step of `dt` under every active field. Called
 *  by `PhysicsWorld.tick` before `world.step`. */
export function applyForceFields(
  fields: ReadonlyMap<string, ForceField>, bodies: ReadonlyMap<string, ForceFieldBody>, dt: number,
): void {
  if (fields.size === 0) return;
  for (const f of fields.values()) {
    if (!f.active) continue;
    if (f.kind === 'pad') applyPad(f, bodies, dt);
    else applyTractor(f, bodies, dt);
  }
}

function applyPad(f: PadForceField, bodies: ReadonlyMap<string, ForceFieldBody>, dt: number): void {
  const massScaled = FORCE_FIELD_MASS_SCALED.pad;
  for (const rec of bodies.values()) {
    const b = rec.body;
    if (!b.isDynamic()) continue;
    // TODO: alloc-debt — Rapier's translation() returns a fresh vector; this
    // runs only during a pad's ~4 s closing phase.
    const t = b.translation();
    if (!padPushDir(f.cx, f.cy, f.half, t.x, t.y, rec.kind.radius, _padDir)) continue;
    // massScaled: mass × accel × dt; else force × dt (heavy bodies barely move).
    const j = massScaled ? b.mass() * PAD_PUSH_ACCEL * dt : PAD_PUSH_ACCEL * dt;
    _impulse.x = _padDir.x * j;
    _impulse.y = _padDir.y * j;
    b.applyImpulse(_impulse, true);
  }
}

function applyTractor(f: TractorForceField, bodies: ReadonlyMap<string, ForceFieldBody>, dt: number): void {
  if (f.target !== f.emitter) pullBody(f, bodies.get(f.target), dt, false);
  const n = Math.min(f.lineCount, TRACTOR_LINE_CAP);
  for (let i = 0; i < n; i++) {
    const id = f.lineIds[i]!;
    if (id === f.target || id === f.emitter) continue;
    pullBody(f, bodies.get(id), dt, true);
  }
}

function pullBody(f: TractorForceField, rec: ForceFieldBody | undefined, dt: number, line: boolean): void {
  if (rec === undefined) return;
  const b = rec.body;
  if (!b.isDynamic()) return;
  // TODO: alloc-debt — translation()/linvel() return fresh vectors; at most
  // 1 + TRACTOR_LINE_CAP bodies per live tractor.
  const t = b.translation();
  const v = b.linvel();
  if (tractorImpulse(f, t.x, t.y, v.x, v.y, b.mass(), dt, line, _impulse)) b.applyImpulse(_impulse, true);
}
