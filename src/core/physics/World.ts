import RAPIER from '@dimforge/rapier2d-compat';
import { shipCollisionTriangles } from '../geometry/triangulate.js';
import { polygonArea, verticesToFloat32, type Vec2 } from '../swarm/asteroidShape.js';
import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';

const FIXED_DT = 1 / 60;

/**
 * Shared config for EVERY ship/drone collider (the cheap ball OR each hull
 * polygon triangle). Density is 0 on all of them: the body's mass + inertia
 * come entirely from setAdditionalMassProperties (pinned once in spawnShip
 * to the legacy disc-equivalent), which is what makes the shield 0-cross
 * collider swap dynamically transparent. Contact-force events stay enabled
 * on every piece so ramming + the contact drain still fire with N colliders.
 */
function configureShipCollider(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setDensity(0)
    .setRestitution(0.3)
    .setFriction(0)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(10);
}

function shipBallColliderDesc(radius: number): RAPIER.ColliderDesc {
  return configureShipCollider(RAPIER.ColliderDesc.ball(radius));
}

/**
 * Re-export of the legacy `BOOST_MULTIPLIER` constant. The authoritative value
 * is now per-kind (`ShipKind.boostMultiplier`), but a handful of older test
 * suites and docs imported it from here. Kept for back-compat — the value is
 * sourced from the default kind so behaviour is unchanged on legacy callers.
 */
export { BOOST_MULTIPLIER } from '../../shared-types/shipKinds.js';

export interface ShipPhysicsState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  /** Angular velocity in rad/s. Optional for back-compat with server snapshots that omit it. */
  angvel?: number;
}

export interface ShipInput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** Shift-held boost — multiplies thrust impulse by `kind.boostMultiplier`
   *  while thrust is also held. No-op on its own. Optional for back-compat. */
  boost?: boolean;
  /** S / Down arrow held — applies a (typically) reduced-magnitude impulse in
   *  the opposite direction of the ship's facing. Cancels with thrust if both
   *  are pressed. Optional for back-compat with replay buffers / unit tests
   *  written before reverse landed. */
  reverse?: boolean;
}

