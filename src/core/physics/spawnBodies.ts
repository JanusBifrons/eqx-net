/**
 * Body + collider builders for `PhysicsWorld` (World.ts): the Rapier body a
 * pilot ship, an obstacle (drone, asteroid, scrap, structure, gate) or a
 * projectile spawns with, and the shield ↔ hull collider swap. Moved verbatim
 * out of World.ts (god-file split); `PhysicsWorld` still owns registration
 * (body map, handle map, capital pass) and keeps its public spawn methods.
 * A new body shape is a builder here, called from a `PhysicsWorld` spawn
 * method; collider settings stay in `colliderConfig.ts`.
 *
 * Spawns and shield 0-crosses are discrete events, not per-tick, so these
 * builders may allocate (Invariant #14 covers the step path only).
 */
import RAPIER from '@dimforge/rapier2d-compat';
import { shipCollisionTriangles } from '../geometry/shipHullDecomp.js';
import { polygonArea, verticesToFloat32, type Vec2 } from '../swarm/asteroidShape.js';
import type { ShipKind } from '../../shared-types/shipKinds.js';
import { configureShipCollider, shipShieldColliderDesc } from './colliderConfig.js';
import { shipBodyInertia, shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { wallGeometry } from '../structures/ShieldWall.js';

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

/** The body of a pilot ship (`PhysicsWorld.spawnShip`), shield collider on. */
export function createShipBody(world: RAPIER.World, kind: ShipKind, x: number, y: number): RAPIER.RigidBody {
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
  const body = world.createRigidBody(bodyDesc);
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
  world.createCollider(shipShieldColliderDesc(kind), body);
  // The kind's one mass + inertia source (`shipBodyMass` /
  // `shipBodyInertia`), shared with every NPC body of the kind: ship
  // stats belong to the ship, never the pilot (owner 2026-11-13).
  body.setAdditionalMassProperties(shipBodyMass(kind), { x: 0, y: 0 }, shipBodyInertia(kind), true);
  body.recomputeMassPropertiesFromColliders();
  return body;
}

/**
 * Behind `PhysicsWorld.spawnObstacle` (World.ts).
 *
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
 * `applyImpulse` calls from drone behaviours. With `parts` it is a multi-part
 * body (gates). An EMPTY `parts` list (the Ancients' gate, which has no
 * solid part at all; teleporter redesign A3) is a body with no collider:
 * nothing at it blocks. Omit `parts` for the vertices / ball collider.
 */
export function createObstacleBody(
  world: RAPIER.World,
  x: number,
  y: number,
  radius: number,
  mass: number,
  vertices: ReadonlyArray<Vec2> | undefined,
  linearDamping: number,
  collisionGroups: number | undefined,
  parts: ReadonlyArray<ReadonlyArray<Vec2>> | undefined,
  shieldKind: ShipKind | undefined,
): RAPIER.RigidBody {
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
  const body = world.createRigidBody(bodyDesc);

  // Gates (phase V): a body made of SEVERAL convex parts (two posts, or an
  // airlock's posts + side walls) so ships can pass through the gap between
  // them. Density spreads the requested mass over the total part area.
  if (parts && parts.length === 0) return body; // no solid part (see above)
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
        world.createCollider(d, body);
      } catch {
        continue;
      }
    }
    return body;
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
    // mass (set after createCollider below) so setHullExposed’s
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
  world.createCollider(collider, body);
  if (isBall && shieldKind) {
    // An NPC ship: the SAME mass + inertia as a pilot ship of its kind
    // (`spawnShip`), whatever mass the caller passed. Ship stats belong to
    // the ship, never the pilot (owner 2026-11-13); server worker and
    // client predWorld both land here (#15).
    body.setAdditionalMassProperties(shipBodyMass(shieldKind), { x: 0, y: 0 }, shipBodyInertia(shieldKind), true);
    body.recomputeMassPropertiesFromColliders();
  } else if (isBall) {
    // Pin mass to the disc-equivalent (mass param, I = 0.5 m r^2),
    // identical to what the legacy density ball produced. See spawnShip.
    body.setAdditionalMassProperties(mass, { x: 0, y: 0 }, 0.5 * mass * radius * radius, true);
    body.recomputeMassPropertiesFromColliders();
  }
  return body;
}

/** The body of a projectile (`PhysicsWorld.spawnProjectile`): a sensor. */
/** Set every collider of `body` to `groups` (hologram pass-through: a finished
 *  blueprint goes from `BLUEPRINT_COLLISION_GROUPS` to the default). */
export function setBodyCollisionGroups(body: RAPIER.RigidBody, groups: number): void {
  for (let c = 0; c < body.numColliders(); c++) body.collider(c).setCollisionGroups(groups);
}

export function createProjectileBody(world: RAPIER.World, x: number, y: number, vx: number, vy: number, radius: number): RAPIER.RigidBody {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y)
    .setLinvel(vx, vy)
    .setLinearDamping(0)
    .setAngularDamping(0);
  const body = world.createRigidBody(bodyDesc);
  const collider = RAPIER.ColliderDesc.ball(radius)
    .setSensor(true)
    .setDensity(0.001);
  world.createCollider(collider, body);
  return body;
}

/**
 * Behind `PhysicsWorld.spawnWall` (World.ts).
 *
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
export function createWallBody(
  world: RAPIER.World, ax: number, ay: number, bx: number, by: number, thickness: number,
): { body: RAPIER.RigidBody; collider: RAPIER.Collider } | null {
  const g = wallGeometry(ax, ay, bx, by);
  if (g.length < 1) return null; // degenerate (coincident pylons) — nothing to span
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(g.midX, g.midY).setRotation(g.angle),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(g.length / 2, thickness / 2).setRestitution(0.4).setFriction(0),
    body,
  );
  return { body, collider };
}

/**
 * Behind `PhysicsWorld.setHullExposed` (World.ts).
 *
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
export function mountShipColliders(world: RAPIER.World, body: RAPIER.RigidBody, kind: ShipKind, exposed: boolean): void {
  // Collect-then-remove: removeCollider mutates the body's collider list,
  // so iterating by live index while removing would skip colliders.
  const cols: RAPIER.Collider[] = [];
  for (let i = 0; i < body.numColliders(); i++) cols.push(body.collider(i));
  for (const c of cols) world.removeCollider(c, true);
  if (exposed) {
    // TRIANGLE colliders, fan-triangulated from each convex part
    // (`shipCollisionTriangles`), never `convexHull`/`cuboid`: in Rapier 2D
    // only triangles fire `CONTACT_FORCE_EVENTS` for bodies overlapping at
    // zero closing speed, which ram damage and `t-ship-no-self-collision`
    // need (`hullCollisionNoTouch.test.ts`; the 2026-05-28 convexHull
    // experiment was reverted 2026-06-11). Penetration is the stiff solver's.
    for (const t of shipCollisionTriangles(kind.id)) {
      world.createCollider(
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
    world.createCollider(shipShieldColliderDesc(kind), body);
  }
  // Re-fold the pinned additional mass-props now (Rapier otherwise defers
  // to the next step). Total stays mass 1 / I 0.5r^2 -- the new colliders
  // are zero-density and the additional props were never cleared.
  body.recomputeMassPropertiesFromColliders();
}
