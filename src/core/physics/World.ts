import RAPIER from '@dimforge/rapier2d-compat';

const FIXED_DT = 1 / 60;
const THRUST_IMPULSE = 0.15;
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
}

export interface ShipInput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
}

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private bodies = new Map<string, RAPIER.RigidBody>();

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
  }

  despawnShip(id: string): void {
    const body = this.bodies.get(id);
    if (!body) return;
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
      body.applyImpulse({ x: -Math.sin(angle) * THRUST_IMPULSE, y: Math.cos(angle) * THRUST_IMPULSE }, true);
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

  getShipState(id: string): ShipPhysicsState | null {
    const body = this.bodies.get(id);
    if (!body) return null;
    const t = body.translation();
    const v = body.linvel();
    return { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y };
  }

  getAllShipStates(): Map<string, ShipPhysicsState> {
    const result = new Map<string, ShipPhysicsState>();
    for (const [id, body] of this.bodies) {
      const t = body.translation();
      const v = body.linvel();
      result.set(id, { x: t.x, y: t.y, angle: body.rotation(), vx: v.x, vy: v.y });
    }
    return result;
  }

  hasShip(id: string): boolean {
    return this.bodies.has(id);
  }

  dispose(): void {
    this.world.free();
  }
}