interface ShipBody {
  body: RAPIER.RigidBody;
  kind: ShipKind;
  /** Current collider geometry: false = cheap CIRCLE (shield up), true =
   *  exact HULL polygon compound (shield down). Owned by setHullExposed. */
  exposed: boolean;
}

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private bodies = new Map<string, ShipBody>();
  /** Reverse lookup: Rapier rigid-body handle → entity ID, for hitscan results. */
  private handleToId = new Map<number, string>();

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0 });
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
      this.world.step(eventQueue);
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
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(kind.linearDamping)
      .setAngularDamping(kind.angularDamping);
    const body = this.world.createRigidBody(bodyDesc);
    // Mass + inertia are pinned ONCE to the legacy disc-equivalent so the
    // shield 0-cross collider swap (setHullExposed) is DYNAMICALLY
    // TRANSPARENT: a uniform ball(r) at density 1/(pi r^2) has mass 1 and
    // angular inertia 0.5*m*r^2. Every ship collider is ZERO-density, so the
    // body's mass/inertia are exactly these additional mass-props no matter
    // which collider shape is mounted.
    //
    // Rapier folds total mass = collider-contributions + additional-props
    // only at the next world.step() (per @dimforge/rapier2d-compat
    // rigid_body.d.ts:377/395). We MUST recompute right here so the pinned
    // mass is live before the first step (otherwise a pre-step applyImpulse
    // sees inverse-mass 0 and is silently dropped). recomputeMassProperties-
    // FromColliders is SAFE and REQUIRED here precisely because it recomputes
    // the TOTAL (zero colliders + the stored additional = mass 1, I = 0.5 r^2)
    // -- "FromColliders" is a misnomer; it includes the additional props.
    this.world.createCollider(shipBallColliderDesc(kind.radius), body);
    body.setAdditionalMassProperties(1, { x: 0, y: 0 }, 0.5 * kind.radius * kind.radius, true);
    body.recomputeMassPropertiesFromColliders();
    this.bodies.set(id, { body, kind, exposed: false });
    this.handleToId.set(body.handle, id);
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
  ): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(0)
      .setAngularDamping(0);
    const body = this.world.createRigidBody(bodyDesc);

    let collider: RAPIER.ColliderDesc | null = null;
    if (vertices && vertices.length >= 3) {
      const flat = verticesToFloat32(vertices);
      collider = RAPIER.ColliderDesc.convexHull(flat);
      if (collider) {
        const area = polygonArea(vertices);
        const density = area > 0 ? mass / area : mass / (Math.PI * radius * radius);
        collider.setRestitution(0.8).setFriction(0).setDensity(density);
      }
    }
    if (!collider) {
      const density = mass / (Math.PI * radius * radius);
      collider = RAPIER.ColliderDesc.ball(radius).setRestitution(0.8).setFriction(0).setDensity(density);
    }
    // Stage 2: enable contact-force events on obstacles too — ship-vs-asteroid
    // collisions are the dominant case the network-feel collision-event
    // broadcast addresses.
    collider
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(10);
    this.world.createCollider(collider, body);
    // Obstacles are tracked under the default kind purely so the bodies map
    // shape stays uniform; obstacle physics never reads this kind back.
    this.bodies.set(id, { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false });
    this.handleToId.set(body.handle, id);
  }

  /** Spawn a fast-moving kinematic projectile body (sensor — no physics impulses). */
  spawnProjectile(id: string, x: number, y: number, vx: number, vy: number, radius: number): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinvel(vx, vy)
      .setLinearDamping(0)
      .setAngularDamping(0);
    const body = this.world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.ball(radius)
      .setSensor(true)
      .setDensity(0.001);
    this.world.createCollider(collider, body);
    this.bodies.set(id, { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false });
    this.handleToId.set(body.handle, id);
  }

  despawnShip(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    this.handleToId.delete(rec.body.handle);
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(id);
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
    if (rec.exposed === exposed) return; // idempotent -- no redundant churn
    const body = rec.body;
    // Collect-then-remove: removeCollider mutates the body's collider list,
    // so iterating by live index while removing would skip colliders.
    const cols: RAPIER.Collider[] = [];
    for (let i = 0; i < body.numColliders(); i++) cols.push(body.collider(i));
    for (const c of cols) this.world.removeCollider(c, true);
    if (exposed) {
      for (const t of shipCollisionTriangles(kind.id)) {
        this.world.createCollider(
          configureShipCollider(RAPIER.ColliderDesc.triangle(t[0], t[1], t[2])),
          body,
        );
      }
    } else {
      this.world.createCollider(shipBallColliderDesc(kind.radius), body);
    }
    // Re-fold the pinned additional mass-props now (Rapier otherwise defers
    // to the next step). Total stays mass 1 / I 0.5r^2 -- the new colliders
    // are zero-density and the additional props were never cleared.
    body.recomputeMassPropertiesFromColliders();
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
    const { body, kind } = rec;

    // Forward direction at the body's current facing. The visual "nose" is
    // local -Y in Pixi (see `buildShipGfx`), which maps to (-sin θ, cos θ)
    // in Rapier (Y-up).
    const angle = body.rotation();
    const fx = -Math.sin(angle);
    const fy =  Math.cos(angle);

    // ---- 1. Throttle (forward + reverse, cancellable) ----------------------
    const fwd = input.thrust  ? 1 : 0;
    const rev = input.reverse ? kind.reverseFactor : 0;
    const throttle = fwd - rev;
    if (throttle !== 0) {
      const boostMul = input.boost && throttle > 0 ? kind.boostMultiplier : 1;
      const mag = kind.thrustImpulse * boostMul * throttle;
      body.applyImpulse({ x: fx * mag, y: fy * mag }, true);
    }

    // ---- 2. Snappy turn (direct setAngvel, snap-stop on release) ---------
    // Holding A/D writes the target angvel directly; releasing both keys
    // writes 0. This makes per-tap rotation linear in tap duration — a
    // 100 ms tap of `maxAngvel = 2.5` gives exactly 0.25 rad ≈ 14°, which
    // is what you want for aim. An earlier version left the angvel to decay
    // via `angularDamping`, but the post-release decay integrates to
    // `maxAngvel / angularDamping` rad of additional rotation per tap (≈18°
    // at the v1 numbers) — half of every tap was happening AFTER you let go,
    // making fine aim impossible.
    const target = (input.turnLeft ? 1 : 0) - (input.turnRight ? 1 : 0);
    body.setAngvel(target * kind.maxAngvel, true);

    // ---- 3. Lateral-grip filter (1-pole low-pass on sideways component) ---
    if (kind.lateralGrip > 0) {
      const v = body.linvel();
      const fwdComp = v.x * fx + v.y * fy;
      const latX = v.x - fwdComp * fx;
      const latY = v.y - fwdComp * fy;
      if (latX !== 0 || latY !== 0) {
        body.setLinvel(
          { x: v.x - latX * kind.lateralGrip, y: v.y - latY * kind.lateralGrip },
          true,
        );
      }
    }

    // ---- 4. Max-speed clamp ----------------------------------------------
    const v2 = body.linvel();
    const sp2 = v2.x * v2.x + v2.y * v2.y;
    const cap2 = kind.maxSpeed * kind.maxSpeed;
    if (sp2 > cap2) {
      const k = kind.maxSpeed / Math.sqrt(sp2);
      body.setLinvel({ x: v2.x * k, y: v2.y * k }, true);
    }
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

  /** True when Rapier reports the body as sleeping (motion below its threshold). */
  isSleeping(id: string): boolean {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    return rec.body.isSleeping();
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
  lockBody(id: string): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.body.lockTranslations(true, false);
    rec.body.lockRotations(true, false);
  }

  /**
   * Rename a body's lookup key without disturbing the underlying
   * Rapier rigid body. Used by the Phase 4 abandon flow: the wreck's
   * body must outlive its original playerId so the player can rejoin
   * the room (same playerId) without `spawnShip(playerId, ...)`
   * overwriting the wreck's entry in `this.bodies` and orphaning the
   * body. No-op when `oldId` is absent or `newId` is already taken.
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
    body.setTranslation({ x: state.x, y: state.y }, true);
    body.setLinvel({ x: state.vx, y: state.vy }, true);
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

  getAllShipStates(): Map<string, ShipPhysicsState> {
    const result = new Map<string, ShipPhysicsState>();
    for (const [id, rec] of this.bodies) {
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
   * Cast a ray through the world and return the first entity hit (excluding the shooter).
   * Returns null if no entity is within maxDist along the ray.
   */
  hitscan(
    fromX: number, fromY: number,
    dirX: number, dirY: number,
    maxDist: number,
    excludeId: string,
  ): { hitId: string; dist: number } | null {
    const excludeRec = this.bodies.get(excludeId);
    const ray = new RAPIER.Ray({ x: fromX, y: fromY }, { x: dirX, y: dirY });
    const hit = this.world.castRay(
      ray,
      maxDist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      excludeRec?.body,
    );
    if (!hit) return null;
    const parentBody = hit.collider.parent();
    if (!parentBody) return null;
    const hitId = this.handleToId.get(parentBody.handle);
    if (!hitId) return null;
    return { hitId, dist: hit.timeOfImpact };
  }

  dispose(): void {
    this.world.free();
  }
}
