/**
 * Living World P4a (plan peppy-jumping-pinwheel) — named ELITES over real
 * SectorRooms.
 *
 *  1. the EliteDirector spawns an elite: a real drone with a name and 4× its
 *     kind's hull;
 *  2. a client in the sector sees the elite's NAME on the snapshot
 *     (`drones[].elite` — the #16 carrier, not just the world notice);
 *  3. the galaxy hook reports the elite in its sector;
 *  4. killing it drops the guaranteed rare haul (Robot Cores + 200+ credits),
 *     announces it galaxy-wide, and a replacement appears after the delay.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { EliteDirector } from '../../../src/server/livingworld/EliteDirector.js';
import { ELITE_HEALTH_MUL } from '../../../src/shared-types/elites.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { WorldNotice } from '../../../src/shared-types/worldNotice.js';

describe('SectorRoom integration — named elites (P4a)', () => {
  let h: LivingWorldTestHarness | undefined;
  let elites: EliteDirector | undefined;
  afterEach(async () => {
    elites?.stop();
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('spawns a named elite that clients see, and it drops a rare haul when killed', { timeout: 40_000 }, async () => {
    h = await bootLivingWorldTestServer({ sectors: ['greenfall', 'emerald-span'], botCount: 0, seed: 3 });
    const clock = { now: 1_000_000 };
    const rooms = new Map<string, LivingWorldRoom>([
      ['greenfall', h.getRoom('greenfall') as unknown as LivingWorldRoom],
      ['emerald-span', h.getRoom('emerald-span') as unknown as LivingWorldRoom],
    ]);
    const room = h.getRoom('greenfall');

    // A pilot in the sector, listening for the elite name + notices.
    const pilot = await h.connectActive(randomUUID(), 'greenfall', { initialHull: 99999 });
    let seenName: string | null = null;
    const notices: WorldNotice[] = [];
    pilot.onMessage('snapshot', (snap: SnapshotMessage) => {
      const e = snap.drones?.find((d) => d.elite !== undefined);
      if (e?.elite !== undefined) seenName = e.elite;
    });
    pilot.onMessage('world_notice', (n: WorldNotice) => notices.push(n));

    elites = new EliteDirector(rooms, {
      maxElites: 1, firstSector: 'greenfall', kind: 'gunship', respawnMs: 500, nowMs: () => clock.now,
    });
    elites.start();

    const [e] = elites.elites();
    expect(e?.sectorKey).toBe('greenfall');
    const rec = room._internals.swarmRegistry.get(e!.id)!;
    expect(rec.elite?.name).toBe(e!.name);
    expect(rec.elite?.maxHealth).toBe(getShipKind('gunship').maxHealth * ELITE_HEALTH_MUL);
    expect(elites.sectorElite('greenfall')).toBe(e!.name);
    expect(elites.sectorElite('emerald-span')).toBeNull();

    await h.waitUntil(() => seenName !== null, 6000, 'client saw the elite name on the snapshot');
    expect(seenName).toBe(e!.name);
    await h.waitUntil(() => notices.some((n) => n.kind === 'elite_spawned'), 3000, 'sighting notice');

    // Kill it: the rare haul spills (cores + credits ≥ 200), the galaxy hears.
    const podsBefore = getHoldStore().inSector('greenfall', 'pod').length;
    for (let i = 0; i < 20 && room._internals.swarmRegistry.get(e!.id); i++) {
      room._internals.applyDamage(e!.id, 'some-player', 5_000);
    }
    expect(room._internals.swarmRegistry.get(e!.id)).toBeFalsy();
    const pods = getHoldStore().inSector('greenfall', 'pod');
    expect(pods.length).toBeGreaterThan(podsBefore);
    const cores = pods.reduce((s, p) => s + (p.hold.goods.core ?? 0), 0);
    const credits = pods.reduce((s, p) => s + p.hold.credits, 0);
    expect(cores).toBeGreaterThanOrEqual(1);
    expect(credits).toBeGreaterThanOrEqual(200);
    expect(elites.elites()).toHaveLength(0);
    await h.waitUntil(() => notices.some((n) => n.kind === 'elite_killed'), 3000, 'kill notice');

    // A replacement appears after the respawn delay.
    clock.now += 1000;
    elites.tick(clock.now);
    expect(elites.elites()).toHaveLength(1);
  });
});
