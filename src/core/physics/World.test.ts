import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { generateAsteroidVertices } from '../swarm/asteroidShape.js';
import { SCRAP_COLLISION_GROUPS } from './collisionGroups.js';

let world: PhysicsWorld;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

describe('PhysicsWorld', () => {
  it('spawns and tracks a ship', () => {
    world.spawnShip('test-ship', 100, 200);
    const state = world.getShipState('test-ship');
    expect(state).not.toBeNull();
    expect(state!.x).toBeCloseTo(100, 1);
    expect(state!.y).toBeCloseTo(200, 1);
  });

  it('thrusts forward (along visual nose direction) at angle=0', () => {
    // At angle=0 the ship polygon nose points Pixi-up. In Rapier (Y-up) that is +Y.
    // Thrust formula: (-sin θ, cos θ). At θ=0 → (0, +1), so vy should be positive.
    world.spawnShip('drift-ship', 0, 0);
    world.applyInput('drift-ship', { thrust: true, turnLeft: false, turnRight: false });
    world.tick(1 / 60);
    const state = world.getShipState('drift-ship');
    expect(state).not.toBeNull();
    expect(state!.vy).toBeGreaterThan(0);
    expect(Math.abs(state!.vx)).toBeLessThan(0.001); // no lateral component at angle=0
  });

  it('turnLeft produces positive (CCW) angular velocity → sprite rotates CCW on screen', () => {
    // sprite.rotation = -angle, so positive ω in Rapier → angle increases →
    // sprite.rotation decreases → CCW on screen → visual left turn.
    world.spawnShip('turn-ship', 0, 0);
    world.applyInput('turn-ship', { thrust: false, turnLeft: true, turnRight: false });
    world.tick(1 / 60);
    const state = world.getShipState('turn-ship');
    expect(state!.angle).toBeGreaterThan(0); // angle should have increased (CCW)
  });

  it('despawns a ship', () => {
    world.spawnShip('temp-ship', 0, 0);
    world.despawnShip('temp-ship');
    expect(world.getShipState('temp-ship')).toBeNull();
  });

  it('returns all ship states', () => {
    world.spawnShip('multi-a', 10, 0);
    world.spawnShip('multi-b', -10, 0);
    const all = world.getAllShipStates();
    expect(all.has('multi-a')).toBe(true);
    expect(all.has('multi-b')).toBe(true);
  });

  it('applyImpulse imparts linear velocity in the requested direction', () => {
    world.spawnShip('imp-linear', 500, 500);
    world.applyImpulse('imp-linear', 5, 0, 0);
    world.tick(1 / 60);
    const state = world.getShipState('imp-linear');
    expect(state!.vx).toBeGreaterThan(0);
    expect(Math.abs(state!.vy)).toBeLessThan(0.01);
  });

  it('applyImpulse adds torque that produces angular velocity', () => {
    world.spawnShip('imp-torque', 600, 600);
    world.applyImpulse('imp-torque', 0, 0, 0.5);
    world.tick(1 / 60);
    const state = world.getShipState('imp-torque');
    // The damped ship has high angular damping (8.0) so we just check the sign survives.
    expect(state!.angvel ?? 0).toBeGreaterThan(0);
  });

  it('applyImpulse silently no-ops on unknown ids', () => {
    expect(() => world.applyImpulse('does-not-exist', 1, 1, 1)).not.toThrow();
  });

  it('isSleeping reports false on a freshly impulsed body', () => {
    world.spawnShip('sleep-check', 700, 700);
    world.applyImpulse('sleep-check', 5, 5, 0);
    world.tick(1 / 60);
    expect(world.isSleeping('sleep-check')).toBe(false);
  });

  it('isSleeping returns false for unknown ids', () => {
    expect(world.isSleeping('ghost')).toBe(false);
  });
});

