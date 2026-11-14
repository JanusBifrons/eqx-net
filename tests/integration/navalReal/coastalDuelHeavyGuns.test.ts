/**
 * The `coastal-duel` showcase room exactly as filmed (pilot by the battery),
 * at real naval ranges: the battleship's 16" turrets engage the battery.
 *
 * Reported 2026-11-14 (#607 notes): every battleship turret, the 16" mains
 * included, trained on the pilot's FIGHTER by the battery for the whole run
 * and never engaged the battery.
 *
 * Root cause, measured here (`droneMountTargetIds` each second): at the first
 * turret search after `test_aggro` the battery is not yet in the room's
 * hostile-structure set (it joins ~5 s later), so the pilot is the only
 * candidate and every turret in reach takes it. A capital turret is STICKY: it
 * searched again only once it had no target, and the fighter never stopped
 * being engageable, so the battery (now the preferred class) was never
 * considered. The fix: a turret holding a target still re-searches on its
 * RETARGET_TICKS beat and switches only to a strictly preferred class
 * (`mountPriority`), so equal-class targets stay sticky.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from '../sectorRoom/harness.js';
import { SHOWCASE_COASTAL_DUEL_OPTS, SHOWCASE_PILOT_ID } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { NAVAL_RANGE } from '../../../src/shared-types/combat/navalRange.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

describe.runIf(NAVAL_RANGE === 'real')('coastal duel at real ranges — the 16" guns engage the battery', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('no 16" turret stays on the pilot\'s fighter; they train on the battery', { timeout: 60_000 }, async () => {
    const opts = structuredClone(SHOWCASE_COASTAL_DUEL_OPTS) as unknown as Record<string, unknown>;
    harness = await bootSectorTestServer(opts as Parameters<typeof bootSectorTestServer>[0]);
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID, { shipKind: 'fighter', initialHull: 1_000_000, noselfdmg: 1 });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const internal = room._internals;
    for (let i = 0; i < 5; i++) internal.pulseStructureGrid();
    const bs = [...internal.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(bs, 'the room has a battleship').toBeDefined();
    const mounts = getShipKind('battleship').mounts!;
    const xl = mounts.map((m, i) => (m.size === 'XL' ? i : -1)).filter((i) => i >= 0);
    const structIds = new Set([...internal.structureRegistry.all()].map((r) => r.id));
    const ticker = (room as unknown as { mountTicker: { droneMountTargetIds: Map<string, (string | null)[]> } }).mountTicker;
    const xlTargets = (): (string | null)[] => xl.map((i) => (ticker.droneMountTargetIds.get(bs.id) ?? [])[i] ?? null);

    cr.send('test_aggro', { type: 'test_aggro' });
    const onBattery = (): number => xlTargets().filter((t) => t !== null && structIds.has(t)).length;
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && onBattery() < xl.length) await new Promise((r) => setTimeout(r, 200));

    const final = xlTargets();
    expect(final.filter((t) => t === SHOWCASE_PILOT_ID), `16" turrets on the fighter: ${final.join(', ')}`).toEqual([]);
    expect(onBattery(), `16" turrets on the battery: ${final.join(', ')}`).toBe(xl.length);
  });
});
