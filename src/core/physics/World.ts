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
import { castHitscan } from './hitscanRay.js';
import { wallGeometry } from '../structures/ShieldWall.js';
import { applyForceFields, storeForceField, type ForceField } from './forceFields.js';
import { CapitalOverlapResolver, newCapitalEntry } from './capitalOverlap.js';
import type { ShipBody, ShipInput, ShipPhysicsState } from './worldTypes.js';
import { applyPilotInput, botWarpStep, restoreWarp } from './warpActuator.js';
import { createObstacleBody, createProjectileBody, createShipBody, mountShipColliders } from './spawnBodies.js';
import { SleepSettle } from './sleepSettle.js';

const FIXED_DT = 1 / 60;

/**
 * Re-export of the legacy `BOOST_MULTIPLIER` constant. The authoritative value
 * is now per-kind (`ShipKind.boostMultiplier`), but a handful of older test
 * suites and docs imported it from here. Kept for back-compat — the value is
 * sourced from the default kind so behaviour is unchanged on legacy callers.
 */
export { BOOST_MULTIPLIER } from '../../shared-types/shipKinds.js';

export { SOFT_CCD_PREDICTION } from './spawnBodies.js';

/** Settle-to-sleep constants: sleepSettle.ts. */
export { WRECK_SETTLE_STEPS, BEAMED_LINEAR_DAMPING } from './sleepSettle.js';

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
  /** 2026-05-25 heap-growth fix — per-tick pooled scratches for the
   *  Rapier `setTranslation` / `setLinvel` Vector2 arguments. `setShipState`
   *  was called per-drone per-RAF on the client (the since-retired follower for
   *  snapshot-interpolated drones) — at 25 drones × 90 RAFs/sec the
   *  prior `{x, y}` literals were 2 × 2250 = 4500 allocations/sec just
   *  from this method. Rapier's API takes Vector2-like objects, so we
   *  reuse a single instance per call site. Safe because rapier copies
   *  the values into native memory synchronously inside the call. */
  private readonly _setShipStateTranslationScratch = { x: 0, y: 0 };
  private readonly _setShipStateLinvelScratch = { x: 0, y: 0 };
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
      if (this.settle.size > 0) this.settle.step(this.forceFields);
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

  /**
   * Spawn a passive dynamic body (asteroid-ish) for collision testing. No damping
   * on linear or angular motion so an initial velocity / spin persists.
   *
   * When `vertices` is provided, the collider is a convex hull built from those
   * points (entity-local space). Density is scaled by the polygon area so the
   * resulting body mass matches the requested `mass` exactly. When `vertices`
   * is omitted, behaviour is unchanged: a `ball(radius)` collider with density
   * derived from the disc area.
   *
   * Obstacles do not have a `ShipKind` and never go through `applyInput`. Their
   * physics is governed entirely by Rapier's solver plus any AI-driven
   * `applyImpulse` calls from drone behaviours.
   */
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
    this.settle.remove(id);
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(id);
  }

  /**
   * Spawn a shield-wall span — a STATIC (fixed) cuboid spanning between two pylon
   * poses (shield-fence plan). It blocks ships physically (an immovable body the
   * dynamic ship bodies bounce off); weapon absorption is resolved main-thread
   * (the server has no live Rapier world). The geometry is derived from the two
   * poses via the shared `wallGeometry` so the server collider, the client
   * predWorld collider, and the rendered span all agree. Idempotent on `id`.
   *
   * NOT given CONTACT_FORCE_EVENTS — a wall never deals ram damage; it just
   * blocks. Toggle it on stun / power loss via `setWallActive` (cheaper than a
   * despawn/respawn churn of the body + handle maps).
   */
  spawnWall(id: string, ax: number, ay: number, bx: number, by: number, thickness: number): void {
    if (this.wallBodies.has(id)) return;
    const g = wallGeometry(ax, ay, bx, by);
    if (g.length < 1) return; // degenerate (coincident pylons) — nothing to span
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(g.midX, g.midY).setRotation(g.angle),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(g.length / 2, thickness / 2).setRestitution(0.4).setFriction(0),
      body,
    );
    this.wallBodies.set(id, body);
    this.wallColliders.set(id, collider);
    this.wallHandleToId.set(body.handle, 'wall-' + id);
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

  /**
   * Swap a ship/drone body between its cheap CIRCLE collider (shield up)
   * and its exact-silhouette HULL POLYGON -- a compound of zero-density
   * triangle colliders (shield down). The body and body.handle are
   * preserved (handleToId + the SAB slot stay valid); pose/velocity are
   * untouched; mass/inertia are untouched (all colliders zero-density --
   * the body's additional mass props own the dynamics). Idempotent.
   *
   * Discrete event (shield 0-cross), NOT per-tick, so allocating the new
   * colliders here is fine. QUERY-PIPELINE LAG: the new geometry is only
   * visible to castRay / contact generation on the NEXT world.step()
   * (Rapier refreshes queries inside step() only). The <=1-tick window
   * where a query still sees the old (larger) circle after the shield
   * dropped is acceptable + intentional -- never paper over it with
   * updateSceneQueries() (the client predWorld won't, so that would
   * desync lockstep).
   *
   * `kind` is passed explicitly because drone body records store the
   * DEFAULT kind (see spawnObstacle) -- the caller knows the real kind.
   */
  setHullExposed(id: string, exposed: boolean, kind: ShipKind): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    if (!kindHasShield(kind)) exposed = true; // no shield (capitals): hull, always
    if (rec.exposed === exposed) return; // idempotent -- no redundant churn
    mountShipColliders(this.world, rec.body, kind, exposed);
    rec.exposed = exposed;
  }

  /**
   * Per-tick player input → physics. Drifty-arcade model:
   *
   *   1. **Throttle** — forward impulse magnitude `kind.thrustImpulse`,
   *      multiplied by `kind.boostMultiplier` if boost is held alongside
   *      forward thrust. Reverse is `-kind.reverseFactor` of the same
   *      magnitude; pressing both cancels. Steady-state speed is the natural
   *      terminal of `impulse / (1 - e^(-damping/60))`; per-kind numbers in
   *      `shipKinds.ts` are derived from that formula.
   *   2. **Snappy turn** — angular velocity is set directly to the
   *      `±kind.maxAngvel` target while a turn key is held; releasing both
   *      keys leaves `angvel` alone and lets `kind.angularDamping` decay it
   *      naturally. This matches a top-down arcade-car feel: when you steer,
   *      the ship responds; when you let go, the yaw winds down. Earlier
   *      versions tried torque-impulse easing here but were silently
   *      underpowered by ~70× because `applyTorqueImpulse` divides by
   *      moment-of-inertia (`0.5 * m * r²`), not mass.
   *   3. **Lateral-grip filter** — decomposes `linvel` against the body's
   *      facing into forward + lateral components, then writes back
   *      `v - lateral * kind.lateralGrip`. This is a 1-pole low-pass on the
   *      lateral component; unconditionally stable for grip ∈ [0, 1] at the
   *      fixed 60 Hz step. `grip = 0` reproduces the old space-feel.
   *   4. **Max-speed clamp** — caps `|linvel|` at `kind.maxSpeed`. Cars don't
   *      run away from the camera.
   *
   * The throttle, lateral-grip, and max-speed steps run **every** tick — even
   * when no key is held — so a body that's coasting after release continues
   * to bleed lateral velocity and stays inside its speed envelope. The turn
   * step deliberately does NOT run on no-input so the angvel can decay
   * naturally instead of snapping to zero.
   *
   * Silently no-ops on unknown ids so a stale input posted after despawn is
   * harmless (matches `applyImpulse`).
   */
  applyInput(id: string, input: ShipInput): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    applyPilotInput(rec, input);
  }

  /**
   * NPC warp-to (wrap-up W2a, flagship fleets): the same spool → run → drop
   * machine as a pilot's (`stepWarp`), driven by a held target instead of the
   * input stream. Server worker only: drones are snapshot-interpolated on the
   * client, never predicted. `target` null drops the request (cancels a
   * spool; a run can't be cancelled).
   *
   * Returns true while the warp owns the body this tick (spooling, running or
   * dropping): the caller skips the AI's impulse. While spooling the drive
   * turns the ship to face its target. A ship flown by control keys (the
   * pilot layer: `keys` is this tick's AI input, or `null` on a tick
   * without one) spools the way a pilot's ship does (`applyInput`): its
   * thrust, boost and reverse still work, its turn keys are ignored, so a
   * fleeing ship keeps flying along its escape line instead of stopping dead
   * (take 7, 2026-11-14). A ship that is not (`keys` undefined: the impulse
   * path, a flagship fleet's capital) holds still while it spools.
   */
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
    if (!rec) return;
    const body = rec.body;
    const v = body.linvel();
    this._kickVel.x = v.x + dvx;
    this._kickVel.y = v.y + dvy;
    body.setLinvel(this._kickVel, true);
    body.setAngvel(body.angvel() + dw, true);
  }

  private readonly _kickVel = { x: 0, y: 0 };

  /** Apply a linear impulse (jx, jy) at world point (px, py), so an
   *  off-centre blow also turns the body (a capital wreck piece knocked by an
   *  overkill shell). Wakes it. Unknown id ⇒ no-op. Alloc-free. */
  applyImpulseAtPoint(id: string, jx: number, jy: number, px: number, py: number): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this._impJ.x = jx;
    this._impJ.y = jy;
    this._impP.x = px;
    this._impP.y = py;
    rec.body.applyImpulseAtPoint(this._impJ, this._impP, true);
  }

  private readonly _impJ = { x: 0, y: 0 };
  private readonly _impP = { x: 0, y: 0 };

  /**
   * Apply a linear impulse (jx, jy) at world point (px, py) to a GROUP of
   * bodies as if they were one rigid body (a capital wreck still inside its
   * crack hold, hit by the rest of a salvo). The group's motion is first made
   * exactly rigid from its momentum (centre-of-mass velocity from the linear
   * momentum, spin from the angular momentum about the centre of mass over
   * the group's moment of inertia, parallel-axis theorem), then
   *   Δv = J ÷ M,  Δω = (r × J) ÷ I,
   * and every body gets v_com + ω × r_i and spin ω, so the pieces keep their
   * relative poses. Unknown ids are skipped (pieces already gone). Wakes the
   * bodies. Alloc-free apart from Rapier's own vector getters.
   */
  applyRigidGroupImpulse(ids: readonly string[], jx: number, jy: number, px: number, py: number): void {
    let m = 0, cx = 0, cy = 0, momX = 0, momY = 0;
    for (let i = 0; i < ids.length; i++) {
      const rec = this.bodies.get(ids[i]!);
      if (!rec) continue;
      const b = rec.body;
      const mi = b.mass();
      const c = b.worldCom();
      const v = b.linvel();
      m += mi; cx += c.x * mi; cy += c.y * mi; momX += v.x * mi; momY += v.y * mi;
    }
    if (!(m > 0)) return;
    cx /= m; cy /= m;
    let vx = momX / m, vy = momY / m;
    // Angular momentum and inertia about the group's centre of mass.
    let l = 0, inertia = 0;
    for (let i = 0; i < ids.length; i++) {
      const rec = this.bodies.get(ids[i]!);
      if (!rec) continue;
      const b = rec.body;
      const mi = b.mass();
      const c = b.worldCom();
      const v = b.linvel();
      const rx = c.x - cx, ry = c.y - cy;
      const ii = b.principalInertia();
      inertia += ii + mi * (rx * rx + ry * ry);
      l += ii * b.angvel() + mi * (rx * (v.y - vy) - ry * (v.x - vx));
    }
    let w = inertia > 0 ? l / inertia : 0;
    vx += jx / m;
    vy += jy / m;
    if (inertia > 0) w += ((px - cx) * jy - (py - cy) * jx) / inertia;
    for (let i = 0; i < ids.length; i++) {
      const rec = this.bodies.get(ids[i]!);
      if (!rec) continue;
      const b = rec.body;
      const c = b.worldCom();
      this._kickVel.x = vx - w * (c.y - cy);
      this._kickVel.y = vy + w * (c.x - cx);
      b.setLinvel(this._kickVel, true);
      b.setAngvel(w, true);
    }
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
    const body = rec.body;
    const t = this._setShipStateTranslationScratch;
    t.x = state.x; t.y = state.y;
    body.setTranslation(t, false);
    const v = this._setShipStateLinvelScratch;
    v.x = state.vx; v.y = state.vy;
    body.setLinvel(v, false);
    body.setRotation(state.angle, false);
    if (state.angvel !== undefined) body.setAngvel(state.angvel, false);
    body.sleep();
  }

  /** True when Rapier reports the body as sleeping (motion below its threshold). */
  isSleeping(id: string): boolean {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    return rec.body.isSleeping() || rec.body.isFixed(); // fixed (cut-field rock): never simulates, so quiet
  }

  /**
   * Settle-to-sleep (`sleepSettle.ts`): once body `id` has moved slower than
   * `speed` (u/s) and spun slower than `spin` (rad/s) for `WRECK_SETTLE_STEPS`
   * fixed steps in a row it is put to sleep; a body an active tractor field
   * targets never settles, and while held its linear damping is capped at
   * `BEAMED_LINEAR_DAMPING`. `speed <= 0` removes it. Unknown id ⇒ no-op.
   */
  setSleepSettle(id: string, speed: number, spin: number): void {
    const rec = this.bodies.get(id);
    if (rec) this.settle.set(id, rec.body, speed, spin);
  }

  private readonly settle = new SleepSettle();

  /** Dev-only (the worker's wake census, `EQX_WAKE_CENSUS`): the entity id
   *  and speed of the fastest body `id` has a live contact point with, or
   *  null when it touches nothing. Not on any hot path. */
  fastestContact(id: string): { otherId: string; speed: number } | null {
    const rec = this.bodies.get(id);
    if (!rec) return null;
    const np = this.world.narrowPhase;
    let best: { otherId: string; speed: number } | null = null;
    const numCol = rec.body.numColliders();
    for (let ci = 0; ci < numCol; ci++) {
      const col = rec.body.collider(ci);
      if (!col) continue;
      np.contactPairsWith(col.handle, (otherHandle) => {
        let live = false;
        np.contactPair(col.handle, otherHandle, (manifold) => { if (manifold.numContacts() > 0) live = true; });
        if (!live) return;
        const parent = this.world.getCollider(otherHandle)?.parent();
        if (!parent) return;
        const otherId = this.handleToId.get(parent.handle);
        if (otherId === undefined) return;
        const v = parent.linvel();
        const speed = Math.hypot(v.x, v.y);
        if (best === null || speed > best.speed) best = { otherId, speed };
      });
    }
    return best;
  }

  /** Force-wake a body. Safe no-op if already awake or unknown. */
  wakeUp(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.wakeUp();
  }

  /**
   * Lock a body's translations and rotations. The body still participates in
   * collision detection (other bodies bounce off it as if it had infinite
   * mass) but `world.step()` no longer integrates it. Used by the client's
   * swarm-mirror so reconciler replay doesn't drift swarm bodies between
   * authoritative wire packets.
   */
  /** Set a body's angular damping (capital wreck pieces settle, S2a). */
  setAngularDamping(id: string, damping: number): void {
    this.bodies.get(id)?.body.setAngularDamping(damping);
  }

  /** FIXED terrain (cut-field rocks): never simulated or solved, unlike a `lockBody` body; same call on the server worker and predWorld (#15). */
  fixBody(id: string): void { this.bodies.get(id)?.body.setBodyType(RAPIER.RigidBodyType.Fixed, true); }
  /** Wake a fixed body into a dynamic one (a rammed rock), keeping its colliders and mass. */
  unfixBody(id: string): void { const b = this.bodies.get(id)?.body; if (b?.isFixed()) { b.setBodyType(RAPIER.RigidBodyType.Dynamic, true); b.wakeUp(); } }

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
    if (!rec) return;
    const body = rec.body;
    // 2026-05-25 heap-growth fix — reuse pooled Vector2 scratches
    // instead of allocating `{x, y}` literals per call. Rapier copies
    // values synchronously, so reuse is safe (next call overwrites).
    const t = this._setShipStateTranslationScratch;
    t.x = state.x; t.y = state.y;
    body.setTranslation(t, true);
    const v = this._setShipStateLinvelScratch;
    v.x = state.vx; v.y = state.vy;
    body.setLinvel(v, true);
    body.setRotation(state.angle, true);
    if (state.angvel !== undefined) body.setAngvel(state.angvel, true);
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
    if (!rec) return null;
    const body = rec.body;
    const t = body.translation();
    const v = body.linvel();
    return { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y, angvel: body.angvel() };
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
    const result = new Map<string, ShipPhysicsState>();
    for (const [id, rec] of this.bodies) {
      // Sub-cap break-up slice 2: the worker passes the bodies that have been
      // asleep (and flagged so in the SAB) since before this tick; their SAB
      // record is already their resting pose, so they cost no Rapier read and
      // no allocation here (permanent debris that has settled is near free).
      if (skip !== undefined && skip.has(id)) continue;
      const t = rec.body.translation();
      const v = rec.body.linvel();
      result.set(id, { x: t.x, y: t.y, angle: rec.body.rotation(), vx: v.x, vy: v.y, angvel: rec.body.angvel() });
    }
    return result;
  }

  hasShip(id: string): boolean {
    return this.bodies.has(id);
  }

  /**
   * Diagnostic-only — inspect Rapier's resolved contact state for a body's
   * colliders. Iterates every contact pair the body participates in and
   * returns the deepest contact with the largest impulse, plus the contact
   * normal direction. Used by the ramming probe to surface why the resolver
   * is settling at non-zero penetration under continuous thrust.
   *
   * Returns null if the body has no contacts this step.
   */
  queryContactState(id: string): {
    normal: { x: number; y: number };
    penetration: number;
    impulse: number;
    contactCount: number;
    otherBodyId: string | null;
  } | null {
    const rec = this.bodies.get(id);
    if (!rec) return null;
    const np = this.world.narrowPhase;
    let bestNormal = { x: 0, y: 0 };
    let bestPenetration = 0;
    let bestImpulse = 0;
    let totalContacts = 0;
    let bestOtherId: string | null = null;
    const numCol = rec.body.numColliders();
    for (let ci = 0; ci < numCol; ci++) {
      const col = rec.body.collider(ci);
      if (!col) continue;
      np.contactPairsWith(col.handle, (otherHandle) => {
        np.contactPair(col.handle, otherHandle, (manifold, flipped) => {
          const n = manifold.normal();
          const count = manifold.numContacts();
          totalContacts += count;
          for (let i = 0; i < count; i++) {
            const dist = manifold.contactDist(i);
            const imp = manifold.contactImpulse(i);
            const pen = -dist;
            if (pen > bestPenetration) {
              bestPenetration = pen;
              bestNormal = flipped ? { x: -n.x, y: -n.y } : { x: n.x, y: n.y };
              bestImpulse = imp;
              const otherCol = this.world.getCollider(otherHandle);
              const otherParent = otherCol?.parent();
              if (otherParent) {
                bestOtherId = this.handleToId.get(otherParent.handle) ?? null;
              }
            }
          }
        });
      });
    }
    if (totalContacts === 0) return null;
    return {
      normal: bestNormal,
      penetration: bestPenetration,
      impulse: bestImpulse,
      contactCount: totalContacts,
      otherBodyId: bestOtherId,
    };
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
    this._raySkip = skipId ?? null;
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
      skipId ? this._rayPredicate : undefined,
      halfWidth,
    );
    this._raySkip = null;
    return hit;
  }

  /** The skip test for the `hitscan` call in progress (null outside one). */
  private _raySkip: ((id: string) => boolean) | null = null;
  /** Built once, not per call (invariant #14): keeps a collider unless its
   *  body's id is skipped. Walls (not in `handleToId`) are never skipped. */
  private readonly _rayPredicate = (collider: RAPIER.Collider): boolean => {
    const skip = this._raySkip;
    if (skip === null) return true;
    const parent = collider.parent();
    if (!parent) return true;
    const id = this.handleToId.get(parent.handle);
    return id === undefined || !skip(id);
  };

  dispose(): void {
    this.world.free();
  }
}
