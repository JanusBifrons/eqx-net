/**
 * Capital combat (plan prancy-squishing-donut Phase 3), through a real
 * SectorRoom: a hostile battleship engages a pilot at MAIN-BATTERY range and
 * lands 16" hits.
 *
 * The pilot sits 5,000 u from the battleship's centre, out of reach of every gun
 * except the 16" main battery. Fails on the pre-Phase-3 code three ways: drone
 * turrets only looked 250 u from the hull's centre (a battleship could never
 * engage anything outside its own hull), capitals carried the fighter bolt and
 * autocannon, and every mount fired along the hull's aim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { DamageEvent, SnapshotMessage } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';

describe('SectorRoom integration — capital main battery (Phase 3)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      // The pilot (origin) 40° off the battleship's bow: clear of the hull
      // (guns never fire along their own deck), and only a ~10 s swing at the
      // real 4°/s traverse. 5" reach can't cover the gap.
      dronePoses: [{ kind: 'battleship', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('fires 16" shells that hit a pilot 5,000 u away', { timeout: 60_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 1_000_000, initialShield: 0, startHostile: true });
    const hits: DamageEvent[] = [];
    cr.onMessage('damage', (e: DamageEvent) => {
      if (e.targetId === pid) hits.push(e);
    });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && hits.length === 0) await new Promise((r) => setTimeout(r, 100));

    expect(hits.length, 'the battleship never hit the pilot at main-battery range').toBeGreaterThan(0);
    expect(hits[0]!.damage, 'the hit should be a 16" shell').toBe(getWeapon('naval_xl').damage);
  });

  it('a triple turret fires a three-shell salvo (one per barrel)', { timeout: 60_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 1_000_000, initialShield: 0, startHostile: true });
    let maxXl = 0;
    const owners = new Set<string>();
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      let n = 0;
      for (const p of snap.projectiles ?? []) if (p.weaponId === 'naval_xl') { n++; owners.add(p.ownerId); }
      maxXl = Math.max(maxXl, n);
    });
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && maxXl < 3) await new Promise((r) => setTimeout(r, 100));
    // Each battleship main turret has three barrels: one firing puts 3 shells up.
    expect(maxXl, 'a 16" turret should put three shells in the air').toBeGreaterThanOrEqual(3);
    // The owner is the id the client draws the battleship under, so the
    // renderer can match each shell to its gun (recoil + muzzle flash).
    for (const o of owners) expect(o).toMatch(/^swarm-\d+$/);
  });

  it('the pilot sees the shells leave the barrels (not only once they are near)', { timeout: 60_000 }, async () => {
    // The battleship is visible from 5,000 u (a wide entity), so its shells
    // must be too: the fixed 3,072 u projectile box hid them until they were
    // close, so a viewer never saw a salvo fired (review round, 2026-11-07).
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 1_000_000, initialShield: 0, startHostile: true });
    let farthest = 0;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const p of snap.projectiles ?? []) if (p.weaponId === 'naval_xl') farthest = Math.max(farthest, Math.abs(p.x));
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && farthest < 3300) await new Promise((r) => setTimeout(r, 100));
    expect(farthest, 'no shell seen near the battleship\'s muzzles').toBeGreaterThan(3300);
  });

  it('the pilot sees the turrets turned toward it (drones[].mountAngles)', { timeout: 60_000 }, async () => {
    // The guns are drawn from the snapshot's mount angles (#16). A target the
    // battleship can shoot must also SEE the turrets aim, or the guns fire
    // from barrels drawn pointing along the hull.
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 1_000_000, initialShield: 0, startHostile: true });
    let maxTurn = 0;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const d of snap.drones ?? []) for (const a of d.mountAngles ?? []) maxTurn = Math.max(maxTurn, Math.abs(a));
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && maxTurn < 0.5) await new Promise((r) => setTimeout(r, 100));
    expect(maxTurn, 'no turret angles reached the pilot').toBeGreaterThan(0.5);
  });
});
