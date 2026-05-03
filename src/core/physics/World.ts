import RAPIER from '@dimforge/rapier2d-compat';

const FIXED_DT = 1 / 60;
const THRUST_IMPULSE = 1.5;
/** Multiplier applied to THRUST_IMPULSE while the player holds shift. Picked
 *  to feel decisively "boosting" without launching the ship out of the sector
 *  in a single tap — at LINEAR_DAMPING = 0.01 a 1 s burst tops out around
 *  3.5× normal cruise speed. */
export const BOOST_MULTIPLIER = 3.5;
const TURN_SPEED = 2.5; // rad/s
const LINEAR_DAMPING = 0.01;
const ANGULAR_DAMPING = 8.0;
const SHIP_RADIUS = 12;

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
  /** Shift-held boost — multiplies thrust impulse by BOOST_MULTIPLIER while
   *  thrust is also held. No-op on its own. Optional for back-compat. */
  boost?: boolean;
}

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private bodies = new Map<string, RAPIER.RigidBody>();
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

  tick(dtSeconds: number): void {
    this.accumulator += dtSeconds;
    while (this.accumulator >= FIXED_DT) {
      this.world.step();
      this.accumulator -= FIXED_DT;
    }
  }

  spawnShip(id: string, x = 0, y = 0): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING);
    const body = this.world.createRigidBody(bodyDesc);
    // Set density so mass ≈ 1 unit regardless of radius, keeping THRUST_IMPULSE in sane range.
    const density = 1 / (Math.PI * SHIP_RADIUS * SHIP_RADIUS);
    const collider = RAPIER.ColliderDesc.ball(SHIP_RADIUS).setRestitution(0.3).setFriction(0).setDensity(density);
    this.world.createCollider(collider, body);
    this.bodies.set(id, body);
    this.handleToId.set(body.handle, id);
  }

  /**
   * Spawn a passive dynamic body (asteroid-ish) for collision testing. No damping
   * on linear or angular motion so an initial velocity / spin persists. Renders
   * via the same ship mirror entry; the renderer draws it as a remote-coloured
   * triangle, which is fine for diagnostics.
   */
  spawnObstacle(id: string, x: number, y: number, radius = 24, mass = 3): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setLinearDamping(0)
      .setAngularDamping(0);
    const body = this.world.createRigidBody(bodyDesc);
    const density = mass / (Math.PI * radius * radius);
    const collider = RAPIER.ColliderDesc.ball(radius).setRestitution(0.8).setFriction(0).setDensity(density);
    this.world.createCollider(collider, body);
    this.bodies.set(id, body);
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
    this.bodies.set(id, body);
    this.handleToId.set(body.handle, id);
  }

  despawnShip(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    this.handleToId.delete(body.handle);
    this.world.removeRigidBody(body);
    this.bodies.delete(id);
  }

  applyInput(id: string, input: ShipInput): void {
    const body = this.bodies.get(id);
    if (!body) return;

    if (input.thrust) {
      const angle = body.rotation();
      // Ship polygon nose points Pixi-up (local y=-16) at angle=0.
      // In Rapier (Y-up), that visual "forward" is (-sin θ, cos θ), not (cos θ, sin θ).
      const impulse = input.boost ? THRUST_IMPULSE * BOOST_MULTIPLIER : THRUST_IMPULSE;
      body.applyImpulse({ x: -Math.sin(angle) * impulse, y: Math.cos(angle) * impulse }, true);
    }

    // sprite.rotation = -angle, so Rapier CCW (positive ω) = CCW on screen = left turn.
    if (input.turnLeft) {
      body.setAngvel(TURN_SPEED, true);
    } else if (input.turnRight) {
      body.setAngvel(-TURN_SPEED, true);
    } else {
      body.setAngvel(0, true);
    }
  }

  /**
   * Apply a single-step linear and angular impulse, used by AI behaviours and
   * (via the `AI_INTENT` worker command) by drone steering. Wakes the body if
   * it was sleeping. Silently no-ops on unknown ids so a stale intent posted
   * after despawn is harmless.
   */
  applyImpulse(id: string, fx: number, fy: number, torque: number): void {
    const body = this.bodies.get(id);
    if (!body) return;
    if (fx !== 0 || fy !== 0) body.applyImpulse({ x: fx, y: fy }, true);
    if (torque !== 0) body.applyTorqueImpulse(torque, true);
  }

  /** True when Rapier reports the body as sleeping (motion below its threshold). */
  isSleeping(id: string): boolean {
    const body = this.bodies.get(id);
    if (!body) return false;
    return body.isSleeping();
  }

  /** Force-wake a body. Safe no-op if already awake or unknown. */
  wakeUp(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    body.wakeUp();
  }

  /**
   * Lock a body's translations and rotations. The body still participates in
   * collision detection (other bodies bounce off it as if it had infinite
   * mass) but `world.step()` no longer integrates it. Used by the client's
   * swarm-mirror so reconciler replay doesn't drift swarm bodies between
   * authoritative wire packets.
   */
  lockBody(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
    body.lockTranslations(true, false);
    body.lockRotations(true, false);
  }

  setShipState(id: string, state: ShipPhysicsState): void {
    const body = this.bodies.get(id);
    if (!body) return;
    body.setTranslation({ x: state.x, y: state.y }, true);
    body.setLinvel({ x: state.vx, y: state.vy }, true);
    body.setRotation(state.angle, true);
    // Also restore angular velocity so replay starts from the correct spin state.
    if (state.angvel !== undefined) body.setAngvel(state.angvel, true);
  }

  getShipState(id: string): ShipPhysicsState | null {
    const body = this.bodies.get(id);
    if (!body) return null;
    const t = body.translation();
    const v = body.linvel();
    return { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y, angvel: body.angvel() };
  }

  getAllShipStates(): Map<string, ShipPhysicsState> {
    const result = new Map<string, ShipPhysicsState>();
    for (const [id, body] of this.bodies) {
      const t = body.translation();
      const v = body.linvel();
      result.set(id, { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y, angvel: body.angvel() });
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
    const excludeBody = this.bodies.get(excludeId);
    const ray = new RAPIER.Ray({ x: fromX, y: fromY }, { x: dirX, y: dirY });
    // World.castRay returns RayColliderHit where .collider is already a Collider
    // object, and .timeOfImpact is the distance along the ray.
    const hit = this.world.castRay(
      ray,
      maxDist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      excludeBody,
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
