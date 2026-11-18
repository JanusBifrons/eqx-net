/**
 * Warp actuator: the body side of in-sector warp-to. `warpDrive.ts` is the
 * pure spool → run → drop machine (it decides); this module applies its
 * actions to the Rapier body (facing, run velocity, colliders off during the
 * run, drop pose), for a pilot's input stream (`applyPilotInput`, behind
 * `PhysicsWorld.applyInput`) and an NPC's held target (`botWarpStep`, behind
 * `PhysicsWorld.botWarp`). Moved verbatim out of World.ts (god-file split);
 * `PhysicsWorld` keeps one-line delegates, so its API is unchanged.
 *
 * Invariant #14: reached every fixed step, so the scratch below is module
 * state built once. Rapier copies a Vector2 argument synchronously, and each
 * call finishes with its scratch before the next starts, so sharing it
 * between worlds (one worker thread, many sectors) is safe.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import { applyShipInput, type ShipInputArgs } from './applyShipInput.js';
import { newWarpState, spoolHeldForAlign, stepWarp, WARP_ALIGN_GAIN, WARP_EXIT_SPEED, WARP_MIN_TURN, WARP_SPEED, type WarpState } from './warpDrive.js';
import type { ShipBody, ShipInput } from './worldTypes.js';

const _botVec = { x: 0, y: 0 };
const _warpReq = { x: 0, y: 0 };
const _spoolInput: ShipInput = { thrust: false, turnLeft: false, turnRight: false };

/** `PhysicsWorld.applyInput` for a live body record (see its doc). */
export function applyPilotInput(rec: ShipBody, input: ShipInput): void {
  if (input.warpX !== undefined || rec.warp !== undefined) {
    const hasReq = input.warpX !== undefined && input.warpY !== undefined;
    if (hasReq) { _warpReq.x = input.warpX!; _warpReq.y = input.warpY!; }
    rec.warp ??= newWarpState();
    const body = rec.body;
    const t = body.translation();
    const w = rec.warp;
    // A slow hull keeps spooling until it faces the (unchanged) jump, as in `botWarp`.
    const q = _warpReq;
    if (hasReq && q.x === w.tx && q.y === w.ty && spoolHeldForAlign(w, t.x, t.y, body.rotation(), q.x, q.y)) {
      const s = _spoolInput;
      s.thrust = input.thrust; s.boost = input.boost; s.reverse = input.reverse;
      applyShipInput(body, rec.kind, s, rec.statMul);
      alignToWarp(rec, w, WARP_MIN_TURN);
      return;
    }
    const act = stepWarp(w, hasReq ? _warpReq : null, t.x, t.y, 1 / 60);
    if (act === 'engage') {
      // Face the run (nose = (-sin θ, cos θ)), go, and stop colliding: at
      // ~330 u a tick a body would tunnel or slam into whatever it met.
      body.setRotation(Math.atan2(-w.dx, w.dy), true);
      body.setAngvel(0, true);
      body.setLinvel({ x: w.dx * WARP_SPEED, y: w.dy * WARP_SPEED }, true);
      setCollidersEnabled(rec, false);
      return;
    }
    if (act === 'cruise') {
      body.setAngvel(0, true);
      body.setLinvel({ x: w.dx * WARP_SPEED, y: w.dy * WARP_SPEED }, true);
      return;
    }
    if (act === 'drop') {
      body.setTranslation({ x: w.tx, y: w.ty }, true);
      body.setLinvel({ x: w.dx * WARP_EXIT_SPEED, y: w.dy * WARP_EXIT_SPEED }, true);
      setCollidersEnabled(rec, true);
      return;
    }
  }
  const spool = rec.warp !== undefined && rec.warp.phase === 'spool';
  if (!spool) {
    applyShipInput(rec.body, rec.kind, input, rec.statMul);
    return;
  }
  // Spooling: the drive turns the ship to face its target (the pilot's turn
  // keys are ignored; thrust still works), so it is already pointing the
  // way it goes when the run starts. Same code on server and prediction.
  const s = _spoolInput;
  s.thrust = input.thrust; s.boost = input.boost; s.reverse = input.reverse;
  applyShipInput(rec.body, rec.kind, s, rec.statMul);
  alignToWarp(rec, rec.warp!, WARP_MIN_TURN);
}

