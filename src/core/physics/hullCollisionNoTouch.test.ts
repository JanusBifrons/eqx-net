/**
 * Hull-collision determinism test — 2026-05-28, updated 2026-06-11.
 *
 * Direct PhysicsWorld backup for `tests/e2e/t-ship-no-self-collision.spec.ts`.
 * Spawns two Crossguard T-ships at the INTERLOCKING poses (the
 * `hull-collision-test` room geometry): bounding circles overlap massively
 * but the polygon silhouettes have a 1 u gap. With both ships
 * `hullExposed: true`, the polygon compound collider (TRIANGLE colliders —
 * `setHullExposed`) is what's under test: a correctly-decomposed clean T
 * leaves the interlock gaps empty and emits ZERO contacts; a buggy hull
 * (filled gap, overlapping triangles, wrong winding, Y-axis flip) emits
 * non-zero contacts. The positive control proves the surface is live by
 * stacking two T-ships at the SAME point → they MUST emit contacts.
 *
 * Catalogue geometry (entity-local Pixi-up, post `scale: 10`; clean
 * right-angle T as of 2026-06-11):
 *   - Crossbar: x ∈ [-140, 140], y ∈ [-160, -100]
 *   - Stem:     x ∈ [-40, 40],   y ∈ [-100, 120]   (reflex flush at y=-100)
 *
 * EXACT 1 u-gap interlock: A at (-40.5, +10.5, ang=0); B at (40.5, -10.5, π).
 * Δx = 81 (stem-width 80 + 1), Δy = 21 → all THREE contact faces are 1 u apart
 * (stem↔stem in X; each stem-end ↔ the opposing crossbar in Y). As tight as
 * the silhouettes nest without touching. Bounding circles (radius 213) overlap
 * by ~120 u → any spurious contact at the interlock fires immediately. The
 * "interlock pushed together" + "same point" positives prove the events DO
 * fire on real overlap, so the 1 u-gap zero is a meaningful clearance.
 *
 * TRIANGLE colliders are load-bearing: in Rapier 2D only `triangle` shapes
 * emit `CONTACT_FORCE_EVENTS` for static (zero closing velocity) overlap —
 * `cuboid`/`convexHull` emit none (the bare-Rapier diagnostic below proves
 * all three). So the positive control can again assert EVENT FIRING (the
 * 2026-05-28→06-11 convexHull experiment had forced it to a weaker
 * body-separation proxy; reverting to triangle restored the real signal).
 *
 * Faster than E2E (sub-second) and runs in the inner loop. The E2E spec
 * is the full-stack regression lock; this is the pure-physics lock.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from './World.js';
import { drainContacts } from './contactDrain.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('hull collision determinism — two stationary T-ships', () => {
  it('emits zero contacts when polygon silhouettes do not touch but bounding circles overlap', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    const crossguard = getShipKind('crossguard');

    // Clean right-angle T (2026-06-11 — the elbow slope removed). In the
    // math-up collider frame (`shipShapeToPolygon` Y-flips ×10): crossbar
    // y ∈ [100, 160], x ∈ [-140, 140]; stem y ∈ [-120, 100], x ∈ [-40, 40]
    // (the reflex is FLUSH with the crossbar bottom at y=100, so the crossbar
    // underside is one flat line — no slope to special-case).
    //
    // EXACT 1 u-gap interlock — Δx = 81 (stem-width 80 + 1), Δy = 21, so ALL
    // THREE contact faces are 1 u apart. At A(-40.5, +10.5, 0), B(40.5, -10.5, π):
    //   - A.stem x ∈ [-80.5, -0.5]; B.stem x ∈ [0.5, 80.5] → 1 u gap.
    //   - A.stem bottom y = -109.5 vs B.crossbar top y = -110.5 → 1 u gap.
    //   - B.stem top y = +109.5 vs A.crossbar bottom y = +110.5 → 1 u gap.
    // Bounding circles (radius 213) overlap by ~120 u. With TRIANGLE colliders
    // a real overlap WOULD fire CONTACT_FORCE_EVENTS (the POSITIVE controls
    // below prove it), so zero contacts here is a meaningful "1 u apart, as
    // tight as possible without touching" lock — any spurious contact (wrong
    // winding, Y-axis flip, collider exceeding the silhouette) fires at once.
    world.spawnShip('a', -40.5, +10.5, 'crossguard');
    world.spawnShip('b',  40.5, -10.5, 'crossguard');
    world.setShipState('a', { x: -40.5, y: +10.5, angle: 0,       vx: 0, vy: 0, angvel: 0 });
    world.setShipState('b', { x:  40.5, y: -10.5, angle: Math.PI, vx: 0, vy: 0, angvel: 0 });
    world.setHullExposed('a', true, crossguard);
    world.setHullExposed('b', true, crossguard);

    // Step the world. 60 ticks = 1 second of simulated time. Any contact
    // would have surfaced within the first few ticks (penetration recovery
    // fires immediately).
    for (let i = 0; i < 60; i++) world.tick(1 / 60, eventQueue);

    // Force floor 0 — we want EVERY contact, not just high-force ones. Even
    // a zero-velocity penetration produces resolver impulses well above
    // any positive floor; the only way drainContacts returns empty is if
    // Rapier reported no contacts at all.
    const contacts = drainContacts(eventQueue, world, 0);

    if (contacts.length > 0) {
      // Surface what we got so a failure is diagnosable from the log alone.
      // eslint-disable-next-line no-console
      console.error('Unexpected contacts:', contacts.map((c) => ({
        aId: c.aId, bId: c.bId, force: c.forceMagnitude,
      })));
    }
    expect(contacts).toEqual([]);

    world.dispose();
  });

  it('POSITIVE control: the SAME interlock pushed together (stems overlap) emits contacts', async () => {
    // The symmetric counterpart to the 1 u-gap negative above: keep A fixed,
    // pull B in along x from 40.5 → 20.5 (Δx 81 → 61) so the two stems now
    // OVERLAP by ~19 u instead of clearing by 1 u. Everything else identical.
    // This proves the boundary directly — the SAME shapes that don't touch at
    // a 1 u gap DO collide once they overlap (so the negative isn't a false
    // pass from a dead collider). With TRIANGLE colliders the static overlap
    // fires CONTACT_FORCE_EVENTS.
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    const crossguard = getShipKind('crossguard');

    world.spawnShip('a', -40.5, +10.5, 'crossguard');
    world.spawnShip('b',  20.5, -10.5, 'crossguard'); // pulled in: stems overlap
    world.setShipState('a', { x: -40.5, y: +10.5, angle: 0,       vx: 0, vy: 0, angvel: 0 });
    world.setShipState('b', { x:  20.5, y: -10.5, angle: Math.PI, vx: 0, vy: 0, angvel: 0 });
    world.setHullExposed('a', true, crossguard);
    world.setHullExposed('b', true, crossguard);

    let totalContacts = 0;
    for (let i = 0; i < 60; i++) {
      world.tick(1 / 60, eventQueue);
      totalContacts += drainContacts(eventQueue, world, 0).length;
    }

    // eslint-disable-next-line no-console
    console.log(`[POSITIVE interlock-closed] overlapping crossguard stems emitted ${totalContacts} contacts / 60 ticks`);
    expect(
      totalContacts,
      'overlapping interlock must emit contacts (proves the 1 u-gap negative is a real clearance, not a dead collider)',
    ).toBeGreaterThan(0);

    world.dispose();
  });

  it('POSITIVE control: two T-ships at the SAME point emit contacts (surface is live)', async () => {
    // Stack two crossguards at the identical point (0, 0) with hull exposed
    // → the TRIANGLE compound colliders fully interpenetrate → Rapier emits
    // CONTACT_FORCE_EVENTS every step. This is the live-surface guard that
    // makes the negative control above meaningful: if THIS fired zero events
    // (the 2026-05-28 convexHull regression), "zero contacts" in the
    // negative test would prove nothing. Mirrors the E2E positive control
    // (`hull-collision-overlap-test` room).
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    const crossguard = getShipKind('crossguard');

    world.spawnShip('a', 0, 0, 'crossguard');
    world.spawnShip('b', 0, 0, 'crossguard');
    world.setShipState('a', { x: 0, y: 0, angle: 0,       vx: 0, vy: 0, angvel: 0 });
    world.setShipState('b', { x: 0, y: 0, angle: Math.PI, vx: 0, vy: 0, angvel: 0 });
    world.setHullExposed('a', true, crossguard);
    world.setHullExposed('b', true, crossguard);

    let totalContacts = 0;
    for (let i = 0; i < 60; i++) {
      world.tick(1 / 60, eventQueue);
      totalContacts += drainContacts(eventQueue, world, 0).length;
    }

    // eslint-disable-next-line no-console
    console.log(`[POSITIVE] same-point crossguards emitted ${totalContacts} contacts / 60 ticks`);
    expect(
      totalContacts,
      'overlapping triangle hulls must emit contacts (convexHull regression would give 0)',
    ).toBeGreaterThan(0);

    world.dispose();
  });

  it('DIAGNOSTIC: bare-Rapier convexHull-vs-convexHull contact event sanity', async () => {
    // Most-direct possible Rapier test — no PhysicsWorld wrapper, no ship
    // mass pinning, no collider config. Pure Rapier: two dynamic bodies
    // overlapping with each candidate shape. The 2026-05-28 finding: only
    // `triangle` shapes emit CONTACT_FORCE_EVENTS for two interpenetrating
    // bodies at zero closing velocity. `cuboid` and `convexHull` emit
    // ZERO events because the resolver impulse is positional-correction,
    // not contact-force, and the event API only fires on the latter.
    // World.setHullExposed therefore must emit triangle colliders.

    // Test all three shape kinds. Each runs in its own Rapier world so
    // contact state from a previous shape can't leak.
    const counts: Record<string, { evts: number; peak: number }> = {};
    for (const shapeKind of ['cuboid', 'convexHull', 'triangles'] as const) {
      const w = new RAPIER.World(new RAPIER.Vector2(0, 0));
      const q = new RAPIER.EventQueue(true);
      const localMake = (x: number, y: number): void => {
        const body = w.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y),
        );
        const attach = (desc: RAPIER.ColliderDesc): void => {
          desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
          desc.setContactForceEventThreshold(0);
          desc.setDensity(1);
          w.createCollider(desc, body);
        };
        if (shapeKind === 'cuboid') {
          attach(RAPIER.ColliderDesc.cuboid(10, 10));
        } else if (shapeKind === 'convexHull') {
          const flat = new Float32Array([-10, -10, 10, -10, 10, 10, -10, 10]);
          const d = RAPIER.ColliderDesc.convexHull(flat);
          if (!d) throw new Error('convexHull returned null');
          attach(d);
        } else {
          attach(RAPIER.ColliderDesc.triangle(
            new RAPIER.Vector2(-10, -10),
            new RAPIER.Vector2(10, -10),
            new RAPIER.Vector2(10, 10),
          ));
          attach(RAPIER.ColliderDesc.triangle(
            new RAPIER.Vector2(-10, -10),
            new RAPIER.Vector2(10, 10),
            new RAPIER.Vector2(-10, 10),
          ));
        }
      };
      localMake(0, 0);
      localMake(5, 0); // overlapping by 15u

      let evts = 0;
      let peak = 0;
      for (let i = 0; i < 30; i++) {
        w.step(q);
        q.drainContactForceEvents((e) => {
          evts++;
          const f = e.totalForceMagnitude();
          if (f > peak) peak = f;
        });
      }
      counts[shapeKind] = { evts, peak };
    }

    // eslint-disable-next-line no-console
    console.log(`[DIAGNOSTIC bare Rapier — 15u overlap, no closing velocity]`);
    for (const [k, v] of Object.entries(counts)) {
      // eslint-disable-next-line no-console
      console.log(`  ${k.padEnd(12)}: ${v.evts} events, peak force ${v.peak.toFixed(1)}`);
    }
    // No assertion — diagnostic only. Use the printed table to compare.
  });

  it('DIAGNOSTIC: drone path (spawnObstacle) — same position with hull exposed', async () => {
    // Mirror what SectorRoom's dronePoses spawn does:
    //   - spawnObstacle (NOT spawnShip — drones use the obstacle pool)
    //   - setShipState for angle
    //   - setHullExposed(true)
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    const crossguard = getShipKind('crossguard');

    // spawnObstacle is what the swarm spawner calls. radius = kind.radius.
    world.spawnObstacle('drone-a', 0, 0, crossguard.radius, 30, undefined);
    world.spawnObstacle('drone-b', 0, 0, crossguard.radius, 30, undefined);
    // Angle B by π (same-position overlap is enough for contacts; rotation
    // doesn't matter since they're at the same point).
    world.setShipState('drone-a', { x: 0, y: 0, angle: 0,       vx: 0, vy: 0, angvel: 0 });
    world.setShipState('drone-b', { x: 0, y: 0, angle: Math.PI, vx: 0, vy: 0, angvel: 0 });
    world.setHullExposed('drone-a', true, crossguard);
    world.setHullExposed('drone-b', true, crossguard);

    let peakForce = 0;
    let totalContacts = 0;
    for (let i = 0; i < 60; i++) {
      world.tick(1 / 60, eventQueue);
      const contacts = drainContacts(eventQueue, world, 0);
      totalContacts += contacts.length;
      for (const c of contacts) if (c.forceMagnitude > peakForce) peakForce = c.forceMagnitude;
    }
    // eslint-disable-next-line no-console
    console.log(`[DIAGNOSTIC drone path] same-position spawnObstacle crossguards: ${totalContacts} contacts across 60 ticks, peak force ${peakForce.toFixed(1)} N`);
    // Diagnostic-only (no assertion). With TRIANGLE colliders (2026-06-11)
    // this DOES emit contacts for static overlap; the asserted positive
    // control is "two T-ships at the SAME point emit contacts" above.

    world.dispose();
  });

  it('DIAGNOSTIC: prints peak force for two crossguards at same position (worker floor is 200 N)', async () => {
    // The worker's CONTACT_FORCE_FLOOR is 200 — anything below is filtered.
    // Two stationary penetrating zero-density bodies may produce LOW forces
    // because the resolver doesn't have closing velocity to bounce off.
    // This test prints the actual force range so we can choose the right
    // floor / velocity / test design.
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    const crossguard = getShipKind('crossguard');

    world.spawnShip('a', 0, 0, 'crossguard');
    world.spawnShip('b', 0, 0, 'crossguard');
    world.setShipState('a', { x: 0, y: 0, angle: 0,       vx: 0, vy: 0, angvel: 0 });
    world.setShipState('b', { x: 0, y: 0, angle: Math.PI, vx: 0, vy: 0, angvel: 0 });
    world.setHullExposed('a', true, crossguard);
    world.setHullExposed('b', true, crossguard);

    let peakForce = 0;
    let totalContacts = 0;
    for (let i = 0; i < 60; i++) {
      world.tick(1 / 60, eventQueue);
      const contacts = drainContacts(eventQueue, world, 0);
      totalContacts += contacts.length;
      for (const c of contacts) if (c.forceMagnitude > peakForce) peakForce = c.forceMagnitude;
    }
    // eslint-disable-next-line no-console
    console.log(`[DIAGNOSTIC] same-position crossguards: ${totalContacts} contacts across 60 ticks, peak force ${peakForce.toFixed(1)} N (worker floor 200)`);
    // Diagnostic-only — the asserted positive control ("two T-ships at the
    // SAME point emit contacts") covers the event-firing guarantee.

    world.dispose();
  });
});
