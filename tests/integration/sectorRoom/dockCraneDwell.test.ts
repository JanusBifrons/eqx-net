/**
 * structure-restyle 3b — "stop = go": a ship parked still on its own freight
 * dock's bay is served by the dock's crane. Settle → `arm-reach` at the ship
 * → `arm-hold` for the load-scaled hold → bank at hold END → `arm-retract`.
 * Moving / leaving during reach or hold aborts (retract, nothing banked); one
 * ship per crane; the dock's import orders filter what it takes (no orders at
 * all ⇒ everything; export-only ⇒ nothing); the bay beats a nearer Capital.
 * The hover deposit (Cargo Bay only, 3f) is locked by `capitalCraneBay.test.ts`.
 *
 * Dock at (0, 0), rot 0: its bay centre is world (0, 460) (`DOCK_BAY_CY`).
 * Real game rules, real time: one cycle ≈ 0.75 s settle + 1 s reach + 3 s
 * hold (light load) + 1 s retract.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { DEPOSIT_WAITING } from '../../../src/shared-types/messages/snapshotMessages.js';
import { decodeRigHoldTicks } from '../../../src/shared-types/structureStateWire.js';
import { CRANE_CARGO_IN } from '../../../src/core/articulation/craneCargo.js';
import { DOCK_UNLOAD_HOLD_MIN_TICKS } from '../../../src/core/articulation/rigCatalogue.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

const CARGO = { goods: { salvage: 6, alloy: 3 }, blueprints: [] };

describe('SectorRoom integration — dock crane dwell (structure-restyle 3b)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  /** Boot with the dock (+ extras) owned by `pid`, then fly `pid` in at (x, y)
   *  carrying `CARGO`. `before` runs on the dock before the pilot activates. */
  async function boot(
    pid: string, x: number, y: number,
    opts: { extra?: Array<{ kind: string; x: number; y: number }>; before?: (room: SectorRoom, dock: StructureRecord) => void } = {},
  ): Promise<{ room: SectorRoom; dock: StructureRecord; cr: Room<SectorState>; shipId: string }> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'freight_dock', x: 0, y: 0 }, ...(opts.extra ?? [])],
      prebuiltStructuresOwner: pid,
    });
    // A bystander seat opens the room so the dock can be staged first.
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const dock = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'freight_dock')!;
    opts.before?.(room, dock);
    const cr = await harness.connectActive(pid, { spawnX: x, spawnY: y, initialCargo: CARGO });
    expect(await until(() => shipIdOf(cr, pid) !== '', 3_000)).toBe(true);
    const shipId = shipIdOf(cr, pid);
    expect(aboard(shipId), 'the cargo is aboard at the start').toEqual(CARGO.goods);
    return { room, dock, cr, shipId };
  }

  function shipIdOf(cr: Room<SectorState>, pid: string): string {
    for (const [, s] of cr.state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  }

  const clipOf = (dock: StructureRecord): string | undefined => dock.rigClip?.clipId;
  const aboard = (shipId: string): Record<string, number> => ({ ...(getHoldStore().get(shipId)?.hold.goods ?? {}) });

  it('park + still → reach at the ship → hold → bank at hold end → retract (no orders = takes everything)', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId } = await boot(pid, 120, 480);

    expect(await until(() => clipOf(dock) === 'arm-reach', 5_000), 'a still ship on the bay draws the crane').toBe(true);
    const t = dock.rigClip!.target!;
    expect(Math.abs(t.x - 120)).toBeLessThan(30);
    expect(Math.abs(t.y - 480)).toBeLessThan(30);

    expect(await until(() => clipOf(dock) === 'arm-hold', 3_000)).toBe(true);
    expect(aboard(shipId), 'nothing is banked before the hold ends').toEqual(CARGO.goods);

    expect(await until(() => clipOf(dock) === 'arm-retract', 12_000)).toBe(true);
    expect(getHoldStore().get(shipId), 'a dock with no orders takes the whole hold').toBeUndefined();
    expect(dock.hold?.goods).toEqual(CARGO.goods);
  });

  it('a moving ship on the bay draws no crane', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const { dock, cr, shipId } = await boot(pid, 0, 600);
    harness!.sendThrust(cr); // held: the ship never comes to rest
    await harness!.advance(2_500);
    expect(clipOf(dock)).toBeUndefined();
    expect(aboard(shipId)).toEqual(CARGO.goods);
  });

  it('leaving mid-hold aborts: the arm retracts and nothing is banked', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, cr, shipId } = await boot(pid, 0, 460);
    expect(await until(() => clipOf(dock) === 'arm-hold', 6_000)).toBe(true);
    harness!.sendThrust(cr);
    expect(await until(() => clipOf(dock) === 'arm-retract', 3_000), 'moving off aborts the hold').toBe(true);
    await harness!.advance(4_000);
    expect(aboard(shipId), 'an aborted unload banks nothing').toEqual(CARGO.goods);
    expect(dock.hold === undefined || Object.keys(dock.hold.goods).length === 0).toBe(true);
  });

  it('one ship per crane: a parked ship waits while the arm is out, then is served', { timeout: 40_000 }, async () => {
    // Docks serve only their owner's ships, and a pilot flies one hull, so the
    // other claimant is staged as the arm already holding at the pad's far
    // corner (what another ship's cycle leaves on the dock record).
    const pid = randomUUID();
    let staged = false;
    const { room, dock, shipId } = await boot(pid, 150, 460, {
      before: (r, d) => { staged = r.startStructureRigClip(d.id, 'arm-hold', { x: -300, y: 600 }); },
    });
    expect(staged).toBe(true);
    const busyStart = dock.rigClip!.startTick;
    await harness!.advance(2_000);
    expect(dock.rigClip!.clipId, 'the waiting ship does not take the arm').toBe('arm-hold');
    expect(dock.rigClip!.startTick).toBe(busyStart);
    expect(aboard(shipId)).toEqual(CARGO.goods);
    // The other ship's cycle ends; once the arm is home the waiting ship is next.
    room.startStructureRigClip(dock.id, 'arm-retract', { x: -300, y: 600 });
    expect(await until(() => clipOf(dock) === 'arm-reach', 4_000)).toBe(true);
    expect(Math.abs(dock.rigClip!.target!.x - 150)).toBeLessThan(30);
  });

  it('3e: the waiting ship reads "waiting" (not a stuck 0 %), then is served with a timed cargo hold', { timeout: 40_000 }, async () => {
    // Same staging as above: another ship's cycle holds the arm.
    const pid = randomUUID();
    const { room, dock, cr, shipId } = await boot(pid, 150, 460, {
      before: (r, d) => { r.startStructureRigClip(d.id, 'arm-hold', { x: -300, y: 600 }); },
    });
    // The own-ship `depositing` readout, as the client receives it.
    const seen: Array<number | undefined> = [];
    cr.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; depositing?: number }> }) => {
      for (const k in snap.states ?? {}) {
        const s = snap.states![k]!;
        if (s.playerId === pid) seen.push(s.depositing);
      }
    });
    expect(await until(() => seen.includes(DEPOSIT_WAITING), 4_000), 'a parked ship on a busy dock reads waiting').toBe(true);
    expect(seen.some((v) => v !== undefined && v > 0), 'no progress while waiting').toBe(false);
    expect(aboard(shipId)).toEqual(CARGO.goods);

    // The other ship's cycle ends: this ship is next, its readout counts up.
    room.startStructureRigClip(dock.id, 'arm-retract', { x: -300, y: 600 });
    expect(await until(() => clipOf(dock) === 'arm-hold' && dock.rigClip!.startTick > 0 && dock.rigClip!.holdTicks !== undefined, 6_000)).toBe(true);
    // The hold length and the cargo direction ride the clip (wire `rigHold`).
    expect(dock.rigClip!.holdTicks).toBeGreaterThanOrEqual(DOCK_UNLOAD_HOLD_MIN_TICKS);
    expect(dock.rigClip!.cargo, 'a dock with no orders only unloads').toBe(CRANE_CARGO_IN);
    // The server writes the row when the hold starts; the client sees it at
    // the next state patch, so wait for that patch rather than read at once.
    const holdRow = () => [...cr.state.structures.values()].find((s) => decodeRigHoldTicks(s.rigHold ?? 0) > 0);
    expect(await until(() => holdRow() !== undefined, 1_000), 'the client row carries the hold').toBe(true);
    const st = holdRow();
    expect(decodeRigHoldTicks(st!.rigHold!)).toBe(dock.rigClip!.holdTicks);
    const last = seen[seen.length - 1];
    expect(last !== undefined && last >= 0, 'served: the readout is progress again').toBe(true);
    expect(await until(() => clipOf(dock) === 'arm-retract', 12_000)).toBe(true);
    expect(getHoldStore().get(shipId), 'served after the first ship').toBeUndefined();
  });

  it('an export-only dock (an outlet) takes nothing and draws no crane', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId } = await boot(pid, 0, 460, {
      before: (_r, d) => { d.freightOrders = [{ good: 'alloy', mode: 'export', level: 5 }]; },
    });
    await harness!.advance(3_000);
    expect(clipOf(dock)).toBeUndefined();
    expect(aboard(shipId)).toEqual(CARGO.goods);
  });

  it('import orders filter the unload; the bay beats a nearer Capital', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    // Capital beside the pad: 380 u from the parked ship (inside its 400 u
    // deposit range), far nearer than the dock's centre.
    const { room, dock, shipId } = await boot(pid, 400, 500, {
      extra: [{ kind: 'capital', x: 780, y: 520 }],
      before: (_r, d) => { d.freightOrders = [{ good: 'alloy', mode: 'import', level: 50 }]; },
    });
    const cap = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    expect(await until(() => clipOf(dock) === 'arm-retract', 12_000)).toBe(true);
    expect(dock.hold?.goods).toEqual({ alloy: 3 });
    expect(aboard(shipId), 'goods the dock does not import stay aboard').toEqual({ salvage: 6 });
    expect(cap.hold === undefined || Object.keys(cap.hold.goods).length === 0, 'the Capital never got it').toBe(true);
  });
});
