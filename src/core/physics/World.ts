import RAPIER from '@dimforge/rapier2d-compat';
import { shipCollisionTriangles } from '../geometry/shipHullDecomp.js';
import { polygonArea, verticesToFloat32, type Vec2 } from '../swarm/asteroidShape.js';
import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import { configureShipCollider, shipShieldColliderDesc } from './colliderConfig.js';
import { applyShipInput, type ShipInputArgs, type ShipInputMultipliers } from './applyShipInput.js';
import { newWarpState, stepWarp, WARP_ALIGN_GAIN, WARP_EXIT_SPEED, WARP_SPEED, WARP_SPOOL_TICKS, type WarpPhase, type WarpState } from './warpDrive.js';
/** NPC warp-to: a bot engages only once within this of facing its target (rad). */
const BOT_WARP_ALIGN_RAD = 0.06;
/** NPC warp-to: the slowest a bot turns to face its jump (rad/s; 9°/s, so a
 *  battleship comes about in ~20 s instead of 2.5 min at its 1.2°/s helm). */
const BOT_WARP_MIN_TURN = Math.PI / 20;
import { castHitscan } from './hitscanRay.js';
import { wallGeometry } from '../structures/ShieldWall.js';
import { PAD_PUSH_ACCEL, padPushDir } from '../../shared-types/teleport.js';
import { massOf, shipAngularInertia } from '../../shared-types/shipScale/tuning.js';
import { CapitalOverlapResolver, newCapitalEntry } from './capitalOverlap.js';

const FIXED_DT = 1 / 60;

/**
 * Re-export of the legacy `BOOST_MULTIPLIER` constant. The authoritative value
 * is now per-kind (`ShipKind.boostMultiplier`), but a handful of older test
 * suites and docs imported it from here. Kept for back-compat — the value is
 * sourced from the default kind so behaviour is unchanged on legacy callers.
 */
export { BOOST_MULTIPLIER } from '../../shared-types/shipKinds.js';

/**
 * Soft-CCD prediction distance (u) for every dynamic body (plan
 * soft-leaping-truffle PR-C). Ship movement has no ray-projection, so without
 * this a body whose centre crossed a thin wall's midline within one 60 Hz step
 * was ejected out the far side. Measured 2026-10-31 (16 u walls, cuboid +
 * trimesh, shields up/down, 90/60/30°, ~46 u/tick = 2× the fastest flyable
 * ship at max topSpeed upgrade): prediction 0 → 10–27 pass-throughs per sweep;
 * 32 / 64 / 96 → 0. 48 = 2× max per-tick travel. Larger values widen the
 * broad-phase (Rapier docs), so this is kept tight; raise only with a
 * re-measurement (World.ccd.test.ts).
 */
export const SOFT_CCD_PREDICTION = 48;

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
  /** In-sector warp-to (Phase 4): the drop point asked for this tick. Held
   *  while the pilot wants the warp; absent = no request (cancels a spool).
   *  Run through `stepWarp` (warpDrive.ts) identically on both sides. */
  warpX?: number;
  warpY?: number;
}

