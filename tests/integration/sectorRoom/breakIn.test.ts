/**
 * C2 (plan soft-leaping-truffle v3) — breaking into another player's cargo,
 * over the real `break_in` message, with the `breakInMs` bespoke trigger.
 *
 *  1. Undefended: the owner is alerted, the structure shows BREACH in room
 *     state while it lasts, and on success the cargo opens to the thief.
 *  2. Defended: starting is a HOSTILE ACT — the owner's turret engages the
 *     thief, and the hit interrupts the break-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { BreakInNotice, CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import { STRUCTURE_FLAG_BREACH } from '../../../src/shared-types/structureStateWire.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

function ask(cr: Room, replies: CargoState[], type: 'cargo_query' | 'cargo_move', body: object): Promise<CargoState> {
  const n = replies.length;
  cr.send(type, { type, ...body });
  return until(() => replies.length > n, 4000).then(() => replies[replies.length - 1]!);
}

describe('SectorRoom integration — break-ins (C2)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('undefended: alarm + BREACH while it lasts, then the cargo opens to the thief', { timeout: 40_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], breakInMs: 600,
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }], prebuiltStructuresOwner: owner,
    });
    const crOwner = await harness.connectActive(owner, { spawnX: 0, spawnY: -3000 });
    const alarms: BreakInNotice[] = [];
    crOwner.onMessage('break_in_notice', (m: BreakInNotice) => alarms.push(m));
    const thief = randomUUID();
    const cr = await harness.connectActive(thief, { spawnX: 0, spawnY: 450 });
    const thiefNotices: BreakInNotice[] = [];
    cr.onMessage('break_in_notice', (m: BreakInNotice) => thiefNotices.push(m));
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));

    const internal = harness.getServerRoom()!._internals;
    const cap = [...internal.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    cap.hold = { goods: { alloy: 10 }, blueprints: [] };
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;

    const locked = await ask(cr, replies, 'cargo_query', { entityId });
    expect(locked.open).toBe(false);
    expect(locked.breakIn).toEqual({ pct: null, durationMs: 600 });

    cr.send('break_in', { type: 'break_in', entityId });
    expect(await until(() => alarms.length > 0, 3_000), 'the owner is alerted').toBe(true);
    expect(alarms[0]!.message).toMatch(/breaking into your Capital/);
    const flagsOf = (): number => (crOwner.state as unknown as SectorState).structures.get(String(entityId))?.flags ?? 0;
    expect(await until(() => (flagsOf() & STRUCTURE_FLAG_BREACH) !== 0, 3_000), 'BREACH rides room state').toBe(true);

    expect(await until(() => thiefNotices.some((n) => n.tone === 'good'), 5_000), 'the break-in succeeds').toBe(true);
    expect(await until(() => (flagsOf() & STRUCTURE_FLAG_BREACH) === 0, 3_000)).toBe(true);
    const open = await ask(cr, replies, 'cargo_query', { entityId });
    expect(open.open, open.message).toBe(true);
    const took = await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { alloy: 4 } } });
    expect(took.ok, took.message).toBe(true);
    let shipId = '';
    for (const [, s] of (harness.getServerRoom()!.state as SectorState).ships) if (s.playerId === thief && s.isActive) shipId = s.shipInstanceId;
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(4);
  });

  it('defended: the owner turret engages the thief, and the hit interrupts the break-in', { timeout: 40_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], breakInMs: 20_000,
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 }, { kind: 'connector', x: 400, y: 0 },
        { kind: 'solar', x: 900, y: 0 }, { kind: 'turret', x: 400, y: 140 },
      ],
      prebuiltStructuresOwner: owner,
    });
    await harness.connectActive(owner, { spawnX: 0, spawnY: -3000 });
    const thief = randomUUID();
    const cr = await harness.connectActive(thief, { spawnX: 0, spawnY: 450, initialHull: 5000 });
    const notices: BreakInNotice[] = [];
    cr.onMessage('break_in_notice', (m: BreakInNotice) => notices.push(m));
    const internal = harness.getServerRoom()!._internals;
    const cap = [...internal.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    const turret = [...internal.structureRegistry.all()].find((r) => r.kind === 'turret')!;
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;
    for (let i = 0; i < 5; i++) internal.pulseStructureGrid();

    // Before: a player's turret never targets another pilot.
    internal.tickStructureTurrets();
    expect(turret.turretTargetPlayer).toBeUndefined();

    cr.send('break_in', { type: 'break_in', entityId });
    expect(await until(() => turret.turretTargetPlayer === thief, 3_000), 'the turret engages the thief').toBe(true);
    expect(await until(() => notices.some((n) => /You were hit/.test(n.message)), 8_000), 'the hit interrupts it').toBe(true);
  });
});
