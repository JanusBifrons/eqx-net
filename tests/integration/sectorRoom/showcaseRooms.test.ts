/**
 * Showcase capture rooms (src/server/rooms/showcaseRooms.ts) stage what the
 * showcase video's shot list claims, and the `initialXp` bespoke trigger turns
 * a single kill into a level-up. Boots the EXACT options `index.ts` registers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { getDroneMaxHealth } from '../../../src/server/rooms/droneKindHelpers.js';
import { xpForKill, xpToNext } from '../../../src/core/leveling/shipXp.js';
import {
  SHOWCASE_BASE_OPTS,
  SHOWCASE_DEFENCE_OPTS,
  SHOWCASE_PILOT_ID,
  SHOWCASE_LEVELUP_OPTS,
  SHOWCASE_SHIP_GALLERY_OPTS,
} from '../../../src/server/rooms/showcaseRooms.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** Deep-mutable copy — the harness takes plain (non-readonly) option objects. */
function opts<T>(o: T): Record<string, unknown> {
  return structuredClone(o) as unknown as Record<string, unknown>;
}

describe('Showcase rooms', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('ship gallery seeds the six player ship kinds', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_SHIP_GALLERY_OPTS));
    const cr = await harness.connectAs('gallery-viewer');
    const internals = roomOf(cr.roomId)._internals;
    const kinds = [...internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.shipKind).sort();
    expect(kinds).toEqual(['fighter', 'gunship', 'heavy', 'interceptor', 'missile-frigate', 'scout']);
  });

  it('showcase base is owned by the showcase pilot, built and powered', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_BASE_OPTS));
    const cr = await harness.connectAs('base-viewer');
    const internals = roomOf(cr.roomId)._internals;
    const structures = [...internals.structureRegistry.all()];
    expect(structures.length).toBe(SHOWCASE_BASE_OPTS.prebuiltStructures.length);
    for (const s of structures) {
      expect(s.isConstructed).toBe(true);
      expect(s.owner).toBe(SHOWCASE_PILOT_ID);
    }
    internals.pulseStructureGrid();
    for (const s of internals.getStructuresSlice() ?? []) expect(s.powered).toBe(true);
  });

  it('defence base is built, powered, raises a shield wall and fields a drone pack', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_DEFENCE_OPTS));
    const cr = await harness.connectAs('defender');
    const internals = roomOf(cr.roomId)._internals;

    const structures = [...internals.structureRegistry.all()];
    expect(structures.length).toBe(SHOWCASE_DEFENCE_OPTS.prebuiltStructures.length);
    for (const s of structures) expect(s.isConstructed).toBe(true);

    internals.pulseStructureGrid();
    const slice = internals.getStructuresSlice() ?? [];
    // Every structure is on ONE powered grid (no stranded leaf).
    expect(slice.length).toBe(structures.length);
    for (const s of slice) expect(s.powered).toBe(true);
    // The two pylons project an ACTIVE wall between them.
    const walls = slice.filter((s) => s.shieldWallTo !== undefined);
    expect(walls.length).toBeGreaterThan(0);
    expect(walls.every((w) => w.wallActive === true)).toBe(true);

    const drones = [...internals.swarmRegistry.all()].filter((r) => r.kind === 1);
    expect(drones.length).toBe(SHOWCASE_DEFENCE_OPTS.dronePoses.length);
  });

  it('initialXp + one kill levels the ship up', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_LEVELUP_OPTS));
    const killer = randomUUID();
    const gain = xpForKill(getDroneMaxHealth('heavy')!);
    const initialXp = xpToNext(1) - gain; // one heavy kill crosses the threshold
    const cr = await harness.connectActive(killer, { shipKind: 'interceptor', initialXp });
    const room = roomOf(cr.roomId);
    const state = (room as unknown as { state: SectorState }).state;
    let instanceId = '';
    for (const [id, ship] of state.ships) if (ship.playerId === killer && ship.isActive) instanceId = id;
    expect(instanceId).not.toBe('');
    expect(getPlayerShipStore().get(instanceId)!.xp).toBe(initialXp);
    expect(getPlayerShipStore().get(instanceId)!.level).toBe(1);

    const target = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    room._internals.applyDamage(target.id, killer, 99_999);

    expect(getPlayerShipStore().get(instanceId)!.level).toBe(2);
    expect(state.ships.get(instanceId)!.level).toBe(2);
  });
});