/** `PhysicsWorld.botWarp` for a live body record (see its doc). */
export function botWarpStep(rec: ShipBody, target: { x: number; y: number } | null, keys?: ShipInputArgs | null): boolean {
  if (target === null && rec.warp === undefined) return false;
  rec.warp ??= newWarpState();
  const body = rec.body;
  const t = body.translation();
  const w = rec.warp;
  // A slow-turning ship (a capital) keeps spooling until it faces its
  // target: engaging early snapped the hull round in one frame (first fleet
  // film). This is what makes a capital's spool the long one.
  if (target !== null && spoolHeldForAlign(w, t.x, t.y, body.rotation(), target.x, target.y)) {
    w.tx = target.x; w.ty = target.y;
    const v = body.linvel(); // TODO: alloc-debt (Rapier returns a fresh vector)
    setBotVel(body, v.x * 0.9, v.y * 0.9);
    alignToWarp(rec, w, WARP_MIN_TURN);
    return true;
  }
  const act = stepWarp(w, target, t.x, t.y, 1 / 60);
  if (act === 'engage') {
    body.setRotation(Math.atan2(-w.dx, w.dy), true);
    body.setAngvel(0, true);
    setBotVel(body, w.dx * WARP_SPEED, w.dy * WARP_SPEED);
    setCollidersEnabled(rec, false);
    return true;
  }
  if (act === 'cruise') {
    body.setAngvel(0, true);
    setBotVel(body, w.dx * WARP_SPEED, w.dy * WARP_SPEED);
    return true;
  }
  if (act === 'drop') {
    _botVec.x = w.tx; _botVec.y = w.ty;
    body.setTranslation(_botVec, true);
    // An NPC drops out at rest (its AI takes over); a capital coasting on at
    // the pilot's exit speed drifted off its station (fleet film review).
    setBotVel(body, 0, 0);
    setCollidersEnabled(rec, true);
    return true;
  }
  if (w.phase === 'spool') {
    if (keys !== undefined && rec.piloted === true) {
      // Flown by keys: spool like a pilot (thrust works, the drive turns).
      if (keys !== null) {
        const s = _spoolInput;
        s.thrust = keys.thrust; s.boost = keys.boost; s.reverse = keys.reverse;
        applyShipInput(body, rec.pilotKind ?? rec.kind, s, rec.statMul);
      }
      alignToWarp(rec, w, WARP_MIN_TURN);
      return true;
    }
    // Hold position and face the target (a capital turns slowly: its own
    // turn rate caps the align, so a long spool is part of the look).
    const v = body.linvel(); // TODO: alloc-debt (Rapier returns a fresh vector)
    setBotVel(body, v.x * 0.9, v.y * 0.9);
    alignToWarp(rec, w, WARP_MIN_TURN);
    return true;
  }
  return false;
}

/** `PhysicsWorld.restoreWarpState` for a live body record (see its doc). */
export function restoreWarp(rec: ShipBody, src: WarpState | null): void {
  if (src === null) {
    if (rec.warp) { Object.assign(rec.warp, newWarpState()); setCollidersEnabled(rec, true); }
    return;
  }
  rec.warp ??= newWarpState();
  Object.assign(rec.warp, src);
  // Collisions are off only during the run: match the restored phase.
  setCollidersEnabled(rec, rec.warp.phase !== 'cruise');
}

function setBotVel(body: RAPIER.RigidBody, vx: number, vy: number): void {
  _botVec.x = vx; _botVec.y = vy;
  body.setLinvel(_botVec, true);
}

/** Turn toward the warp target at up to the ship's turn rate. */
function alignToWarp(rec: ShipBody, w: WarpState, minRate = 0): void {
  const body = rec.body;
  const t = body.translation();
  const want = Math.atan2(-(w.tx - t.x), w.ty - t.y);
  let d = want - body.rotation();
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const cap = Math.max(minRate, rec.kind.maxAngvel * (rec.statMul !== undefined && rec.statMul.turnRate > 0 ? rec.statMul.turnRate : 1));
  // Proportional: full rate when far off, easing in over the last few degrees.
  const rate = d * WARP_ALIGN_GAIN;
  body.setAngvel(rate > cap ? cap : rate < -cap ? -cap : rate, true);
}

function setCollidersEnabled(rec: ShipBody, on: boolean): void {
  const body = rec.body;
  for (let i = 0; i < body.numColliders(); i++) body.collider(i).setEnabled(on);
}
