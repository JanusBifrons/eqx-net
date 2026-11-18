import RAPIER from '@dimforge/rapier2d-compat';
import type { Vec2 } from '../swarm/asteroidShape.js';
import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  kindHasShield,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import { applyShipInput, type ShipInputArgs, type ShipInputMultipliers } from './applyShipInput.js';
import type { WarpPhase, WarpState } from './warpDrive.js';
import { castHitscan, RaySkipFilter } from './hitscanRay.js';
import { applyForceFields, storeForceField, type ForceField } from './forceFields.js';
import { CapitalOverlapResolver, newCapitalEntry } from './capitalOverlap.js';
import type { ShipBody, ShipInput, ShipPhysicsState } from './worldTypes.js';
import { applyPilotInput, botWarpStep, restoreWarp } from './warpActuator.js';
import { createObstacleBody, createProjectileBody, createShipBody, createWallBody, mountShipColliders } from './spawnBodies.js';
import { addBodyVelocity, applyBodyImpulseAtPoint, applyRigidGroupImpulse as applyGroupImpulse } from './bodyImpulses.js';
import { SleepSettler } from './sleepSettle.js';
import { readAllBodyStates, readBodyState, writeBodyState } from './bodyState.js';
import { fastestContact as fastestContactOf, queryContactState as queryContactStateOf, type ContactState } from './contactProbe.js';

const FIXED_DT = 1 / 60;

/**
 * Re-export of the legacy `BOOST_MULTIPLIER` constant. The authoritative value
 * is now per-kind (`ShipKind.boostMultiplier`), but a handful of older test
 * suites and docs imported it from here. Kept for back-compat — the value is
 * sourced from the default kind so behaviour is unchanged on legacy callers.
 */
export { BOOST_MULTIPLIER } from '../../shared-types/shipKinds.js';

export { SOFT_CCD_PREDICTION } from './spawnBodies.js';

export { WRECK_SETTLE_STEPS } from './sleepSettle.js';