interface ShipBody {
  body: RAPIER.RigidBody;
  kind: ShipKind;
  /** Current collider geometry: false = cheap CIRCLE (shield up), true =
   *  exact HULL polygon compound (shield down). Owned by setHullExposed. */
  exposed: boolean;
  /** Phase 4 WS-B2 — per-instance PHYSICS stat multipliers (`topSpeed`,
   *  `turnRate`), set via `setStatMultipliers`. Threaded into `applyShipInput`
   *  so the server sim + client prediction scale movement identically (risk
   *  #1). `undefined` ⇒ no upgrades ⇒ byte-identical to the legacy path. */
  statMul?: ShipInputMultipliers;
  /** In-sector warp-to state; created on the first warp request. */
  warp?: WarpState;
  /** Pilot layer: the ShipKind an AI slot flies with when driven by input
   *  bits (`applyAiInput`). Set at drone spawn (`SPAWN_OBSTACLE.shipKindId`).
   *  Kept apart from `kind` (an obstacle's placeholder default kind, which
   *  other paths such as the bot warp align still read). */
  pilotKind?: ShipKind;
  /** True once `applyAiInput` has given the body its kind's damping. */
  piloted?: boolean;
}

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private bodies = new Map<string, ShipBody>();
  /** v4 T2 — teleporter pad fields (see `setPadField`). */
  private readonly padFields = new Map<string, { cx: number; cy: number; half: number; active: boolean }>();
  private readonly _padDir = { x: 0, y: 0 };
  private readonly _padImpulse = { x: 0, y: 0 };
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
      this.applyPadFields();
      this.world.step(eventQueue);
      this.capitals.resolve();
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
      .setAngularDamping(kind.angularDamping)
      // Soft CCD (plan soft-leaping-truffle PR-C): predictive contacts along
      // the body's path so it can't tunnel thin static geometry between 60 Hz
      // steps. NOT full CCD — full CCD suppressed static-overlap contact events
      // + under-resolved interpenetration (hullCollisionNoTouch positive
      // control). Lock: World.ccd.test.ts. Same path on server worker + client
      // predWorld (Invariant #15).
      .setSoftCcdPrediction(SOFT_CCD_PREDICTION);
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
    // Shield collider radius = kind.radius + shipTuning(kind).shieldPad =
    // `shieldBubbleRadius(kind)`, the radius the shield aura is drawn at. Pinned mass + inertia stay derived from the bare
    // `kind.radius` — they're a kind-feel knob, not a function of the
    // current collider geometry (the pad doesn't change ship handling).
    this.world.createCollider(shipShieldColliderDesc(kind), body);
    // Per-kind mass with a `default 1` back-compat path: every legacy
    // kind sat at mass 1 historically (the pinned value below), so
    // omitting `kind.mass` keeps every existing physics test byte-
    // identical. Inertia stays the disc formula `0.5 * m * r²` so a
    // heavier kind also rotates proportionally more sluggishly under
    // torque — same physical reality as a denser uniform disc.
    const m = massOf(kind, 1);
    body.setAdditionalMassProperties(m, { x: 0, y: 0 }, shipAngularInertia(m, kind.radius), true);
    body.recomputeMassPropertiesFromColliders();
    const rec: ShipBody = { body, kind, exposed: false };
    this.bodies.set(id, rec);
    this.handleToId.set(body.handle, id);
    this.registerCapital(rec, kind);
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
      .setAngularDamping(0)
      // Soft CCD for every moving obstacle (drones, asteroids, scrap) — see spawnShip.
      .setSoftCcdPrediction(SOFT_CCD_PREDICTION);
    const body = this.world.createRigidBody(bodyDesc);

    // Gates (phase V): a body made of SEVERAL convex parts (two posts, or an
    // airlock's posts + side walls) so ships can pass through the gap between
    // them. Density spreads the requested mass over the total part area.
    if (parts && parts.length > 0) {
      let totalArea = 0;
      for (const p of parts) totalArea += polygonArea(p);
      const density = totalArea > 0 ? mass / totalArea : mass;
      for (const p of parts) {
        const d = RAPIER.ColliderDesc.convexHull(verticesToFloat32(p));
        if (!d) continue;
        d.setRestitution(0.8).setFriction(0).setDensity(density)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(10);
        if (collisionGroups !== undefined) d.setCollisionGroups(collisionGroups);
        // A thin sliver (a capital wreck piece can have one, height < 1 u) has
        // no hull Rapier can build: createCollider throws before touching the
        // world. Skip that part and keep the rest; the same code runs in the
        // server worker and the client predWorld, so both twins skip it.
        try {
          this.world.createCollider(d, body);
        } catch {
          continue;
        }
      }
      this.bodies.set(id, { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false });
      this.handleToId.set(body.handle, id);
      return;
    }

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
    // A drone (any `shieldKind`) spawns shield-up, so it collides as its shield
    // bubble: the SAME `shipShieldColliderDesc` that `setHullExposed(false)`
    // mounts on regen (ball(radius + shieldPad), or the rounded hull for a
    // capital). One place for the server worker and the client predWorld (#15).
    // Before 2026-11-10 non-capital drones got a bare `ball(radius)` here.
    if (!collider && shieldKind) {
      collider = shipShieldColliderDesc(shieldKind);
    }
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
    const rec: ShipBody = { body, kind: getShipKind(DEFAULT_SHIP_KIND), exposed: false };
    this.bodies.set(id, rec);
    this.handleToId.set(body.handle, id);
    // An NPC capital (a drone spawned with its capital kind's shield).
    if (shieldKind) this.registerCapital(rec, shieldKind);
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
    this.capitals.remove(rec.body);
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
   * v4 T2 — a teleporter pad's closing-iris push. While a field is active,
   * every dynamic body straddling the pad edge is nudged fully in or fully
   * out (`padPushDir`, shared) each fixed step. The server worker and the
   * client's prediction world both run this, from the same pad phase, so a
   * pushed ship never judders (#15). Idempotent on `id`.
   */
  setPadField(id: string, cx: number, cy: number, half: number, active: boolean): void {
    const f = this.padFields.get(id);
    if (f) { f.cx = cx; f.cy = cy; f.half = half; f.active = active; return; }
    this.padFields.set(id, { cx, cy, half, active });
  }

  removePadField(id: string): void {
    this.padFields.delete(id);
  }

  private applyPadFields(): void {
    if (this.padFields.size === 0) return;
    for (const f of this.padFields.values()) {
      if (!f.active) continue;
      for (const rec of this.bodies.values()) {
        const b = rec.body;
        if (!b.isDynamic()) continue;
        // TODO: alloc-debt — Rapier's translation() returns a fresh vector; this
        // runs only during a pad's ~4 s closing phase.
        const t = b.translation();
        if (!padPushDir(f.cx, f.cy, f.half, t.x, t.y, rec.kind.radius, this._padDir)) continue;
        const j = b.mass() * PAD_PUSH_ACCEL * FIXED_DT;
        this._padImpulse.x = this._padDir.x * j;
        this._padImpulse.y = this._padDir.y * j;
        b.applyImpulse(this._padImpulse, true);
      }
    }
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
      // Shield up — the shield collider (`shipTuning` pad past the hull, the
      // same bubble the aura draws: `shieldBubbleRadius`).
      this.world.createCollider(shipShieldColliderDesc(kind), body);
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
    if (input.warpX !== undefined || rec.warp !== undefined) {
      const hasReq = input.warpX !== undefined && input.warpY !== undefined;
      if (hasReq) { this._warpReq.x = input.warpX!; this._warpReq.y = input.warpY!; }
      rec.warp ??= newWarpState();
      const body = rec.body;
      const t = body.translation();
      const w = rec.warp;
      const act = stepWarp(w, hasReq ? this._warpReq : null, t.x, t.y, 1 / 60);
      if (act === 'engage') {
        // Face the run (nose = (-sin θ, cos θ)), go, and stop colliding: at
        // ~330 u a tick a body would tunnel or slam into whatever it met.
        body.setRotation(Math.atan2(-w.dx, w.dy), true);
        body.setAngvel(0, true);
        body.setLinvel({ x: w.dx * WARP_SPEED, y: w.dy * WARP_SPEED }, true);
        this.setCollidersEnabled(rec, false);
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
        this.setCollidersEnabled(rec, true);
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
    const s = this._spoolInput;
    s.thrust = input.thrust; s.boost = input.boost; s.reverse = input.reverse;
    applyShipInput(rec.body, rec.kind, s, rec.statMul);
    this.alignToWarp(rec, rec.warp!);
  }

  /**
   * NPC warp-to (wrap-up W2a, flagship fleets): the same spool → run → drop
   * machine as a pilot's (`stepWarp`), driven by a held target instead of the
   * input stream. Server worker only: drones are snapshot-interpolated on the
   * client, never predicted. `target` null drops the request (cancels a
   * spool; a run can't be cancelled).
   *
   * Returns true while the warp owns the body this tick (spooling, running or
   * dropping): the caller skips the AI's impulse. While spooling the ship
   * holds still and turns to face its target.
   */
  botWarp(id: string, target: { x: number; y: number } | null): boolean {
    const rec = this.bodies.get(id);
    if (!rec) return false;
    if (target === null && rec.warp === undefined) return false;
    rec.warp ??= newWarpState();
    const body = rec.body;
    const t = body.translation();
    const w = rec.warp;
    // A slow-turning ship (a capital) keeps spooling until it faces its
    // target: engaging early snapped the hull round in one frame (first fleet
    // film). This is what makes a capital's spool the long one.
    if (target !== null && w.phase === 'spool' && w.ticks >= WARP_SPOOL_TICKS - 1) {
      const want = Math.atan2(-(target.x - t.x), target.y - t.y);
      const d = Math.atan2(Math.sin(want - body.rotation()), Math.cos(want - body.rotation()));
      if (Math.abs(d) > BOT_WARP_ALIGN_RAD) {
        w.tx = target.x; w.ty = target.y;
        const v = body.linvel(); // TODO: alloc-debt (Rapier returns a fresh vector)
        this.setBotVel(body, v.x * 0.9, v.y * 0.9);
        this.alignToWarp(rec, w, BOT_WARP_MIN_TURN);
        return true;
      }
    }
    const act = stepWarp(w, target, t.x, t.y, 1 / 60);
    if (act === 'engage') {
      body.setRotation(Math.atan2(-w.dx, w.dy), true);
      body.setAngvel(0, true);
      this.setBotVel(body, w.dx * WARP_SPEED, w.dy * WARP_SPEED);
      this.setCollidersEnabled(rec, false);
      return true;
    }
    if (act === 'cruise') {
      body.setAngvel(0, true);
      this.setBotVel(body, w.dx * WARP_SPEED, w.dy * WARP_SPEED);
      return true;
    }
    if (act === 'drop') {
      this._botVec.x = w.tx; this._botVec.y = w.ty;
      body.setTranslation(this._botVec, true);
      // An NPC drops out at rest (its AI takes over); a capital coasting on at
      // the pilot's exit speed drifted off its station (fleet film review).
      this.setBotVel(body, 0, 0);
      this.setCollidersEnabled(rec, true);
      return true;
    }
    if (w.phase === 'spool') {
      // Hold position and face the target (a capital turns slowly: its own
      // turn rate caps the align, so a long spool is part of the look).
      const v = body.linvel(); // TODO: alloc-debt (Rapier returns a fresh vector)
      this.setBotVel(body, v.x * 0.9, v.y * 0.9);
      this.alignToWarp(rec, w, BOT_WARP_MIN_TURN);
      return true;
    }
    return false;
  }

  private readonly _botVec = { x: 0, y: 0 };
  private setBotVel(body: RAPIER.RigidBody, vx: number, vy: number): void {
    this._botVec.x = vx; this._botVec.y = vy;
    body.setLinvel(this._botVec, true);
  }

  /** Turn toward the warp target at up to the ship's turn rate. */
  private alignToWarp(rec: ShipBody, w: WarpState, minRate = 0): void {
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

  private readonly _warpReq = { x: 0, y: 0 };
  private readonly _spoolInput: ShipInput = { thrust: false, turnLeft: false, turnRight: false };

  private setCollidersEnabled(rec: ShipBody, on: boolean): void {
    const body = rec.body;
    for (let i = 0; i < body.numColliders(); i++) body.collider(i).setEnabled(on);
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
    if (src === null) {
      if (rec.warp) { Object.assign(rec.warp, newWarpState()); this.setCollidersEnabled(rec, true); }
      return;
    }
    rec.warp ??= newWarpState();
    Object.assign(rec.warp, src);
    // Collisions are off only during the run: match the restored phase.
    this.setCollidersEnabled(rec, rec.warp.phase !== 'cruise');
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

  /** Pilot layer: record the ShipKind an AI slot flies with (`applyAiInput`).
   *  Unknown id ⇒ no-op. */
  setPilotKind(id: string, kind: ShipKind): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.pilotKind = kind;
  }

  /**
   * Pilot layer: drive an AI body with player controls, through the SAME
   * `applyShipInput` a pilot's keys use (thrust, lateral grip, maxSpeed clamp,
   * capital torque turning, per-instance stat multipliers). Flies as
   * `pilotKind` (falls back to the record's `kind`).
   *
   * The first call gives the body its kind's linear + angular damping, as
   * `spawnShip` does: a drone body spawns with angular damping 0 (the impulse
   * path set its spin every tick), and a snap-turn that is released would
   * otherwise spin forever. Bodies never driven by input keep their spawn
   * damping, so the impulse path is unchanged. Unknown id ⇒ no-op.
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
  /** Set a body's angular damping (capital wreck pieces settle, S2a). */
  setAngularDamping(id: string, damping: number): void {
    this.bodies.get(id)?.body.setAngularDamping(damping);
  }

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
    /** Optional: body ids the ray passes through. The client passes its
     *  remote drones/scrap here: their collision bodies run on the predicted
     *  timeline, while the turret aims at the drawn pose, so the caller tests
     *  them at the drawn pose itself. Absent ⇒ every body counts (unchanged). */
    skipId?: (id: string) => boolean,
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
