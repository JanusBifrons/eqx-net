import RAPIER from '@dimforge/rapier2d-compat';
import { shipCollisionTriangles } from '../geometry/shipHullDecomp.js';
import { polygonArea, verticesToFloat32, type Vec2 } from '../swarm/asteroidShape.js';
import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  SHIELD_RADIUS_PAD,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import { configureShipCollider, shipBallColliderDesc } from './colliderConfig.js';
import { applyShipInput } from './applyShipInput.js';
import { castHitscan } from './hitscanRay.js';
import { wallGeometry } from '../structures/ShieldWall.js';

const FIXED_DT = 1 / 60;

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
   *  is called per-drone per-RAF on the client (kinematic follower for
   *  snapshot-interpolated drones) — at 25 drones × 90 RAFs/sec the
   *  prior `{x, y}` literals were 2 × 2250 = 4500 allocations/sec just
   *  from this method. Rapier's API takes Vector2-like objects, so we
   *  reuse a single instance per call site. Safe because rapier copies
   *  the values into native memory synchronously inside the call. */
  private readonly _setShipStateTranslationScratch = { x: 0, y: 0 };
  private readonly _setShipStateLinvelScratch = { x: 0, y: 0 };

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
    // Shield collider radius = kind.radius + SHIELD_RADIUS_PAD so the
    // physics ball matches the visible shield aura (ShieldAura ring at
    // the same pad). Pinned mass + inertia stay derived from the bare
    // `kind.radius` — they're a kind-feel knob, not a function of the
    // current collider geometry (the pad doesn't change ship handling).
    this.world.createCollider(shipBallColliderDesc(kind.radius + SHIELD_RADIUS_PAD), body);
    // Per-kind mass with a `default 1` back-compat path: every legacy
    // kind sat at mass 1 historically (the pinned value below), so
    // omitting `kind.mass` keeps every existing physics test byte-
    // identical. Inertia stays the disc formula `0.5 * m * r²` so a
    // heavier kind also rotates proportionally more sluggishly under
    // torque — same physical reality as a denser uniform disc.
    const m = kind.mass ?? 1;
    body.setAdditionalMassProperties(m, { x: 0, y: 0 }, 0.5 * m * kind.radius * kind.radius, true);
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
    linearDamping = 0,
    collisionGroups?: number,
  ): void {
    // WS-11 (R2.25) — `linearDamping` defaults to 0 so ASTEROIDS + STRUCTURES
    // stay ballistic (no friction), but DRONES pass their per-kind
    // `ShipKind.linearDamping` (exactly like `spawnShip` does, World.ts:152) so
    // the AI standoff/brake has something to settle against. Before this, drone
    // bodies had ZERO damping and the AI-impulse path bypasses the player's
    // max-speed clamp, so once a drone overshot its target it coasted away
    // FOREVER (thrust=0 inside the standoff + no friction) — the "flies past /
    // floats / never approaches" bug.
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(linearDamping)
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
    const isBall = !(vertices && vertices.length >= 3);
    if (!collider) {
      // Drone / plain-obstacle ball: ZERO density + a pinned additional
      // mass (set after createCollider below) so setHullExposed\u2019s
      // circle<->hull swap is dynamically transparent for drones, exactly
      // like spawnShip. Mathematically identical to the legacy
      // mass/(pi r^2) ball for any body that never swaps. Asteroids
      // (convexHull branch) keep real area-density — they never swap.
      collider = RAPIER.ColliderDesc.ball(radius).setRestitution(0.8).setFriction(0).setDensity(0);
    }
    // Stage 2: enable contact-force events on obstacles too — ship-vs-asteroid
    // collisions are the dominant case the network-feel collision-event
    // broadcast addresses.
    collider
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(10);
    // Scrap-on-death (Phase 2b-i) — an optional collision-group mask. Used by
    // SCRAP bodies (SCRAP_COLLISION_GROUPS) so scrap does NOT collide with
    // other scrap but DOES collide with everything else. Omitted ⇒ Rapier's
    // default groups (collide with all), so every existing caller is unchanged.
    if (collisionGroups !== undefined) collider.setCollisionGroups(collisionGroups);
    this.world.createCollider(collider, body);
    if (isBall) {
      // Pin mass to the disc-equivalent (mass param, I = 0.5 m r^2),
      // identical to what the legacy density ball produced. See spawnShip.
      body.setAdditionalMassProperties(mass, { x: 0, y: 0 }, 0.5 * mass * radius * radius, true);
      body.recomputeMassPropertiesFromColliders();
    }
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
    if (rec.exposed === exposed) return; // idempotent -- no redundant churn
    const body = rec.body;
    // Collect-then-remove: removeCollider mutates the body's collider list,
    // so iterating by live index while removing would skip colliders.
    const cols: RAPIER.Collider[] = [];
    for (let i = 0; i < body.numColliders(); i++) cols.push(body.collider(i));
    for (const c of cols) this.world.removeCollider(c, true);
    if (exposed) {
      // TRIANGLE colliders, fan-triangulated from each convex part
      // (`shipCollisionTriangles`). The 2026-05-28 `convexHull`-per-part
      // experiment (BISECT ARM A) was REVERTED on 2026-06-11: in Rapier 2D
      // ONLY `triangle` shapes fire `CONTACT_FORCE_EVENTS` for two bodies
      // overlapping at zero closing velocity — `convexHull`/`cuboid` emit
      // none (the bare-Rapier diagnostic in `hullCollisionNoTouch.test.ts`
      // proves all three). The ram-damage telemetry AND the
      // `t-ship-no-self-collision` E2E positive control both depend on those
      // static-overlap events, so convexHull silently broke them (the
      // positive control had been RED since 2026-05-28). The convexHull
      // "interior-diagonal artifact" concern is moot: a body can't reach an
      // interior fan diagonal without first crossing an exterior edge (which
      // blocks it), and steady-state penetration is owned by the stiff solver
      // (`PhysicsWorld.create` — numSolverIterations 16 + small-steps PGS),
      // not the collider shape. This matches the documented invariant in
      // src/core/CLAUDE.md ("setHullExposed emits triangle, NOT convexHull").
      for (const t of shipCollisionTriangles(kind.id)) {
        this.world.createCollider(
          configureShipCollider(
            RAPIER.ColliderDesc.triangle(
              new RAPIER.Vector2(t[0].x, t[0].y),
              new RAPIER.Vector2(t[1].x, t[1].y),
              new RAPIER.Vector2(t[2].x, t[2].y),
            ),
          ),
          body,
        );
      }
    } else {
      // Shield up — ball collider extends `SHIELD_RADIUS_PAD` past the hull
      // (same constant as the visual ShieldAura ring) so the rapier
      // collider matches what the player sees.
      this.world.createCollider(shipBallColliderDesc(kind.radius + SHIELD_RADIUS_PAD), body);
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
    applyShipInput(rec.body, rec.kind, input);
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
  ): { hitId: string; dist: number } | null {
    const excludeRec = this.bodies.get(excludeId);
    return castHitscan(
      this.world,
      this.handleToId,
      fromX,
      fromY,
      dirX,
      dirY,
      maxDist,
      excludeRec?.body,
      this.wallHandleToId,
    );
  }

  dispose(): void {
    this.world.free();
  }
}
