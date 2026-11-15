/**
 * The capital railgun through a real SectorRoom (plan beam-slices §7):
 *  - a slug that KILLS a capital cuts it with a channel (`cutKind: 'channel'`,
 *    as wide as the drawn bolt) and flies on at full damage to kill the
 *    capital behind it, then stops in the first ship that survives;
 *  - each pass-through kill reaches a viewer as a `shell_end` tuple with
 *    `continues: 1`, and the final hit as a plain one;
 *  - the testMode `chargeTicksCap` trigger lets a charge weapon fire without
 *    waiting out its real wind-up (the per-mount start ticks ride the
 *    snapshot meanwhile).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { ShellEndSchema, type ShellEnd } from '../../../src/shared-types/messages/shellEvents.js';
import { getWeapon, type WeaponDef } from '../../../src/core/combat/WeaponCatalogue.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';

type Mutable = { -readonly [K in keyof WeaponDef]?: WeaponDef[K] };
import { RAILGUN_BOLT_WIDTH } from '../../../src/shared-types/combat/navalGuns.js';
import { shipShapeScale } from '../../../src/core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const RAIL = getWeapon('railgun');

describe('SectorRoom integration — railgun', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a railgun kill cuts a channel and the slug kills the capital behind, then stops in a survivor', { timeout: 60_000 }, async () => {
    expect(RAIL.mode).toBe('projectile');
    expect(RAIL.killCut).toEqual({ kind: 'channel', width: RAILGUN_BOLT_WIDTH });
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], capitalWrecks: true,
    });
    // A viewer beside the rail line (the slug's path crosses its view).
    const viewer = await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: 9000, spawnY: 4000 });
    const ends: ShellEnd[] = [];
    viewer.onMessage('shell_end', (m: unknown) => {
      const r = ShellEndSchema.safeParse(m);
      expect(r.success, 'shell_end matches its schema').toBe(true);
      if (r.success) ends.push(r.data);
    });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    // Three capitals on one line along +x; the third can't be killed.
    expect(internal.spawnTestDrone('bb-1', 6000, 0, 'battleship')).toBe(true);
    expect(internal.spawnTestDrone('bb-2', 9000, 0, 'battleship')).toBe(true);
    expect(internal.spawnTestDrone('wall', 12_000, 0, 'battleship')).toBe(true);
    await harness.advance(100);
    internal.swarmHealth.set('bb-1', 100);
    internal.swarmHealth.set('bb-2', 100);
    internal.swarmHealth.set('wall', 1e15);
    const DMG = 1e7;
    const speed = RAIL.mode === 'projectile' ? RAIL.speed : 0;
    internal.spawnTestProjectile('rail-x', 2000, 0, speed, 0, 'railgun', DMG);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && internal.swarmHealth.get('wall') === 1e15) await harness.advance(100);

    expect(internal.swarmRegistry.get('bb-1'), 'the first capital died').toBeFalsy();
    expect(internal.swarmRegistry.get('bb-2'), 'the slug flew on and killed the second').toBeFalsy();
    // Full damage on the third: it took exactly one slug's worth, and stopped it.
    expect(internal.swarmHealth.get('wall')).toBe(1e15 - DMG);

    // Both kills cut a channel as wide as the bolt (in hull units).
    const descs = internal.wreckDescriptors().filter((d) => d.parentKind === 'battleship');
    expect(descs.length).toBe(2);
    const wantW = RAILGUN_BOLT_WIDTH / shipShapeScale(getShipKind('battleship'));
    for (const d of descs) {
      expect(d.cutKind).toBe('channel');
      expect(d.cutW).toBeCloseTo(wantW, 3);
    }

    // The viewer saw two pass-through hits, then the final one.
    const deadline2 = Date.now() + 5_000;
    const tuples = (): ShellEnd['e'] => ends.flatMap((m) => m.e);
    while (Date.now() < deadline2 && !tuples().some((t) => t[5] === undefined)) await harness.advance(50);
    const all = tuples();
    expect(all.filter((t) => t[5] === 1).map((t) => Math.round(t[2] / 1000))).toEqual([expect.any(Number), expect.any(Number)]);
    const fin = all.filter((t) => t[5] === undefined);
    expect(fin).toHaveLength(1);
    // In order along the line, all the same shell.
    expect(new Set(all.map((t) => t[0])).size).toBe(1);
    const xs = all.map((t) => t[2]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(fin[0]![2]).toBeGreaterThan(10_000);
  });

  it('testMode chargeTicksCap: a railgun-length charge fires after the cap, not its real 6 s', { timeout: 60_000 }, async () => {
    // No ship carries the railgun yet (capital variants come later): give the
    // battleship's 16" the railgun's charge for this test (in-process room).
    const xl = getWeapon('naval_xl') as Mutable;
    const saved = { chargeTicks: xl.chargeTicks, chargeRelease: xl.chargeRelease, chargeTelegraph: xl.chargeTelegraph };
    xl.chargeTicks = RAIL.chargeTicks; xl.chargeRelease = 'when-bearing'; xl.chargeTelegraph = 'mount-glow';
    const CAP = 30;
    try {
      harness = await bootSectorTestServer({
        sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true,
        chargeTicksCap: CAP, lockTimeCapS: 0,
        dronePoses: [{ kind: 'battleship', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
      });
      const cr = await harness.connectActive(randomUUID(), {
        shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
      });
      let firstStart = -1;
      cr.onMessage('snapshot', (snap: SnapshotMessage) => {
        for (const d of snap.drones ?? []) if ((d.chargingMask ?? 0) !== 0 && firstStart < 0) firstStart = d.chargeStartTick ?? -1;
      });
      const salvos: ShellSalvo[] = [];
      cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'naval_xl') salvos.push(m); });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && salvos.length === 0) await new Promise((r) => setTimeout(r, 50));
      expect(firstStart, 'a charge was seen').toBeGreaterThanOrEqual(0);
      expect(salvos.length, 'the charged 16" fired').toBeGreaterThan(0);
      const waited = salvos[0]!.t - firstStart;
      expect(waited).toBeGreaterThanOrEqual(CAP);
      expect(waited, "the cap, not the weapon's own 360-tick charge").toBeLessThan(RAIL.chargeTicks!);
    } finally {
      xl.chargeTicks = saved.chargeTicks; xl.chargeRelease = saved.chargeRelease; xl.chargeTelegraph = saved.chargeTelegraph;
    }
  });
});
