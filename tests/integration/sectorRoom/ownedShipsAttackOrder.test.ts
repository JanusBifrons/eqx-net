/**
 * RTS Part B slice 8 — the Attack order reaches the AI pilot brain flying an
 * owned hull (`orderIssued` → `SectorRoom.syncHullOrder` →
 * `HostileDroneBehaviour.setOrderedTarget`).
 *
 * A Defensive ship (fights only what hit it) parked at its post is ordered
 * onto a NEUTRAL drone outside its guard radius: it leaves the post, locks
 * and damages the drone. When the drone dies the order completes (the fleet
 * status shows the ship's mode again, no order) and the ship flies back to
 * its post.
 *
 * Failing first: before this slice an attack order never reached the brain,
 * so a Defensive ship ignored the neutral drone and never left its post.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

describe('SectorRoom integration — the Attack order (RTS Part B slice 8)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a Defensive ship ordered onto a neutral drone attacks it, and goes back to its post once it dies', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.fleet.isAttached(sid)).toBe(true);
    expect(internals.fleet.brainOf(sid)!.stance, 'Defensive is the default').toBe('defensive');
    const post = { ...internals.lingeringPoseCache.get(sid)! };

    // A neutral drone outside the guard radius, straight ahead.
    const R = shipTuning(getShipKind('fighter')).guardRadiusMin;
    expect(internals.spawnTestDrone('d', post.x, post.y + R * 1.5, 'fighter')).toBe(true);
    const start = internals.swarmHealth.get('d')!;
    await harness.advance(1000);
    expect(internals.aiBrainOf(sid)?.getTargetId?.() ?? null, 'Defensive: the neutral drone is left alone').toBeNull();
    expect(internals.npcHostileTo('d', pid), 'precondition: neutral').toBe(false);

    client.send('fleet_order', { type: 'fleet_order', shipIds: [sid], kind: 'attack', targetId: 'd' });
    let far = 0;
    let hit = false;
    for (let i = 0; i < 80 && !hit; i++) {
      await harness.advance(250);
      const p = internals.lingeringPoseCache.get(sid)!;
      far = Math.max(far, Math.hypot(p.x - post.x, p.y - post.y));
      const h = internals.swarmHealth.get('d');
      hit = h === undefined || h < start;
    }
    expect(hit, 'the ordered ship damaged the neutral drone').toBe(true);
    expect(internals.aiBrainOf(sid)?.getTargetId?.()).toBe('d');
    const o = internals.fleet.brainOf(sid)!.order;
    expect(o?.kind).toBe('attack');

    // Finish it (trigger: one big hit from the ship through the room's damage
    // choke point, the death path any kill runs); the order completes.
    for (let i = 0; i < 10 && internals.swarmHealth.has('d'); i++) internals.applyDamage('d', sid, 1_000_000);
    for (let i = 0; i < 20 && internals.fleet.brainOf(sid)!.order !== null; i++) await harness.advance(100);
    expect(internals.fleet.brainOf(sid)!.order, 'the order completed when its target died').toBeNull();
    expect(internals.fleet.brainOf(sid)!.mode, 'the ship is back on its mode').toBe('defend');
    expect(internals.aiBrainOf(sid)?.getOrderedTarget?.() ?? null).toBeNull();

    let back = Infinity;
    for (let i = 0; i < 60 && back > R * 0.5; i++) {
      await harness.advance(250);
      const p = internals.lingeringPoseCache.get(sid)!;
      back = Math.hypot(p.x - post.x, p.y - post.y);
    }
    expect(far, 'it left its guard radius for the ordered target').toBeGreaterThan(R * 0.5);
    expect(back, 'back at its post').toBeLessThan(R * 0.5);
    await harness.disconnectClient(client);
  }, 60_000);
});
