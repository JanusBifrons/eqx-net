/**
 * RTS command layer, slice 4b — a wingman boosts on a long leg, and pays for
 * it from the HULL's own energy pool like a pilot (`BOOST_TICK_COST` a tick,
 * gated by the same `canAfford` the pilot's input handler uses).
 *
 * Flow: two pilots park identical fighters (Spectate) and order the same long
 * move. One hull flies as normal; its twin has boost denied (the control).
 * The boosting hull flies faster than the twin's cruise and its energy falls.
 * Once its pool can't afford a tick the boost bit is dropped (every boost the
 * room posts is affordable at that moment) and the pool never goes negative.
 *
 * Failing-first: before 4b `canBoost` was `() => false`, so both hulls flew
 * the same speed and neither pool fell.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { BOOST_TICK_COST } from '../../../src/core/combat/Energy.js';

interface Pose { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }
interface Ctl { thrust: boolean; boost: boolean }

describe('SectorRoom integration — a wingman boosts on its own energy (RTS slice 4b)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a long move boosts past cruise, drains the hull pool, and stops boosting when it runs out', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();
    const clientA = await harness.connectActive(pidA, { shipKind: 'fighter', spawnX: -3000, spawnY: 600 });
    const clientB = await harness.connectActive(pidB, { shipKind: 'fighter', spawnX: -3000, spawnY: -600 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;

    const activeOf = (pid: string): string => {
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    const boosted = activeOf(pidA);
    const control = activeOf(pidB);
    expect(boosted).not.toBe('');
    expect(control).not.toBe('');

    clientA.send('spectate', { type: 'spectate' });
    clientB.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.fleet.isAttached(boosted), 'the parked hull has a wingman brain').toBe(true);
    expect(internals.fleet.isAttached(control)).toBe(true);

    // The control twin never boosts: wrap the room's energy gate for it only.
    const hooks = (internals.fleet as unknown as { hooks: { canBoost: (id: string) => boolean } }).hooks;
    const gate = hooks.canBoost;
    hooks.canBoost = (id) => id !== control && gate(id);

    const ship = state.ships.get(boosted)!;
    const kind = getShipKind('fighter');
    const energyMax = kind.energyMax ?? 100;
    // Let the pool fill (regen runs for wingman hulls since slice 5).
    for (let i = 0; i < 40 && ship.energy < energyMax - 0.01; i++) await harness.advance(250);
    expect(ship.energy).toBeGreaterThan(energyMax * 0.95);

    // Every boost the room posts must be affordable at that moment; count the
    // posts where the gate dropped a held boost because the pool ran dry.
    let boostPosts = 0;
    let unaffordableBoostPosts = 0;
    let droppedForEnergy = 0;
    let prevBoost = false;
    const r = room as unknown as {
      postWingmanInput: (id: string, c: Ctl, t: number) => void;
      readLingeringPose: (id: string, out: Pose) => boolean;
    };
    const orig = r.postWingmanInput.bind(room);
    r.postWingmanInput = (id, c, t) => {
      if (id === boosted) {
        if (c.boost) {
          boostPosts++;
          if (ship.energy < BOOST_TICK_COST) unaffordableBoostPosts++;
        } else if (prevBoost && c.thrust && ship.energy < BOOST_TICK_COST) {
          droppedForEnergy++;
        }
        prevBoost = c.boost;
      }
      orig(id, c, t);
    };

    // The same long leg east for both.
    expect(internals.fleet.applyOrder(pidA, [boosted], { kind: 'move', x: 3000, y: 600 })).toEqual([boosted]);
    expect(internals.fleet.applyOrder(pidB, [control], { kind: 'move', x: 3000, y: -600 })).toEqual([control]);

    const pose: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    let peakBoosted = 0;
    let peakControl = 0;
    let minEnergy = Infinity;
    let controlMinEnergy = Infinity;
    const controlShip = state.ships.get(control)!;
    for (let i = 0; i < 60; i++) {
      await harness.advance(100);
      if (r.readLingeringPose(boosted, pose)) peakBoosted = Math.max(peakBoosted, Math.hypot(pose.vx, pose.vy));
      if (r.readLingeringPose(control, pose)) peakControl = Math.max(peakControl, Math.hypot(pose.vx, pose.vy));
      minEnergy = Math.min(minEnergy, ship.energy);
      controlMinEnergy = Math.min(controlMinEnergy, controlShip.energy);
    }

    expect(boostPosts, 'the wingman asked for boost on the long leg').toBeGreaterThan(0);
    expect(peakBoosted, `boosted peak ${peakBoosted.toFixed(0)} u/s vs unboosted ${peakControl.toFixed(0)} u/s`)
      .toBeGreaterThan(peakControl * 1.15);
    expect(minEnergy, 'boost drained the hull pool').toBeLessThan(BOOST_TICK_COST * 2);
    expect(minEnergy, 'never below zero').toBeGreaterThanOrEqual(0);
    expect(controlMinEnergy, 'the unboosted twin keeps its pool').toBeGreaterThan(energyMax * 0.9);
    expect(unaffordableBoostPosts, 'no boost posted the pool could not afford').toBe(0);
    expect(droppedForEnergy, 'the gate dropped boost when the pool ran out').toBeGreaterThan(0);

    await harness.disconnectClient(clientA);
    await harness.disconnectClient(clientB);
  }, 60_000);
});
