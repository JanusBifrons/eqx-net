/**
 * Living World P5 (plan peppy-jumping-pinwheel) — BLUEPRINTS through a real
 * SectorRoom and the real `install_blueprint` / `activate_mount` messages.
 *
 *  1. installing moves the blueprint from the pilot's storage onto their ACTIVE
 *     ship in one move (storage loses it, the `fitted:<ship>` hold gains it) —
 *     and the client sees it on its own snapshot slice (#16);
 *  2. effects: Reinforced Hull raises max hull ×1.25 at once; the Missile Rack
 *     gates `activate_mount` heat-seeker (refused before, accepted after);
 *  3. refusals: a duplicate on the same ship, a blueprint the storage lacks,
 *     a ship parked too far from the storage;
 *  4. the ship's death destroys its fitted blueprints.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getHoldStore, getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { fittedUid, type BlueprintResult } from '../../../src/shared-types/blueprints.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('SectorRoom integration — blueprints (P5)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('installs from storage onto the active ship, applies the effects, and is lost on death', { timeout: 60_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');

    const results: BlueprintResult[] = [];
    cr.onMessage('blueprint_result', (m: BlueprintResult) => results.push(m));
    let ownFitted: string[] | undefined;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const s of Object.values(snap.states ?? {})) if (s.playerId === pid && s.fitted !== undefined) ownFitted = s.fitted;
    });
    const install = async (entityId: number, blueprintId: string): Promise<BlueprintResult> => {
      const n = results.length;
      cr.send('install_blueprint', { networkEntityId: entityId, blueprintId });
      expect(await until(() => results.length > n, 4000)).toBe(true);
      return results[results.length - 1]!;
    };

    // A Capital 150 u away holding two blueprints.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    cap.hold = { goods: {}, credits: 0, blueprints: ['bp-reinforced-hull', 'bp-missile-rack'] };
    const capEid = internal.swarmRegistry.get(cap.id)!.entityId;

    // A blueprint the storage doesn't have is refused.
    expect((await install(capEid, 'bp-cargo-expander')).ok).toBe(false);

    // Reinforced Hull: storage loses it, the ship gains it, max hull ×1.25 now.
    const base = getShipKind('fighter').maxHealth;
    expect(state.ships.get(shipId)!.maxHealth).toBe(base);
    const ok = await install(capEid, 'bp-reinforced-hull');
    expect(ok.ok, ok.message).toBe(true);
    expect(cap.hold!.blueprints).toEqual(['bp-missile-rack']);
    expect(getHoldStore().get(fittedUid(shipId))?.hold.blueprints).toEqual(['bp-reinforced-hull']);
    expect(state.ships.get(shipId)!.maxHealth).toBe(Math.round(base * 1.25));
    expect(await until(() => ownFitted?.includes('bp-reinforced-hull') === true, 4000)).toBe(true);
    // Not twice on the same ship.
    cap.hold!.blueprints.push('bp-reinforced-hull');
    expect((await install(capEid, 'bp-reinforced-hull')).ok).toBe(false);

    // The Missile Rack gates heat-seekers on a latent mount.
    cr.send('activate_mount', { type: 'activate_mount', shipId, slotId: 'latent-wing-l', weaponId: 'heat-seeker' });
    await new Promise((res) => setTimeout(res, 400));
    expect(getPlayerShipStore().get(shipId)!.mounts).toEqual([]);
    expect((await install(capEid, 'bp-missile-rack')).ok).toBe(true);
    cr.send('activate_mount', { type: 'activate_mount', shipId, slotId: 'latent-wing-l', weaponId: 'heat-seeker' });
    expect(await until(() => getPlayerShipStore().get(shipId)!.mounts.length === 1, 4000)).toBe(true);

    // Too far from the storage ⇒ refused (move the Capital away).
    cap.x = 5000;
    expect((await install(capEid, 'bp-reinforced-hull')).ok).toBe(false);

    // Death destroys the fitted blueprints with the ship.
    r.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: pid, shooterId: 'swarm-1' });
    expect(getHoldStore().get(fittedUid(shipId))).toBeUndefined();
  });
});
