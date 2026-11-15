/**
 * The mining barge (plan partitioned-chasing-lark PR 15) through the REAL
 * room: a pilot joins in the `barge` kind, locks a rock abeam with each
 * weapon group through the real lock path (`instantLock` + `lockTarget`) and
 * fires each group through the real `fire` message. The tractor group holds
 * tractor fields on the rock (force by mount size); the mining-laser group
 * hits it, owing ore that the 1 Hz pulse draws into the barge's hold.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { MOUNT_SIZE_TUNING } from '../../../src/shared-types/shipScale/tuning.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { TractorForceField } from '../../../src/core/physics/forceFields.js';

describe('SectorRoom integration — the mining barge kind', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('spawns as a pilot ship; its tractors and mining lasers fire at a locked rock', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
    });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'barge', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    for (const t of ['snapshot', 'laser_fired', 'swarm', 'damage']) cr.onMessage(t, () => {});
    let rejected = 0;
    cr.onMessage('hit_ack', (a: { rejected?: boolean }) => { if (a.rejected) rejected++; });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) { shipId = id; expect(s.kind).toBe('barge'); }
    expect(shipId).not.toBe('');

    // A rock abeam, clear of the hull, inside every mount's reach.
    const kind = getShipKind('barge');
    const mounts = kind.mounts ?? [];
    const edge = Math.max(...mounts.map((m) => Math.abs(m.localX)));
    let rockId = '';
    for (const side of [1, -1]) {
      const id = `rock-${side > 0 ? 'p' : 'n'}`;
      expect(int().spawnTestAsteroid(id, side * (edge + 700), 0, 60)).toBe(true);
      rockId ||= id;
    }
    await harness.advance(100);

    let tick = 0;
    const fire = (slotId: string): void => {
      cr.send('fire', { type: 'fire', tick, clientShotId: `${slotId}${tick}`, weapon: 'hitscan', dirAngle: 0, slotId });
      tick += 10;
    };
    const tractorFields = (): Array<{ m: (typeof mounts)[number]; f: TractorForceField }> => mounts
      .map((m) => ({ m, f: int().forceFields.get(`tractor:${pid}:${m.id}`) as TractorForceField | undefined }))
      .filter((x): x is { m: (typeof mounts)[number]; f: TractorForceField } => x.f !== undefined);

    // Tractors: try each side's rock until the group's mounts slew onto it
    // (the side mounts rest abeam; the rows reach far fore and aft).
    let fields: ReturnType<typeof tractorFields> = [];
    for (const id of ['rock-p', 'rock-n']) {
      harness.lockTarget(pid, id, 'tractor');
      for (let i = 0; i < 40 && fields.length === 0; i++) { fire('tractor'); await harness.advance(100); fields = tractorFields(); }
      if (fields.length > 0) { rockId = id; break; }
    }
    const pose = int().playerPose(pid);
    expect(fields.length, `tractor mounts bearing on the rock hold a field on it (pose ${JSON.stringify(pose)}, rejected ${rejected})`).toBeGreaterThan(0);
    for (const { m, f } of fields) {
      expect(f.target).toBe(rockId);
      expect(f.emitter).toBe(pid);
      expect(m.weaponId).toBe('tractor');
      expect(f.force).toBe(getWeapon('tractor').tractor!.force * MOUNT_SIZE_TUNING[m.size ?? 'S'].power);
    }

    // Mining lasers on the same rock: hits owe ore, the pulse draws it.
    const rock = int().swarmRegistry.get(rockId)!;
    const pool0 = rock.resources!;
    harness.lockTarget(pid, rockId, 'laser');
    for (let i = 0; i < 10; i++) { fire('laser'); await harness.advance(100); }
    int().pulseStructureGrid();
    const drawn = pool0 - rock.resources!;
    expect(drawn, 'the mining lasers hit the rock').toBeGreaterThan(0);
    expect(getHoldStore().get(shipId)?.hold.goods.minerals ?? 0).toBe(drawn);
  });
});
