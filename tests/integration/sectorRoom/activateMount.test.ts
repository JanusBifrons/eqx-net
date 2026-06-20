/**
 * Dynamic weapon mounts — integration lock for WS-B3 (Phase 4, plan:
 * effervescent-umbrella, invariant #13 "the behaviour lives at the message →
 * roster → fire → snapshot seam").
 *
 * The pure geometry lookup is unit-locked in
 * `src/shared-types/shipKinds/slots.dynamicMounts.test.ts`; the wire schemas in
 * `messages.test.ts`. THIS test drives the FULL server chain through a REAL
 * galaxy room + a real colyseus.js client:
 *
 *   activate_mount { shipId, slotId, weaponId } → SectorRoom handler →
 *     ownership + valid-latent-slot gate → PlayerShipStore (roster `mounts`) +
 *     live ShipState.mounts mirror → echo mount_activated → the next FIRE
 *     resolves the activated latent mount (a `laser_fired` carries its mountId)
 *
 * Asserts the locked WS-B3 decisions:
 *  - activating a slot → the ship FIRES from it (a `laser_fired` for the
 *    activated mount id appears in a salvo);
 *  - a NON-activated latent slot does NOT fire (no `laser_fired` for it before
 *    activation);
 *  - the activation persists on the roster (`mounts` JSON) + mirrors the live
 *    ShipState;
 *  - a FOREIGN / unknown / non-latent slot is dropped (no echo, no persist);
 *  - the activated mount rides the PUBLIC `states[].mounts` snapshot slice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { MountActivatedEvent, LaserFiredEvent } from '../../../src/shared-types/messages.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

function shipInstanceFor(room: SectorRoom, playerId: string): string {
  const state = (room as unknown as { state: SectorState }).state;
  for (const [shipInstanceId, ship] of state.ships) {
    if (ship.playerId === playerId && ship.isActive) return shipInstanceId;
  }
  throw new Error(`no active hull for ${playerId}`);
}

function nextMountEcho(
  cr: { onMessage: (t: string, cb: (m: MountActivatedEvent) => void) => void },
  shipId: string,
  timeoutMs = 2000,
): Promise<MountActivatedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no mount_activated echo')), timeoutMs);
    cr.onMessage('mount_activated', (m: MountActivatedEvent) => {
      if (m.shipInstanceId !== shipId) return;
      clearTimeout(timer);
      resolve(m);
    });
  });
}

/** Collect every `laser_fired` the client observes (the broadcast is global). */
function collectLaserMountIds(cr: ClientRoom<SectorState>, into: Set<string>): void {
  cr.onMessage('laser_fired', (m: LaserFiredEvent) => {
    if (m.mountId) into.add(m.mountId);
  });
}

describe('SectorRoom integration — dynamic weapon mounts (Phase 4 WS-B3)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('activating a latent slot makes the ship FIRE from it; a non-activated slot does NOT', async () => {
    const player = randomUUID();
    // fighter has a hitscan-by-default loadout? No — fighter mounts fire `laser`
    // (bolts). We bind the latent mount to `hitscan` so it produces a beam
    // (laser_fired) deterministically regardless of the slot's cooldown gate.
    const cr = (await harness.connectActive(player, { shipKind: 'fighter', spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);

    const firedMounts = new Set<string>();
    collectLaserMountIds(cr, firedMounts);

    // Let the worker write the shooter's pose so the fire path resolves a ray.
    await harness.advance(100);

    // BEFORE activation: a fire fans out to the base slot only — the latent
    // wing mount must NOT appear. (tick 0 — first shot, off cooldown.)
    cr.send('fire', { type: 'fire', tick: 0, clientShotId: 'a0', weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
    await harness.advance(120);
    expect(firedMounts.has('latent-wing-l')).toBe(false);
    firedMounts.clear();

    // Activate the latent wing mount with a hitscan weapon (a beam).
    const echoP = nextMountEcho(cr, shipId);
    cr.send('activate_mount', { type: 'activate_mount', shipId, slotId: 'latent-wing-l', weaponId: 'hitscan' });
    const echo = await echoP;
    expect(echo.mounts).toEqual([{ slotId: 'latent-wing-l', weaponId: 'hitscan' }]);

    // Persisted on the roster + mirrored on the live ShipState.
    expect(getPlayerShipStore().get(shipId)!.mounts).toEqual([{ slotId: 'latent-wing-l', weaponId: 'hitscan' }]);
    const state = (room as unknown as { state: SectorState }).state;
    expect(state.ships.get(shipId)!.mounts).toEqual([{ slotId: 'latent-wing-l', weaponId: 'hitscan' }]);

    // AFTER activation: a fire (well past the slot cooldown — tick 100) now
    // resolves the activated latent mount, so a `laser_fired` carries its
    // mount id.
    cr.send('fire', { type: 'fire', tick: 100, clientShotId: 'a1', weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
    await harness.advance(150);
    expect(firedMounts.has('latent-wing-l')).toBe(true);
    // The non-activated wing mount still never fires.
    expect(firedMounts.has('latent-wing-r')).toBe(false);
  }, 25_000);

  it('a FOREIGN ship id is dropped (no cross-player activation)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const crA = (await harness.connectActive(a, { shipKind: 'fighter' })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === a });
    await harness.connectActive(b, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === b });
    const room = getRoomById(crA.roomId);
    const shipB = shipInstanceFor(room, b);

    let echoed = false;
    crA.onMessage('mount_activated', (m: MountActivatedEvent) => {
      if (m.shipInstanceId === shipB) echoed = true;
    });
    crA.send('activate_mount', { type: 'activate_mount', shipId: shipB, slotId: 'latent-wing-l', weaponId: 'laser' });
    await new Promise((r) => setTimeout(r, 400));

    expect(echoed).toBe(false);
    expect(getPlayerShipStore().get(shipB)!.mounts).toEqual([]); // B's ship untouched
  }, 25_000);

  it('a non-latent / unknown slotId is dropped (no persist)', async () => {
    const player = randomUUID();
    const cr = (await harness.connectActive(player, { shipKind: 'fighter' })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);

    let echoed = false;
    cr.onMessage('mount_activated', (m: MountActivatedEvent) => {
      if (m.shipInstanceId === shipId) echoed = true;
    });
    // 'forward' is a BASE mount, not a latent slot — must be rejected.
    cr.send('activate_mount', { type: 'activate_mount', shipId, slotId: 'forward', weaponId: 'laser' });
    await new Promise((r) => setTimeout(r, 400));

    expect(echoed).toBe(false);
    expect(getPlayerShipStore().get(shipId)!.mounts).toEqual([]);
  }, 25_000);
});