export type { ShipInput, ShipPhysicsState } from './worldTypes.js';

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private bodies = new Map<string, ShipBody>();
  /** Force fields (`setForceField`), one record per id, updated in place. */
  private readonly forceFields = new Map<string, ForceField>();
  /** Reverse lookup: Rapier rigid-body handle → entity ID, for hitscan results. */
  private handleToId = new Map<number, string>();
  /** Shield-wall span bodies + colliders, keyed by wall id. Kept SEPARATE from
   *  `this.bodies` (and out of `handleToId`) so walls never enter the
   *  ship/obstacle SAB-write + contact iteration (`getAllShipStates`): they are
   *  static, slot-less, pose-broadcast-free obstacles whose only job is to block
   *  ships. The collider ref is kept so the wall toggles (stun / power loss) via
   *  `setEnabled` without re-spawning the body. */
  private readonly wallBodies = new Map<string, RAPIER.RigidBody>();
  private readonly wallColliders = new Map<string, RAPIER.Collider>();
  /** Wall-body Rapier handle → `wall-${id}` sentinel. Walls are kept out of
   *  `handleToId` (above), but a hitscan beam must still TERMINATE at an up
   *  wall (R2.28 — the client predicted beam previously ran through it because
   *  `castHitscan` resolved only via `handleToId`). Consulted ONLY in
   *  `castHitscan`'s miss-fallback so a wall contact can never mis-resolve to a
   *  ship id elsewhere. Cleared in `removeWall`; a disabled (down) wall is
   *  excluded from `castRay` by Rapier so it stays passable without a map edit. */
  private readonly wallHandleToId = new Map<number, string>();
  /** Capital-vs-capital hull overlap pass, run after every fixed step (owner
   *  2026-11-12: capitals collide solidly). Only capital bodies are ever
   *  registered, so every other body is untouched. See capitalOverlap.ts. */
  private readonly capitals = new CapitalOverlapResolver();

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0 });
    // 2026-05-28 BISECT ARM B — Rapier defaults restored. See arm A
    // (numSolverIterations=16 + smallStepsPgs) for the "stiff contact"
    // tuning. If the visual overlap is the same on this arm, the bug is
    // not solver-stiffness related.
    return new PhysicsWorld(world);
  }

  /**
   * Advance physics. If `eventQueue` is supplied, it is passed to
   * `world.step()` and Rapier populates it with contact events from this
   * tick's steps. Stage 2 of the network-feel roadmap uses this to surface
   * collision events from the worker thread to the main thread.
   *
   * Note: bodies must have `CONTACT_FORCE_EVENTS` enabled on their colliders
   * for events to be emitted. PhysicsWorld enables this on every dynamic
   * body it spawns (ships, obstacles).
   */
  tick(dtSeconds: number, eventQueue?: RAPIER.EventQueue): void {
    this.accumulator += dtSeconds;
    while (this.accumulator >= FIXED_DT) {
      applyForceFields(this.forceFields, this.bodies, FIXED_DT);
      this.world.step(eventQueue);
      this.capitals.resolve();
      if (this.settle.size > 0) this.settle.step();
      this.accumulator -= FIXED_DT;
    }
  }

  /** Resolve a Rapier rigid-body handle to the entity ID it was spawned with.
   *  Used by Stage 2's `drainContacts` to map contact-event collider handles
   *  back to entity IDs. Returns undefined for handles that no longer
   *  correspond to a live body (e.g. despawned mid-step). */
  resolveHandle(handle: number): string | undefined {
    return this.handleToId.get(handle);
  }

  /** Bridge a collider handle (as exposed by Rapier contact events) to the
   *  parent rigid-body handle (as registered in `handleToId`). Returns
   *  undefined if the collider has no parent body or has been removed. */
  bodyHandleForCollider(colliderHandle: number): number | undefined {
    const collider = this.world.getCollider(colliderHandle);
    if (!collider) return undefined;
    const parent = collider.parent();
    return parent ? parent.handle : undefined;
  }

  /**
   * Spawn a player-controlled ship. Damping, collider radius, and density are
   * read from the chosen `ShipKind` (defaults to the catalogue's default kind
   * — every legacy caller that omitted the parameter gets the previous
   * behaviour for the default kind, which is tuned to match the old hardcoded
   * constants for back-compat).
   */
  spawnShip(id: string, x = 0, y = 0, kindId: ShipKindId = DEFAULT_SHIP_KIND): void {
    const kind = getShipKind(kindId);
    const body = createShipBody(this.world, kind, x, y);
    const rec: ShipBody = { body, kind, exposed: false };
    this.bodies.set(id, rec);
    this.handleToId.set(body.handle, id);
    this.registerCapital(rec, kind);
    if (!kindHasShield(kind)) this.setHullExposed(id, true, kind);
  }

  /** Is the hull collider mounted (shield down, or no shield)? */
  isHullExposed(id: string): boolean | undefined {
    return this.bodies.get(id)?.exposed;
  }

  /** Capitals join the hull-overlap pass (capitalOverlap.ts); every other
   *  kind is left to Rapier alone. A capital mid warp run (colliders off) is
   *  out of the world, so the pass skips it. */
  private registerCapital(rec: ShipBody, kind: ShipKind): void {
    if (kind.sizeClass !== 'capital') return;
    this.capitals.add(newCapitalEntry(rec.body, kind, () => rec.warp !== undefined && rec.warp.phase === 'cruise'));
  }

  /** Spawn a passive dynamic body (asteroid, drone, scrap, structure, gate);
   *  doc: `createObstacleBody` (spawnBodies.ts). */
  spawnObstacle(
    id: string,
    x: number,
    y: number,
    radius = 24,
    mass = 3,
    vertices?: ReadonlyArray<Vec2>,
    linearDamping = 0,
    collisionGroups?: number,
    parts?: ReadonlyArray<ReadonlyArray<Vec2>>,
    /** A drone of this kind starts with its shield-up collider
     *  (`shipShieldColliderDesc`): ball(radius + shieldPad), or a capital's
     *  rounded hull. Omitted ⇒ a plain `ball(radius)` obstacle. */
    shieldKind?: ShipKind,
  ): void {
    const body = createObstacleBody(this.world, x, y, radius, mass, vertices, linearDamping, collisionGroups, parts, shieldKind);
    if (parts && parts.length > 0) {
      this.bodies.set(id, { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false });
      this.handleToId.set(body.handle, id);
      return;
    }
    // Obstacles are tracked under the default kind purely so the bodies map
    // shape stays uniform; obstacle physics never reads this kind back.
    const rec: ShipBody = { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false };
    this.bodies.set(id, rec);
    this.handleToId.set(body.handle, id);
    // An NPC capital (a drone spawned with its capital kind's shield).
    if (shieldKind) this.registerCapital(rec, shieldKind);
    // A drone of a kind with no shield collides on its hull from spawn.
    if (shieldKind && !kindHasShield(shieldKind)) this.setHullExposed(id, true, shieldKind);
  }

  /** Spawn a fast-moving kinematic projectile body (sensor — no physics impulses). */
  spawnProjectile(id: string, x: number, y: number, vx: number, vy: number, radius: number): void {
    const body = createProjectileBody(this.world, x, y, vx, vy, radius);
    this.bodies.set(id, { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false });
    this.handleToId.set(body.handle, id);
  }

  despawnShip(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.handleToId.delete(rec.body.handle);
    this.capitals.remove(rec.body);
    this.settle.delete(id);
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(id);
  }

  /** Spawn a shield-wall span between two pylon poses; doc: `createWallBody`
   *  (spawnBodies.ts). Idempotent on `id`. */
  spawnWall(id: string, ax: number, ay: number, bx: number, by: number, thickness: number): void {
    if (this.wallBodies.has(id)) return;
    const w = createWallBody(this.world, ax, ay, bx, by, thickness);
    if (w === null) return; // degenerate (coincident pylons) — nothing to span
    this.wallBodies.set(id, w.body);
    this.wallColliders.set(id, w.collider);
    this.wallHandleToId.set(w.body.handle, 'wall-' + id);
  }

  /** Enable/disable a wall's collider (stun / power loss → pass-through). A
   *  no-op for an unknown id. */
  setWallActive(id: string, active: boolean): void {
    this.wallColliders.get(id)?.setEnabled(active);
  }

  /**
   * Force fields (`forceFields.ts`: kinds `pad` and `tractor`, their
   * formulas and the per-step loop `applyForceFields`) push dynamic bodies
   * each fixed step; the server worker and the client predWorld run the same
   * list (#15). Idempotent on `id`; values are COPIED (`storeForceField`), so
   * a caller may reuse a scratch.
   */
  setForceField(id: string, field: ForceField): void {
    this.forceFields.set(id, storeForceField(this.forceFields.get(id), field));
  }

  removeForceField(id: string): void {
    this.forceFields.delete(id);
  }

  /** Remove a wall span entirely (pylon destroyed / pair severed). */
  removeWall(id: string): void {
    const body = this.wallBodies.get(id);
    if (!body) return;
    this.wallHandleToId.delete(body.handle);
    this.world.removeRigidBody(body); // removes the body AND its collider
    this.wallBodies.delete(id);
    this.wallColliders.delete(id);
  }

  /** Swap a body between its shield (circle) and hull colliders; doc:
   *  `mountShipColliders` (spawnBodies.ts). Idempotent. */
  setHullExposed(id: string, exposed: boolean, kind: ShipKind): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    if (!kindHasShield(kind)) exposed = true; // no shield (capitals): hull, always
    if (rec.exposed === exposed) return; // idempotent -- no redundant churn
    mountShipColliders(this.world, rec.body, kind, exposed);
    rec.exposed = exposed;
  }

  /**
   * Per-tick player input → physics: the drifty-arcade model of
   * `applyShipInput` (applyShipInput.ts documents it), plus in-sector warp
   * (`applyPilotInput`, warpActuator.ts). Silently no-ops on unknown ids so
   * a stale input posted after despawn is harmless (matches `applyImpulse`).
   */
  applyInput(id: string, input: ShipInput): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    applyPilotInput(rec, input);
  }

  /** NPC warp-to; doc: `botWarpStep` (warpActuator.ts). True while the warp
   *  owns the body this tick. */
  botWarp(id: string, target: { x: number; y: number } | null, keys?: ShipInputArgs | null): boolean {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    return botWarpStep(rec, target, keys);
  }

  /** Copy a ship's warp state into `out` (false when it never warped). The
   *  reconciler keeps one per input tick so a correction replays from the
   *  right spool / run state, not the latest one. Alloc-free. */
  copyWarpState(id: string, out: WarpState): boolean {
    const w = this.bodies.get(id)?.warp;
    if (!w) return false;
    Object.assign(out, w);
    return true;
  }

  /** Restore a ship's warp state (`null`: never warped → back to idle). */
  restoreWarpState(id: string, src: WarpState | null): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    restoreWarp(rec, src);
  }

  /** Move a running warp's drop point (server: land at the nearest clear spot).
   *  Only during the run; the run's direction is kept. */
  retargetWarp(id: string, x: number, y: number): void {
    const w = this.bodies.get(id)?.warp;
    if (w === undefined || w.phase !== 'cruise') return;
    w.tx = x;
    w.ty = y;
  }

  /** In-sector warp phase of a ship (`idle` when it never warped). */
  warpPhase(id: string): WarpPhase {
    return this.bodies.get(id)?.warp?.phase ?? 'idle';
  }

  /** True once a ship has arrived at its warp target and its pilot still
   *  holds that request (the client clears its request on this). */
  warpArrived(id: string): boolean {
    return this.bodies.get(id)?.warp?.latched === true;
  }

  /**
   * Phase 4 WS-B2 — set (or clear) a ship instance's per-instance PHYSICS stat
   * multipliers (`topSpeed`, `turnRate`). Threaded into `applyShipInput` on the
   * NEXT tick so the per-tick movement clamps scale by the instance's spent
   * stat allocation. The SAME setter runs on the server worker (via the
   * `SET_STAT_MUL` worker command) and the client predWorld (called directly),
   * so both sides clamp identically and reconciliation stays clean (risk #1 /
   * invariants #4, #12). Pass `undefined` to reset to the un-upgraded factors.
   * Silently no-ops on unknown ids (a stale post after despawn is harmless).
   */
  setStatMultipliers(id: string, mul: ShipInputMultipliers | undefined): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.statMul = mul;
  }

  /** Pilot layer: record the ShipKind an AI slot flies with (`applyAiInput`)
   *  and give the body that kind's linear + angular damping NOW, as
   *  `spawnShip` does, so an NPC ship's body matches a pilot's of the same
   *  kind from its first tick (ship stats belong to the ship, owner
   *  2026-11-13). Server worker only: the client predWorld drone body keeps
   *  damping 0 (it coasts between server anchors). Unknown id ⇒ no-op. */
  setPilotKind(id: string, kind: ShipKind): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.pilotKind = kind;
    rec.piloted = true;
    rec.body.setLinearDamping(kind.linearDamping);
    rec.body.setAngularDamping(kind.angularDamping);
  }

  /**
   * Pilot layer: drive an AI body with player controls, through the SAME
   * `applyShipInput` a pilot's keys use (thrust, lateral grip, maxSpeed clamp,
   * capital torque turning, per-instance stat multipliers). Flies as
   * `pilotKind` (falls back to the record's `kind`).
   *
   * A drone already has its kind's damping from `setPilotKind` at spawn; a
   * body flown without one gets the kind's damping on the first call (a
   * released snap-turn would otherwise spin forever). Unknown id ⇒ no-op.
   */
  applyAiInput(id: string, input: ShipInputArgs): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    const kind = rec.pilotKind ?? rec.kind;
    if (rec.piloted !== true) {
      rec.piloted = true;
      rec.body.setLinearDamping(kind.linearDamping);
      rec.body.setAngularDamping(kind.angularDamping);
    }
    applyShipInput(rec.body, kind, input, rec.statMul);
  }

  /**
   * Apply a single-step linear and angular impulse, used by AI behaviours and
   * (via the `AI_INTENT` worker command) by drone steering. Wakes the body if
   * it was sleeping. Silently no-ops on unknown ids so a stale intent posted
   * after despawn is harmless.
   *
   * Drones bypass the `applyInput` car-model (no lateral grip, no max-speed
   * clamp). Their tuning is per-kind via `ShipKind.ai`; the behaviour
   * controller owns those values, this method just lands the impulses.
   */
  applyImpulse(id: string, fx: number, fy: number, torque: number): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    const body = rec.body;
    if (fx !== 0 || fy !== 0) body.applyImpulse({ x: fx, y: fy }, true);
    if (torque !== 0) body.applyTorqueImpulse(torque, true);
  }

  /** Add a velocity change (u/s) and spin change (rad/s) to a body, whatever
   *  its mass (a capital wreck piece's separating kick). Wakes it. Unknown
   *  id ⇒ no-op. */
  addVelocity(id: string, dvx: number, dvy: number, dw: number): void {
    const rec = this.bodies.get(id);
    if (rec) addBodyVelocity(rec.body, dvx, dvy, dw);
  }

  /** Apply a linear impulse (jx, jy) at world point (px, py), so an
   *  off-centre blow also turns the body (a capital wreck piece knocked by an
   *  overkill shell). Wakes it. Unknown id ⇒ no-op. Alloc-free. */
  applyImpulseAtPoint(id: string, jx: number, jy: number, px: number, py: number): void {
    const rec = this.bodies.get(id);
    if (rec) applyBodyImpulseAtPoint(rec.body, jx, jy, px, py);
  }

  /** Impulse on a group of bodies moved as one rigid body; doc:
   *  bodyImpulses.ts. Unknown ids skipped. */
  applyRigidGroupImpulse(ids: readonly string[], jx: number, jy: number, px: number, py: number): void {
    applyGroupImpulse(this.bodies, ids, jx, jy, px, py);
  }

  /**
   * `setShipState` for a body the authority reports ASLEEP: pose and velocity
   * are written WITHOUT waking it, then it is put to sleep. A sleeping body
   * costs the step almost nothing, and Rapier still wakes it the moment an
   * awake body (the local ship) touches it, so collision is unchanged.
   */
  setShipStateAsleep(id: string, state: ShipPhysicsState): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    writeBodyState(rec.body, state, false);
    rec.body.sleep();
  }

  /** True when Rapier reports the body as sleeping (motion below its threshold). */
  isSleeping(id: string): boolean {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    return rec.body.isSleeping() || rec.body.isFixed(); // fixed (cut-field rock): never simulates, so quiet
  }

  /** Settle-to-sleep below a per-body speed / spin; doc: `SleepSettler.set`
   *  (sleepSettle.ts). Unknown id ⇒ no-op. */
  setSleepSettle(id: string, speed: number, spin: number): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.settle.set(id, rec.body, speed, spin);
  }

  private readonly settle = new SleepSettler();

  /** Dev-only (the worker's wake census, `EQX_WAKE_CENSUS`): the entity id
   *  and speed of the fastest body `id` has a live contact point with, or
   *  null when it touches nothing. Not on any hot path. */
  fastestContact(id: string): { otherId: string; speed: number } | null {
    const rec = this.bodies.get(id);
    return rec ? fastestContactOf(this.world, this.handleToId, rec.body) : null;
  }

  /** Force-wake a body. Safe no-op if already awake or unknown. */
  wakeUp(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.wakeUp();
  }

  /** Set a body's angular damping (capital wreck pieces settle, S2a). */
  setAngularDamping(id: string, damping: number): void {
    this.bodies.get(id)?.body.setAngularDamping(damping);
  }

  /** FIXED terrain (cut-field rocks): never simulated or solved, unlike a `lockBody` body; same call on the server worker and predWorld (#15). */
  fixBody(id: string): void { this.bodies.get(id)?.body.setBodyType(RAPIER.RigidBodyType.Fixed, true); }
  /** Wake a fixed body into a dynamic one (a rammed rock), keeping its colliders and mass. */
  unfixBody(id: string): void { const b = this.bodies.get(id)?.body; if (b?.isFixed()) { b.setBodyType(RAPIER.RigidBodyType.Dynamic, true); b.wakeUp(); } }

  /**
   * Lock a body's translations and rotations. The body still participates in
   * collision detection (other bodies bounce off it as if it had infinite
   * mass) but `world.step()` no longer integrates it. Used by the client's
   * swarm-mirror so reconciler replay doesn't drift swarm bodies between
   * authoritative wire packets.
   */
  lockBody(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.lockTranslations(true, false);
    rec.body.lockRotations(true, false);
  }

  /**
   * Rename a body's lookup key without disturbing the underlying
   * Rapier rigid body. Used by the fresh-spawn-displace flow: a
   * displaced hull's body (rekeyed to `linger-${shipInstanceId}`) must
   * outlive its original playerId so the player can rejoin the room
   * (same playerId) without `spawnShip(playerId, ...)` overwriting the
   * displaced body's entry in `this.bodies` and orphaning it. No-op when
   * `oldId` is absent or `newId` is already taken.
   */
  rekeyShip(oldId: string, newId: string): boolean {
    if (oldId === newId) return false;
    const rec = this.bodies.get(oldId);
    if (!rec) return false;
    if (this.bodies.has(newId)) return false;
    this.bodies.delete(oldId);
    this.bodies.set(newId, rec);
    this.handleToId.set(rec.body.handle, newId);
    return true;
  }

  setShipState(id: string, state: ShipPhysicsState): void {
    const rec = this.bodies.get(id);
    if (rec) writeBodyState(rec.body, state, true);
  }

  /**
   * Snap-set angular velocity. Mirrors the player's input path
   * (`applyInput` calls `body.setAngvel(target * kind.maxAngvel)`) so
   * an AI behaviour can match a player's instantaneous turn-rate
   * without having to fight `1.5 × angvel` damping with a
   * `applyTorqueImpulse` ramp.
   */
  setShipAngvel(id: string, angvel: number): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.setAngvel(angvel, true);
  }

  getShipState(id: string): ShipPhysicsState | null {
    const rec = this.bodies.get(id);
    return rec ? readBodyState(rec.body) : null;
  }

  /**
   * The body's FOLDED total mass (Rapier `RigidBody.mass()`). This is the
   * correct mass source for the ramming model (`core/combat/Ramming.ts`):
   * it reflects the per-kind `setAdditionalMassProperties` pin for ships
   * AND the area-density mass for asteroids AND the structure mass — unlike
   * a `kind.mass` catalogue read, which is undefined for non-ship bodies.
   * Returns `undefined` for an unregistered id (the damage model then treats
   * the contact as mass-less and deals no differential damage). Allocation-
   * free — a single accessor on the body record `drainContacts` already holds.
   */
  getBodyMass(id: string): number | undefined {
    const rec = this.bodies.get(id);
    if (!rec) return undefined;
    return rec.body.mass();
  }

  getAllShipStates(skip?: ReadonlySet<string>): Map<string, ShipPhysicsState> {
    return readAllBodyStates(this.bodies, skip);
  }

  hasShip(id: string): boolean {
    return this.bodies.has(id);
  }

  /** Diagnostic-only: the deepest contact on a body this step, or null; doc:
   *  contactProbe.ts. */
  queryContactState(id: string): ContactState | null {
    const rec = this.bodies.get(id);
    return rec ? queryContactStateOf(this.world, this.handleToId, rec.body) : null;
  }

  /**
   * Cast a ray through the world and return the first entity hit (excluding the shooter).
   * Returns null if no entity is within maxDist along the ray.
   */
  hitscan(
    fromX: number, fromY: number,
    dirX: number, dirY: number,
    maxDist: number,
    excludeId: string,
    /** Optional: body ids the ray passes through. The client passes its
     *  remote drones/scrap here: their collision bodies run on the predicted
     *  timeline, while the turret aims at the drawn pose, so the caller tests
     *  them at the drawn pose itself. Absent ⇒ every body counts (unchanged). */
    skipId?: (id: string) => boolean,
    /** A wide beam's half-width (`beamHalfWidth`): it hits by its width. 0 ⇒ the thin ray. */
    halfWidth = 0,
  ): { hitId: string; dist: number } | null {
    const excludeRec = this.bodies.get(excludeId);
    this._raySkip.skip = skipId ?? null;
    const hit = castHitscan(
      this.world,
      this.handleToId,
      fromX,
      fromY,
      dirX,
      dirY,
      maxDist,
      excludeRec?.body,
      this.wallHandleToId,
      skipId ? this._raySkip.predicate : undefined,
      halfWidth,
    );
    this._raySkip.skip = null;
    return hit;
  }

  /** `hitscan`'s `skipId` filter, built once (invariant #14; hitscanRay.ts). */
  private readonly _raySkip = new RaySkipFilter(this.handleToId);

  dispose(): void {
    this.world.free();
  }
}
