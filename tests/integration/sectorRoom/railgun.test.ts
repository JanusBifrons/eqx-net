/**
 * The capital railgun through a real SectorRoom (plan beam-slices §7):
 *  - a slug that KILLS a capital cuts it with a channel (`cutKind: 'channel'`,
 *    as wide as the drawn bolt) and flies on at full damage to kill the
 *    capital behind it, then stops in the first ship that survives;
 *  - each pass-through kill reaches a viewer as a `shell_end` tuple with
 *    `continues: 1`, and the final hit as a plain one;
 *  - the testMode `chargeTicksCap` trigger lets a charge weapon fire without
 *    waiting out its real wind-up (the per-mount start ticks ride the
 *    snapshot meanwhile);
 *  - a real `battleship-rail` AI charges its railgun main turrets and fires;
 *    its slug kills a ship in its line and stops in its target (the
 *    `traverseTicksCap` trigger snaps its turrets onto their bearings: a 16"
 *    turret trains at ~4 deg/s, ~15 s of waiting otherwise).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { ShellEndSchema, type ShellEnd } from '../../../src/shared-types/messages/shellEvents.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';

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

  it('a battleship-rail AI charges its main turrets and fires railgun slugs after the chargeTicksCap, not the real 6 s', { timeout: 15_000 }, async () => {
    // The rail fit puts the railgun on every main mount (capital fit axis, plan §9).
    const rails = (getShipKind('battleship-rail').mounts ?? []).filter((m) => m.weaponId === 'railgun');
    expect(rails.length, 'battleship-rail carries railgun main turrets').toBeGreaterThan(0);
    const CAP = 30;
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true,
      chargeTicksCap: CAP, lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [{ kind: 'battleship-rail', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
    });
    const cr = await harness.connectActive(randomUUID(), {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    let firstStart = -1;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const d of snap.drones ?? []) if ((d.chargingMask ?? 0) !== 0 && firstStart < 0) firstStart = d.chargeStartTick ?? -1;
    });
    const salvos: ShellSalvo[] = [];
    cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'railgun') salvos.push(m); });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && salvos.length === 0) await new Promise((r) => setTimeout(r, 50));
    expect(firstStart, 'a main-turret charge was seen').toBeGreaterThanOrEqual(0);
    expect(salvos.length, 'the charged railgun fired').toBeGreaterThan(0);
    const waited = salvos[0]!.t - firstStart;
    expect(waited).toBeGreaterThanOrEqual(CAP);
    expect(waited, "the cap, not the weapon's own 360-tick charge").toBeLessThan(RAIL.chargeTicks!);
  });

  it("a battleship-rail AI's slug kills a ship in its line, flies on and stops in its target", { timeout: 15_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true,
      chargeTicksCap: 30, lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [{ kind: 'battleship-rail', x: 9000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
      spawnX: 0, spawnY: 0,
    });
    const railShells = new Set<string>();
    cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'railgun') for (const s of m.sh) railShells.add(String(s[0])); });
    const ends: ShellEnd[] = [];
    cr.onMessage('shell_end', (m: unknown) => {
      const r = ShellEndSchema.safeParse(m);
      expect(r.success, 'shell_end matches its schema').toBe(true);
      if (r.success) ends.push(r.data);
    });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    let charging = false;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const d of snap.drones ?? []) if ((d.chargingMask ?? 0) !== 0) charging = true;
    });
    const railTuples = (): ShellEnd['e'] => ends.flatMap((m) => m.e).filter((t) => railShells.has(String(t[0])));
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !charging) await harness.advance(25);
    expect(charging, 'the rail battleship charged its main turrets').toBe(true);
    // Once the railguns charge, put a picket of neutral (trader) hulls across
    // the slug's line near the target, each with less hull than one slug.
    // (NPCs hold fire only for FRIENDLIES on the line, LineOfFireGate, so a
    // drones-side blocker would rightly keep the battleship silent; traders
    // wander, hence the late spawn: the capped charge is 30 ticks. A picket
    // tight enough that one slug (one barrel per turret) cannot slip between;
    // close to the target, where the turrets' converging lines are within ±150 u.)
    const bb = [...internal.swarmRegistry.all()].find((r) => r.shipKind === 'battleship-rail');
    const bp = bb ? internal.swarmPose(bb.id) : null;
    const pp = internal.playerPose(pid);
    expect(bp && pp, 'both ends of the line').toBeTruthy();
    const len = Math.hypot(bp!.x - pp!.x, bp!.y - pp!.y);
    const ux = (bp!.x - pp!.x) / len, uy = (bp!.y - pp!.y) / len;
    const pickets: string[] = [];
    for (let i = -5; i <= 5; i++) {
      const id = `picket-${i + 5}`;
      const along = len * 0.06;
      expect(internal.spawnTestDrone(id, pp!.x + ux * along - uy * i * 30, pp!.y + uy * along + ux * i * 30, 'trader-hauler')).toBe(true);
      internal.swarmHealth.set(id, RAIL.damage - 1);
      pickets.push(id);
    }
    while (Date.now() < deadline && !railTuples().some((t) => t[5] === undefined)) await harness.advance(50);
    expect(railShells.size, 'the rail battleship fired its railguns').toBeGreaterThan(0);
    expect(pickets.some((id) => !internal.swarmRegistry.get(id)), 'a slug killed a ship in its line').toBe(true);
    const all = railTuples();
    const through = all.filter((t) => t[5] === 1);
    expect(through.length, 'a pass-through kill reached the viewer').toBeGreaterThan(0);
    // The same slug flew on and ended past the killed ship, at the target.
    const fin = all.filter((t) => t[5] === undefined && t[0] === through[0]![0]);
    expect(fin, 'the slug that killed flew on and stopped in its target').toHaveLength(1);
    const far = (t: ShellEnd['e'][number]): number => Math.hypot(t[2] - bp!.x, t[3] - bp!.y);
    expect(far(fin[0]!), 'it ended beyond the kill').toBeGreaterThan(far(through[0]!));
  });
});
