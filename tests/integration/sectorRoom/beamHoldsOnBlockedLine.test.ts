/**
 * Fire control's blocked-line hold (owner 2026-11-18): "all turrets should
 * point towards their target ready and then open fire the moment that the ray
 * test succeeds ... a delay before acting so a brief interruption doesn't
 * instantly stop shooting ... really it's laser beams and railguns."
 *
 * A pilot's fighter carries a beam (`hitscan`) beside its own bolt gun
 * (`laser`, a projectile), locked on a drone with a rock between them:
 *  - the beam fires into the rock at first, then holds once the line has
 *    been blocked for the tolerance (`BLOCKED_LINE_HOLD_MS`);
 *  - the bolt gun (a shot with a travel time) keeps firing throughout;
 *  - the beam fires again the moment the rock is gone;
 *  - a rock that crosses the line for less than the tolerance never stops it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { BLOCKED_LINE_HOLD_MS } from '../../../src/core/combat/blockedLineHold.js';

type Hit = { target: string; weapon: unknown; at: number };

describe('SectorRoom integration: a beam holds fire on a blocked line', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function setup() {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], peacefulDrones: true });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true })) as ClientRoom<SectorState>;
    const room = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = id;
    const internals = room._internals;
    expect(internals.spawnTestDrone('bl-target', 0, 400, 'fighter')).toBe(true);
    const mounts = [{ slotId: 'latent-wing-l', weaponId: 'hitscan' as const }];
    getPlayerShipStore().setProgress(shipId, { mounts });
    room.state.ships.get(shipId)!.mounts = mounts;
    harness.lockTarget(pid, 'bl-target');
    await harness.advance(100);
    const hits: Hit[] = [];
    const r = room as unknown as { applyDamage: (t: string, s: string, ...rest: unknown[]) => unknown };
    const orig = r.applyDamage.bind(r);
    r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
      if (s === pid) hits.push({ target: t, weapon: rest[5], at: Date.now() });
      return orig(t, s, ...rest);
    };
    let tick = 100;
    /** Hold the trigger for `ms` (one `fire` per 100 ms, the client's cadence). */
    const fireFor = async (ms: number): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        cr.send('fire', { type: 'fire', tick, clientShotId: `f${tick}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
        tick += 6;
        await harness.advance(100);
      }
    };
    const evict = (id: string): void => {
      const rec = internals.swarmRegistry.get(id)!;
      (room as unknown as { evictSwarmEntity: (r: unknown, o: unknown) => void }).evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
    };
    return { internals, hits, fireFor, evict };
  }

  const beam = (h: Hit): boolean => h.weapon === 'hitscan';
  const isTarget = (h: Hit): boolean => h.target === 'bl-target' || h.target.startsWith('swarm-');

  it('holds after the tolerance, keeps the bolt gun firing, and resumes when the line clears', { timeout: 40_000 }, async () => {
    const { internals, hits, fireFor, evict } = await setup();
    expect(internals.spawnTestAsteroid('bl-rock', 0, 200, 40)).toBe(true);
    await harness.advance(100);
    const t0 = Date.now();
    await fireFor(BLOCKED_LINE_HOLD_MS * 4);
    const early = hits.filter((h) => beam(h) && h.at - t0 < BLOCKED_LINE_HOLD_MS * 0.6);
    const lateFrom = t0 + BLOCKED_LINE_HOLD_MS * 2;
    const lateBeam = hits.filter((h) => beam(h) && h.at >= lateFrom);
    const lateBolts = hits.filter((h) => !beam(h) && h.at >= lateFrom);
    expect(early.length, 'the beam fires into the rock before the tolerance runs out').toBeGreaterThan(0);
    expect(early.every((h) => h.target === 'bl-rock'), 'the rock takes the early beam: ' + JSON.stringify(early)).toBe(true);
    expect(lateBeam.length, 'the beam holds once the line has been blocked for the tolerance: ' + JSON.stringify(lateBeam)).toBe(0);
    expect(lateBolts.length, 'the bolt gun (a shot with a travel time) keeps firing').toBeGreaterThan(0);
    evict('bl-rock');
    const t1 = Date.now();
    await fireFor(600);
    const resumed = hits.filter((h) => beam(h) && h.at >= t1);
    expect(resumed.length, 'the beam fires again once the line is clear').toBeGreaterThan(0);
    expect(resumed.every(isTarget), 'it lands on the target: ' + JSON.stringify(resumed)).toBe(true);
  });

  it('a brief crossing (shorter than the tolerance) never stops the beam', { timeout: 40_000 }, async () => {
    const { internals, hits, fireFor, evict } = await setup();
    await fireFor(300);
    expect(hits.filter((h) => beam(h) && isTarget(h)).length, 'the beam is on the target').toBeGreaterThan(0);
    expect(internals.spawnTestAsteroid('bl-cross', 0, 200, 40)).toBe(true);
    const tc = Date.now();
    await fireFor(BLOCKED_LINE_HOLD_MS * 0.5);
    evict('bl-cross');
    const during = hits.filter((h) => beam(h) && h.at >= tc);
    expect(during.length, 'the beam kept firing while the rock crossed').toBeGreaterThan(0);
    const t1 = Date.now();
    await fireFor(400);
    expect(hits.filter((h) => beam(h) && isTarget(h) && h.at >= t1).length, 'and carries on at the target').toBeGreaterThan(0);
  });
});
