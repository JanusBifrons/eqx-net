/**
 * structure-restyle 3h — a convoy hauler at a Freight Dock's bay is served by
 * the dock's crane, through the same bay dwell as a player ship
 * (`SectorRoom.craneServe` → `dockDwell`): settle → `arm-reach` at the hauler
 * → `arm-hold` (cargo direction on the clip) → the convoy's trade at hold END
 * (`job.atHoldEnd`, here the director's real `tradeTransfer` release) →
 * `arm-retract`. One ship per crane holds between pilots and haulers; a
 * hauler destroyed mid-hold aborts (retract, no trade). The director side
 * (bay target, the job, the atomic fallback) is unit-tested over fake rooms
 * (ConvoyDirector.test.ts).
 *
 * Dock at (0, 0), rot 0: its bay centre is world (0, 460).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { CONVOY_HAULER_ID_PREFIX } from '../../../src/server/livingworld/directorBotIds.js';
import { CRANE_CARGO_IN, CRANE_CARGO_OUT } from '../../../src/core/articulation/craneCargo.js';
import type { CraneHaulJob } from '../../../src/server/economy/ConvoyDirector.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

const CARGO = { goods: { alloy: 8 }, blueprints: [] };

describe('SectorRoom integration — convoy haulers at the crane bay (structure-restyle 3h)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function boot(pid: string): Promise<{ room: SectorRoom; dock: StructureRecord }> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'freight_dock', x: 0, y: 0 }],
      prebuiltStructuresOwner: pid,
    });
    await harness.connectAs(randomUUID()); // opens the room
    const room = harness.getServerRoom()!;
    const dock = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'freight_dock')!;
    return { room, dock };
  }

  /** A loaded convoy hauler parked at (x, y), held there. */
  async function hauler(room: SectorRoom, x: number, y: number): Promise<string> {
    const id = `${CONVOY_HAULER_ID_PREFIX}${randomUUID().slice(0, 8)}`;
    getHoldStore().put({ holderUid: id, holderType: 'hauler', ownerId: null, sectorKey: 'sol-prime', x: null, y: null, hold: structuredClone(CARGO), expiresAt: null }, false);
    expect(room.spawnLivingWorldBot({ botId: id, kind: 'trader-hauler', x, y })).toBe(true);
    room.setBotMoveTarget(id, x, y);
    await harness!.advance(100);
    return id;
  }

  /** The director's delivery job: release the hold into the dock at hold end. */
  function unloadJob(room: SectorRoom, dock: StructureRecord, id: string, log: string[]): CraneHaulJob {
    return {
      dockId: dock.id, owner: dock.owner, cargo: 'unload', weight: 8,
      atHoldEnd: () => {
        log.push(`trade:${dock.rigClip?.clipId}@${dock.rigClip?.startTick}`);
        room.tradeTransfer(dock.owner, dock.uid!, { release: [id] });
      },
    };
  }

  const clipOf = (dock: StructureRecord): string | undefined => dock.rigClip?.clipId;

  it('arrival draws the crane; the trade runs at the END of the hold, not on arrival', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { room, dock } = await boot(pid);
    const id = await hauler(room, 100, 470);
    const log: string[] = [];
    expect(room.craneServe(id, unloadJob(room, dock, id, log))).toBe('serving');

    expect(await until(() => clipOf(dock) === 'arm-reach', 6_000), 'a still hauler on the bay draws the crane').toBe(true);
    expect(Math.abs(dock.rigClip!.target!.x - 100)).toBeLessThan(40);
    expect(Math.abs(dock.rigClip!.target!.y - 470)).toBeLessThan(40);
    expect(await until(() => clipOf(dock) === 'arm-hold', 3_000)).toBe(true);
    expect(dock.rigClip!.cargo, 'delivery: goods go in').toBe(CRANE_CARGO_IN);
    const holdEnd = dock.rigClip!.startTick + dock.rigClip!.holdTicks!;
    expect(log, 'no trade on arrival or at the reach').toEqual([]);
    expect(getHoldStore().get(id)?.hold.goods).toEqual(CARGO.goods);

    expect(await until(() => log.length > 0, 12_000)).toBe(true);
    // The trade runs in the tick the hold ends, as the retract starts.
    expect(log, 'one trade, run as the hold ends').toEqual([`trade:arm-retract@${dock.rigClip!.startTick}`]);
    expect(dock.rigClip!.startTick).toBeGreaterThanOrEqual(holdEnd);
    expect(dock.rigClip!.startTick - holdEnd, 'within one deposit pass (6 ticks)').toBeLessThanOrEqual(6);
    expect(clipOf(dock)).toBe('arm-retract');
    expect(getHoldStore().get(id), 'the hold was released into the dock').toBeUndefined();
    expect(dock.hold?.goods).toEqual(CARGO.goods);
    // The job is spent: the crane stays home.
    await harness!.advance(2_500);
    expect(clipOf(dock)).toBe('arm-retract');
    expect(log).toHaveLength(1);
  });

  it('a pickup job loads (cargo out); a dock not the base owner\'s, or a load of nothing, is refused', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const { room, dock } = await boot(pid);
    const id = await hauler(room, 0, 460);
    const noop = (): void => {};
    expect(room.craneServe(id, { dockId: dock.id, owner: 'npc:traders:other', cargo: 'load', weight: 5, atHoldEnd: noop })).toBe('none');
    expect(room.craneServe(id, { dockId: dock.id, owner: dock.owner, cargo: 'load', weight: 0, atHoldEnd: noop })).toBe('none');
    expect(room.craneServe(id, { dockId: 'nope', owner: dock.owner, cargo: 'load', weight: 5, atHoldEnd: noop })).toBe('none');
    expect(room.craneServe(id, { dockId: dock.id, owner: dock.owner, cargo: 'load', weight: 5, atHoldEnd: noop })).toBe('serving');
    expect(await until(() => clipOf(dock) === 'arm-hold', 6_000)).toBe(true);
    expect(dock.rigClip!.cargo, 'pickup: goods come out').toBe(CRANE_CARGO_OUT);
  });

  it('one ship per crane: a hauler waits while a pilot is served, then is served', { timeout: 50_000 }, async () => {
    const pid = randomUUID();
    const { room, dock } = await boot(pid);
    const cr = await harness!.connectActive(pid, { spawnX: 200, spawnY: 470, initialCargo: { goods: { salvage: 4 }, blueprints: [] } });
    void cr;
    expect(await until(() => clipOf(dock) === 'arm-reach', 6_000), 'the pilot is served first').toBe(true);
    const pilotTarget = { ...dock.rigClip!.target! };
    expect(pilotTarget.x).toBeGreaterThan(100);

    const id = await hauler(room, -250, 560);
    const log: string[] = [];
    room.craneServe(id, unloadJob(room, dock, id, log));
    await harness!.advance(2_000);
    expect(dock.rigClip!.target!.x, 'the hauler does not take the arm').toBe(pilotTarget.x);
    expect(log).toEqual([]);

    // The pilot's cycle ends; once the arm is home the hauler is next.
    expect(await until(() => clipOf(dock) === 'arm-reach' && dock.rigClip!.target!.x < -100, 15_000), 'then the crane reaches for the hauler').toBe(true);
    expect(await until(() => log.length > 0, 12_000)).toBe(true);
    expect(dock.hold?.goods).toEqual({ salvage: 4, alloy: 8 });
  });

  it('one ship per crane, the other way: a pilot waits while a hauler is served', { timeout: 50_000 }, async () => {
    const pid = randomUUID();
    const { room, dock } = await boot(pid);
    const id = await hauler(room, -250, 560);
    const log: string[] = [];
    room.craneServe(id, unloadJob(room, dock, id, log));
    expect(await until(() => clipOf(dock) === 'arm-reach', 6_000)).toBe(true);
    await harness!.connectActive(pid, { spawnX: 200, spawnY: 470, initialCargo: { goods: { salvage: 4 }, blueprints: [] } });
    await harness!.advance(1_500);
    expect(dock.rigClip!.target!.x, 'the pilot does not take the arm').toBeLessThan(-100);
    expect(await until(() => log.length > 0, 12_000)).toBe(true);
    expect(await until(() => clipOf(dock) === 'arm-reach' && dock.rigClip!.target!.x > 100, 6_000), 'then the pilot is served').toBe(true);
  });

  it('a hauler destroyed mid-hold aborts: the arm retracts, no trade', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { room, dock } = await boot(pid);
    const id = await hauler(room, 0, 460);
    const log: string[] = [];
    room.craneServe(id, unloadJob(room, dock, id, log));
    expect(await until(() => clipOf(dock) === 'arm-hold', 6_000)).toBe(true);
    room.despawnLivingWorldBot(id);
    expect(await until(() => clipOf(dock) === 'arm-retract', 2_000), 'the arm retracts').toBe(true);
    await harness!.advance(4_000);
    expect(log, 'no trade').toEqual([]);
    expect(dock.hold === undefined || Object.keys(dock.hold.goods).length === 0).toBe(true);
  });
});
