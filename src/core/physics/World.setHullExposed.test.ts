import { describe, it, expect, beforeEach } from 'vitest';
import { PhysicsWorld } from './World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const fighter = getShipKind('fighter');
const scout = getShipKind('scout');

// Fresh world per test — bodies must not leak across cases (a stray body at
// the origin would steal the geometry test's ray).
let world: PhysicsWorld;

beforeEach(async () => {
  world = await PhysicsWorld.create();
});

describe('World.setHullExposed — dynamic transparency', () => {
  it('the collider swap does NOT change mass or inertia (identical impulse ⇒ identical motion)', () => {
    // Two identical ships, far apart so they never interact. One is swapped
    // to its hull polygon. Applying the SAME linear+angular impulse to both
    // must produce bit-for-bit identical motion — that is only true if the
    // swap left mass AND inertia untouched (zero-density colliders + the
    // body's pinned additional mass props).
    world.spawnShip('xparity-circle', 0, 0, 'fighter');
    world.spawnShip('xparity-poly', 5000, 0, 'fighter');
    world.setHullExposed('xparity-poly', true, fighter);

    // Bodies are far apart so they never interact. We assert ONLY Δv / Δω
    // (translation-invariant) — NOT post-step position, which Rapier's f32
    // integrator rounds at large absolute coords (x≈5000). Identical Δv/Δω
    // from an identical impulse is the exact proof that the collider swap
    // left mass and inertia untouched.
    world.applyImpulse('xparity-circle', 7, 3, 0.5);
    world.applyImpulse('xparity-poly', 7, 3, 0.5);
    world.tick(1 / 60);

    const a = world.getShipState('xparity-circle')!;
    const b = world.getShipState('xparity-poly')!;
    // Identical linear impulse ⇒ identical Δv  ⟺  identical mass.
    expect(b.vx).toBeCloseTo(a.vx, 9);
    expect(b.vy).toBeCloseTo(a.vy, 9);
    // Identical torque impulse ⇒ identical Δω  ⟺  identical angular inertia.
    expect(b.angvel!).toBeCloseTo(a.angvel!, 9);
  });

  it('the swap itself does not perturb pose/velocity, and body identity is preserved', () => {
    world.spawnShip('xident', -8000, 0, 'fighter');
    world.applyImpulse('xident', 4, 9, 0.2);
    world.tick(1 / 60);
    const before = world.getShipState('xident')!;

    world.setHullExposed('xident', true, fighter); // no tick in between
    const after = world.getShipState('xident')!;
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.vx).toBe(before.vx);
    expect(after.vy).toBe(before.vy);
    expect(after.angvel!).toBe(before.angvel!);
    expect(world.hasShip('xident')).toBe(true);
  });

  it('is idempotent and a safe no-op on unknown ids', () => {
    world.spawnShip('xidem', 12000, 0, 'fighter');
    expect(() => {
      world.setHullExposed('xidem', false, fighter); // already circle ⇒ no-op
      world.setHullExposed('xidem', true, fighter);
      world.setHullExposed('xidem', true, fighter); // already polygon ⇒ no-op
      world.setHullExposed('does-not-exist', true, fighter); // unknown ⇒ no-op
    }).not.toThrow();
    expect(world.hasShip('xidem')).toBe(true);
  });
});

describe('World.setHullExposed — geometry + query-pipeline lag', () => {
  // Scout: radius 10, nose apex at local (0,-14). Shield collider is a
  // ball of radius `kind.radius + SHIELD_RADIUS_PAD = 10 + 10 = 20` — so
  // the shield BUBBLE extends past the nose. Shield-down swaps to the
  // exact polygon (nose at y=-14 in entity-local coords).
  //
  // A vertical ray up the centre enters:
  //   - SHIELD-UP CIRCLE at y≈-20 → dist ≈ 80
  //   - HULL POLYGON at the nose y≈-14 → dist ≈ 86
  // That gap (circle hit < polygon hit by ~6 u) is the discriminator.
  // Note this gap INVERTED on 2026-05-27 when SHIELD_RADIUS_PAD landed:
  // pre-pad the circle was at the bare radius (r=10, dist 90) and the
  // protruding nose at y=-14 hit FIRST. Once the shield extends past
  // the hull, the bubble is what hits first; the polygon is the LATER
  // hit because the hull is INSIDE the bubble.
  const RAY = { fx: 0.001, fy: -100, dx: 0, dy: 1, max: 200, excl: 'zzz' };
  const cast = (): { hitId: string; dist: number } | null =>
    world.hitscan(RAY.fx, RAY.fy, RAY.dx, RAY.dy, RAY.max, RAY.excl);

  it('shield-up = circle hitbox; shield-down = exact polygon; new geometry lags one step', () => {
    world.spawnShip('xgeo', 0, 0, 'scout');
    world.tick(1 / 60); // prime the query pipeline with the circle

    const circle = cast();
    expect(circle).not.toBeNull();
    expect(circle!.hitId).toBe('xgeo');
    // Shield bubble at r=20 → ray enters at y≈-20 → dist≈80.
    expect(circle!.dist).toBeGreaterThan(78);
    expect(circle!.dist).toBeLessThan(82);

    // Expose the hull. Rapier only refreshes scene queries inside step(),
    // so BEFORE the next tick the polygon must NOT yet be visible — the
    // stale circle (or transient absence) holds. We allow either: a
    // result still at the shield-bubble distance (≈80), or null. The
    // forbidden state is the polygon ≈86 leaking out a tick early.
    world.setHullExposed('xgeo', true, scout);
    const lag = cast();
    expect(lag === null || lag.dist < 82).toBe(true);

    // After one step the protruding nose is live: the ray connects ~6 u
    // LATER than the shield bubble did (because the bubble extends past
    // the hull by SHIELD_RADIUS_PAD = 10, and the nose juts only 4 u
    // past the bare radius).
    world.tick(1 / 60);
    const poly = cast();
    expect(poly).not.toBeNull();
    expect(poly!.hitId).toBe('xgeo');
    expect(poly!.dist).toBeGreaterThan(85);
    expect(poly!.dist).toBeGreaterThan(circle!.dist + 1);
    expect(poly!.dist).toBeLessThan(88);

    // Regenerating the shield swaps back to the cheap circle.
    world.setHullExposed('xgeo', false, scout);
    world.tick(1 / 60);
    const back = cast();
    expect(back).not.toBeNull();
    expect(back!.dist).toBeGreaterThan(78);
    expect(back!.dist).toBeLessThan(82);
  });
});