describe('PhysicsWorld.spawnObstacle (polygon path)', () => {
  it('builds a convex-hull collider when vertices are provided and steps without NaN', () => {
    const verts = generateAsteroidVertices(7, 24);
    world.spawnObstacle('poly-asteroid', 1000, 1000, 24, 500, verts);
    world.tick(1 / 60);
    const state = world.getShipState('poly-asteroid');
    expect(state).not.toBeNull();
    expect(Number.isFinite(state!.x)).toBe(true);
    expect(Number.isFinite(state!.y)).toBe(true);
    expect(Number.isFinite(state!.angle)).toBe(true);
  });

  it('falls back to ball collider on degenerate vertex input', () => {
    expect(() => world.spawnObstacle('degenerate-poly', 2000, 2000, 24, 500, [])).not.toThrow();
    world.tick(1 / 60);
    expect(world.getShipState('degenerate-poly')).not.toBeNull();
  });

  it('preserves backward-compatible ball-collider path when vertices are omitted', () => {
    expect(() => world.spawnObstacle('legacy-asteroid', 3000, 3000, 32, 500)).not.toThrow();
    world.tick(1 / 60);
    expect(world.getShipState('legacy-asteroid')).not.toBeNull();
  });

  // WS-11 (R2.25) — the STRUCTURAL mechanism behind the drone "float / coast away
  // forever" bug. Drones spawn via spawnObstacle, whose AI-impulse path bypasses
  // the player's max-speed clamp; with ZERO linear damping a drone that overshoots
  // coasts away at constant velocity FOREVER (the standoff brake goes to thrust=0
  // once it's past the target, and nothing bleeds the residual speed). The fix
  // gives drone bodies a nonzero `linearDamping` so velocity dissipates. A pure
  // mechanism lock — no AI, no weapon profile, no feel judgement.
  it('a body with linearDamping sheds coasting velocity; damping 0 coasts forever (R2.25)', () => {
    // Two identical bodies given the same eastward speed, then coasted with NO
    // further impulse. The undamped one (asteroid/structure regime) keeps its
    // speed; the damped one (the drone fix) bleeds it off.
    world.spawnObstacle('coast-zero', -8000, 0, 12, 2, undefined, 0);
    world.spawnObstacle('coast-damped', -8000, 200, 12, 2, undefined, 0.5);
    const v0 = 200;
    world.setShipState('coast-zero', { x: -8000, y: 0, angle: 0, vx: v0, vy: 0 });
    world.setShipState('coast-damped', { x: -8000, y: 200, angle: 0, vx: v0, vy: 0 });
    for (let i = 0; i < 120; i++) world.tick(1 / 60); // 2 s of pure coasting

    const zero = world.getShipState('coast-zero')!;
    const damped = world.getShipState('coast-damped')!;
    const zeroSpeed = Math.hypot(zero.vx, zero.vy);
    const dampedSpeed = Math.hypot(damped.vx, damped.vy);
    // Undamped keeps almost all of it (no friction → coasts forever).
    expect(zeroSpeed).toBeGreaterThan(v0 * 0.9);
    // Damped has shed most of it (the dissipation the brake settles against).
    // Pre-fix, spawnObstacle ignored the damping arg → this body also coasted at
    // ~v0 and this assertion FAILED.
    expect(dampedSpeed).toBeLessThan(v0 * 0.5);
  });
});

