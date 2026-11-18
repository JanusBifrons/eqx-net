/**
 * structure-restyle 3i — the Capital's built-in crane bay ("first load
 * home"). The same dock crane cycle as a freight dock (`dockCraneDwell`):
 * park still on the bay → `arm-reach` → `arm-hold` → bank at hold END →
 * `arm-retract`; one ship per crane. The Capital has no import list (it
 * takes everything) and no outlet (it loads nothing). Off the bay the old
 * 400 u hover deposit still works (retired later, slice 3f).
 *
 * Capital at (0, 0), rot 0: its bay is `CAPITAL.keepClear`, 500 × 240 past
 * its +y edge, centre world (0, 410) (`CAPITAL_BAY`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { CRANE_CARGO_IN } from '../../../src/core/articulation/craneCargo.js';
import { CAPITAL_BAY, DOCK_UNLOAD_HOLD_MIN_TICKS } from '../../../src/core/articulation/rigCatalogue.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

const CARGO = { goods: { salvage: 6, alloy: 3 }, blueprints: [] };

describe('SectorRoom integration — Capital crane bay (structure-restyle 3i)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function boot(
    pid: string, x: number, y: number,
    opts: { before?: (room: SectorRoom, cap: StructureRecord) => void } = {},
  ): Promise<{ room: SectorRoom; cap: StructureRecord; cr: Room<SectorState>; shipId: string }> {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    // Ship first, then the Capital placed around it: a join never spawns
    // within a hull's clearance of a structure, and the bay is closer than that.
    const cr = await harness.connectActive(pid, { spawnX: x, spawnY: y, initialCargo: CARGO });
    expect(await until(() => shipIdOf(cr, pid) !== '', 3_000)).toBe(true);
    const shipId = shipIdOf(cr, pid);
    expect(aboard(shipId)).toEqual(CARGO.goods);
    const room = harness.getServerRoom()!;
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 0 });
    expect(await until(() => [...room._internals.structureRegistry.all()].some((r) => r.owner === pid && r.kind === 'capital'), 5_000)).toBe(true);
    const cap = [...room._internals.structureRegistry.all()].find((r) => r.owner === pid && r.kind === 'capital')!;
    expect(cap.isConstructed, 'a Capital is pre-built').toBe(true);
    opts.before?.(room, cap);
    return { room, cap, cr, shipId };
  }

  function shipIdOf(cr: Room<SectorState>, pid: string): string {
    for (const [, s] of cr.state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  }
  const clipOf = (r: StructureRecord): string | undefined => r.rigClip?.clipId;
  const aboard = (shipId: string): Record<string, number> => ({ ...(getHoldStore().get(shipId)?.hold.goods ?? {}) });

  it('the bay centre is world (0, 410), past the +y edge', () => {
    expect([CAPITAL_BAY.cx, CAPITAL_BAY.cy]).toEqual([0, 410]);
  });

  it('park + still on the bay → reach → hold → bank everything at hold end → retract', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    // 100 right of the bay centre: 422 from the Capital's centre, out of hover range.
    const { cap, shipId } = await boot(pid, 100, 420);

    expect(await until(() => clipOf(cap) === 'arm-reach', 5_000), 'a still ship on the bay draws the crane').toBe(true);
    const t = cap.rigClip!.target!;
    expect(Math.abs(t.x - 100)).toBeLessThan(30);
    expect(Math.abs(t.y - 420)).toBeLessThan(30);

    expect(await until(() => clipOf(cap) === 'arm-hold', 3_000)).toBe(true);
    expect(cap.rigClip!.holdTicks).toBeGreaterThanOrEqual(DOCK_UNLOAD_HOLD_MIN_TICKS);
    expect(cap.rigClip!.cargo, 'the Capital only unloads (no outlet)').toBe(CRANE_CARGO_IN);
    expect(aboard(shipId), 'nothing is banked before the hold ends').toEqual(CARGO.goods);

    expect(await until(() => clipOf(cap) === 'arm-retract', 12_000)).toBe(true);
    expect(getHoldStore().get(shipId), 'home takes the whole hold').toBeUndefined();
    expect(cap.hold?.goods).toEqual(CARGO.goods);
  });

  it('one ship per crane: a parked ship waits while the arm is out, then is served', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { room, cap, shipId } = await boot(pid, -120, 420, {
      before: (r, c) => { r.startStructureRigClip(c.id, 'arm-hold', { x: 150, y: 480 }); },
    });
    const busyStart = cap.rigClip!.startTick;
    await harness!.advance(2_000);
    expect(cap.rigClip!.clipId, 'the waiting ship does not take the arm').toBe('arm-hold');
    expect(cap.rigClip!.startTick).toBe(busyStart);
    expect(aboard(shipId)).toEqual(CARGO.goods);
    room.startStructureRigClip(cap.id, 'arm-retract', { x: 150, y: 480 });
    expect(await until(() => clipOf(cap) === 'arm-reach', 4_000)).toBe(true);
    expect(Math.abs(cap.rigClip!.target!.x + 120)).toBeLessThan(30);
  });

  it('off the bay the 400 u hover deposit still works (no crane)', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    // Beside the Capital (-x side), inside 400 u of its centre, nowhere near the bay.
    const { cap, shipId } = await boot(pid, -340, 0);
    expect(await until(() => getHoldStore().get(shipId) === undefined, 6_000), 'hover deposit banks the hold').toBe(true);
    expect(clipOf(cap)).toBeUndefined();
    expect(cap.hold?.goods).toEqual(CARGO.goods);
  });
});