describe('PhysicsWorld.spawnObstacle — scrap collision groups (scrap-on-death 2b-i)', () => {
  // SCRAP bodies carry SCRAP_COLLISION_GROUPS so scrap does NOT collide with
  // other scrap (a death-burst of overlapping pieces passes cleanly through
  // itself) but DOES collide with everything else (it still bumps off ships /
  // drones / asteroids / structures). These two tests prove both halves with
  // overlapping bodies: scrap-vs-scrap must NOT push apart; scrap-vs-default
  // MUST push apart.
  it('two overlapping scrap bodies do NOT push apart (scrap vs scrap = no collide)', () => {
    // Placed in a fresh region of the shared `world`, heavily overlapping
    // (centres 4 u apart, radius 24). With NO collision between them they sit
    // still; with collision they would shove apart hard.
    world.spawnObstacle('scrap-a', 20000, 0, 24, 1, undefined, 0.15, SCRAP_COLLISION_GROUPS);
    world.spawnObstacle('scrap-b', 20004, 0, 24, 1, undefined, 0.15, SCRAP_COLLISION_GROUPS);
    for (let i = 0; i < 60; i++) world.tick(1 / 60); // 1 s

    const a = world.getShipState('scrap-a')!;
    const b = world.getShipState('scrap-b')!;
    // Neither body should have been displaced — no contact force between them.
    expect(Math.hypot(a.x - 20000, a.y)).toBeLessThan(1);
    expect(Math.hypot(b.x - 20004, b.y)).toBeLessThan(1);
    // And they should not have gained any push-apart velocity.
    expect(Math.hypot(a.vx, a.vy)).toBeLessThan(0.5);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThan(0.5);
  });

  it('an overlapping scrap body and a DEFAULT body DO push apart (scrap vs default = collide)', () => {
    // Same overlap geometry, but the second body uses Rapier's default groups
    // (no collisionGroups arg). The contact resolver must shove them apart.
    world.spawnObstacle('scrap-c', 21000, 0, 24, 1, undefined, 0.15, SCRAP_COLLISION_GROUPS);
    world.spawnObstacle('default-d', 21004, 0, 24, 1); // default groups
    for (let i = 0; i < 60; i++) world.tick(1 / 60); // 1 s

    const c = world.getShipState('scrap-c')!;
    const d = world.getShipState('default-d')!;
    // The pair was overlapping and must have separated — their centre distance
    // grew well past the initial 4 u.
    const sep = Math.hypot(c.x - d.x, c.y - d.y);
    expect(sep).toBeGreaterThan(4);
    // At least one of them moved off its spawn point (push-apart impulse).
    const cMoved = Math.hypot(c.x - 21000, c.y);
    const dMoved = Math.hypot(d.x - 21004, d.y);
    expect(cMoved + dMoved).toBeGreaterThan(1);
  });
});

describe('PhysicsWorld.lockBody — structures are immovable (P3.10)', () => {
  // The mechanism behind the P0 structure-movement fix: a structure body is
  // `lockBody`'d (translations + rotations locked) so a ram can't shove it. A
  // dynamic (unlocked) body in the same scenario IS shoved — that was the
  // "I hit a pylon and it started MOVING" bug. The server now locks kind-2
  // bodies exactly like the client predWorld already did.
  it('a locked obstacle holds position when rammed; an unlocked one is shoved', () => {
    // Locked structure regime — placed in a fresh region (shared `world`).
    world.spawnObstacle('lock-struct', 12000, 0, 30, 5);
    world.lockBody('lock-struct');
    world.spawnObstacle('lock-rammer', 12000, -120, 12, 5);
    world.setShipState('lock-rammer', { x: 12000, y: -120, angle: 0, vx: 0, vy: 600 });

    // Control: identical scenario but the target is NOT locked.
    world.spawnObstacle('free-struct', 13000, 0, 30, 5);
    world.spawnObstacle('free-rammer', 13000, -120, 12, 5);
    world.setShipState('free-rammer', { x: 13000, y: -120, angle: 0, vx: 0, vy: 600 });

    for (let i = 0; i < 90; i++) world.tick(1 / 60); // 1.5 s — ram + steady press

    const locked = world.getShipState('lock-struct')!;
    const free = world.getShipState('free-struct')!;
    // Locked body did not move (the structure fix).
    expect(Math.hypot(locked.x - 12000, locked.y)).toBeLessThan(1);
    // Unlocked body was shoved (the pre-fix structure behaviour).
    expect(Math.hypot(free.x - 13000, free.y)).toBeGreaterThan(1);
  });
});
