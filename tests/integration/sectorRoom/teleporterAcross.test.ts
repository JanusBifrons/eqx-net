/**
 * v4 T3 — teleporters across sectors, with two real galaxy rooms in one
 * process (the teleport broker reaches the other room's teleporters).
 *
 * Each sector has the same base: Capital (0,0) → Connector (-600,0) →
 * Teleporter (-1300,0), owned by one player.
 *  - The candidates reply lists the far teleporter by sector name.
 *  - `teleport_pair_remote` pairs them both ways.
 *  - The capacitor fills to the cross-sector charge (hops × hop distance).
 *  - Firing runs the cycle in BOTH rooms; at the swap the pad holds trade
 *    across rooms and a pilot on the near pad is sent to the far sector
 *    (an instant transit, `transit_ready` for the far sector).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { TELEPORT_HOP_DISTANCE_U, TP_PHASE, jumpCharge } from '../../../src/shared-types/teleport.js';
import { hopDistance } from '../../../src/server/livingworld/population.js';
import { getSector } from '../../../src/core/galaxy/galaxy.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const OWNER = 'face0000-0000-4000-8000-000000000002';
const OTHER = 'face0000-0000-4000-8000-000000000003';
const A = 'sol-prime';
const B = 'vega-reach';
const LAYOUT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: -600, y: 0 },
  { kind: 'teleporter', x: -1300, y: 0 },
];

describe('SectorRoom integration — teleporters across sectors (v4 T3)', () => {
  let harness: LivingWorldTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('pairs across sectors, charges by hops, and a jump swaps pads and sends the pilot over', { timeout: 40_000 }, async () => {
    harness = await bootLivingWorldTestServer({
      sectors: [A, B],
      botCount: 0,
      teleportCycleScale: 0.02,
      bases: [
        { sector: A, structures: LAYOUT, owner: OWNER },
        { sector: B, structures: LAYOUT, owner: OWNER },
      ],
    });
    const roomA = harness.getRoom(A) as SectorRoom;
    const roomB = harness.getRoom(B) as SectorRoom;
    const ia = roomA._internals;
    const ib = roomB._internals;
    const tpA = [...ia.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;
    const tpB = [...ib.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;
    const eid = ia.swarmRegistry.get(tpA.id)!.entityId;

    const client = await harness.connectActive(OWNER, A, { shipKind: 'fighter', spawnX: -1300, spawnY: -50 });
    const replies: Array<{ items: Array<{ sectorKey: string; uid: string; label: string }> }> = [];
    client.onMessage('teleport_candidates', (m: { items: Array<{ sectorKey: string; uid: string; label: string }> }) => replies.push(m));
    const transits: Array<{ targetSectorKey?: string }> = [];
    client.onMessage('transit_ready', (m: { targetSectorKey?: string }) => transits.push(m));

    // The far teleporter is listed by sector name.
    client.send('teleport_candidates', { type: 'teleport_candidates', entityId: eid });
    await harness.waitUntil(() => replies.length > 0, 3000, 'candidates reply');
    const far = replies[0]!.items.find((c) => c.sectorKey === B);
    expect(far?.uid).toBe(tpB.uid);
    expect(far?.label).toContain(getSector(B)!.name);

    // Pair across sectors: both ends point at each other.
    client.send('teleport_pair_remote', { type: 'teleport_pair_remote', entityId: eid, sectorKey: B, uid: tpB.uid });
    await harness.waitUntil(() => tpA.tpPartner?.uid === tpB.uid, 3000, 'paired');
    expect(tpB.tpPartner).toEqual({ sectorKey: A, uid: tpA.uid });

    // The charge depends only on distance: hops × the hop distance.
    const need = jumpCharge(hopDistance(A, B) * TELEPORT_HOP_DISTANCE_U);
    for (let i = 0; i < 600 && (tpA.tpCharge ?? 0) < need; i++) ia.pulseStructureGrid();
    expect(tpA.tpCharge).toBe(need);

    // A second pilot parks a hull on the FAR pad (disconnect ⇒ it lingers).
    const parker = await harness.connectActive(OTHER, B, { shipKind: 'fighter', spawnX: -1300, spawnY: 60 });
    await harness.disconnectClient(parker);
    await harness.advance(300);
    const parkedId = [...roomB.state.ships.values()].find((sh) => sh.playerId === OTHER)?.shipInstanceId ?? '';
    expect(parkedId, 'the parked hull is in B').toBeTruthy();

    // Something on each pad's hold.
    tpA.padHold = { goods: { alloy: 5 }, blueprints: [] };
    tpB.padHold = { goods: { fuel: 3 }, blueprints: [] };

    client.send('teleport_fire', { type: 'teleport_fire', entityId: eid });
    await harness.waitUntil(() => (tpA.tpPhase ?? 0) !== TP_PHASE.IDLE, 3000, 'armed');
    expect(tpB.tpPhase).toBe(tpA.tpPhase); // the far room runs the same cycle
    for (let i = 0; i < 400 && (tpA.tpPhase ?? 0) !== TP_PHASE.IDLE; i++) {
      ia.tickStructureTurrets();
      await harness.advance(40);
    }
    expect(tpA.tpPhase ?? 0).toBe(TP_PHASE.IDLE);
    expect(tpB.tpPhase ?? 0).toBe(TP_PHASE.IDLE);
    // Only the firing end paid (the grid tops it back up afterwards).
    expect(tpA.tpCharge ?? 0).toBeLessThan(need);
    expect(tpB.tpCharge ?? 0).toBeLessThan(need); // B is still filling on its own grid
    // The pad holds traded places across the two rooms.
    // (Each room's own pulse may already have unloaded arrivals into its storage.)
    const capA = [...ia.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    const capB = [...ib.structureRegistry.all()].find((r) => r.kind === 'capital')!;
    expect((tpA.padHold?.goods.fuel ?? 0) + (capA.hold?.goods.fuel ?? 0)).toBe(3);
    expect((tpB.padHold?.goods.alloy ?? 0) + (capB.hold?.goods.alloy ?? 0)).toBe(5);
    // The pilot on the near pad was sent to the far sector.
    await harness.waitUntil(() => transits.length > 0, 5000, 'transit_ready');
    expect(transits[0]!.targetSectorKey).toBe(B);
    // The parked hull rode the other way: rebuilt in A, gone from B.
    expect(ia.lingeringSlots.has(parkedId)).toBe(true);
    expect(ib.lingeringSlots.has(parkedId)).toBe(false);
  });
});

describe('SectorRoom integration — pairing with another owner (v4 T4)', () => {
  let harness: LivingWorldTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a request reaches the other owner by name; only that owner can accept', { timeout: 30_000 }, async () => {
    harness = await bootLivingWorldTestServer({
      sectors: [A, B],
      botCount: 0,
      bases: [
        { sector: A, structures: LAYOUT, owner: OWNER },
        { sector: B, structures: LAYOUT, owner: OTHER },
      ],
    });
    const ia = (harness.getRoom(A) as SectorRoom)._internals;
    const ib = (harness.getRoom(B) as SectorRoom)._internals;
    const mine = [...ia.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;
    const theirs = [...ib.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;

    // The other owner is online in their sector; I visit it and ask.
    const them = await harness.connectActive(OTHER, B, { shipKind: 'fighter' });
    const prompts: Array<{ requestId: string; label: string; fromName: string }> = [];
    them.onMessage('teleport_pair_request', (m: { requestId: string; label: string; fromName: string }) => prompts.push(m));
    const me = await harness.connectActive(OWNER, B, { shipKind: 'fighter' });
    me.send('teleport_pair_request', {
      type: 'teleport_pair_request', entityId: ib.swarmRegistry.get(theirs.id)!.entityId, sectorKey: A, uid: mine.uid,
    });
    await harness.waitUntil(() => prompts.length > 0, 3000, 'request reached the owner');
    expect(prompts[0]!.label).toContain(getSector(A)!.name);
    expect(mine.tpPartner).toBeUndefined(); // nothing until they accept

    // Only the owner can accept; a stranger's answer does nothing.
    me.send('teleport_pair_answer', { type: 'teleport_pair_answer', requestId: prompts[0]!.requestId, accept: true });
    await harness.advance(150);
    expect(mine.tpPartner).toBeUndefined();
  });

  it('the owner accepting pairs them across owners and sectors', { timeout: 30_000 }, async () => {
    harness = await bootLivingWorldTestServer({
      sectors: [A, B],
      botCount: 0,
      bases: [
        { sector: A, structures: LAYOUT, owner: OWNER },
        { sector: B, structures: LAYOUT, owner: OTHER },
      ],
    });
    const ia = (harness.getRoom(A) as SectorRoom)._internals;
    const ib = (harness.getRoom(B) as SectorRoom)._internals;
    const mine = [...ia.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;
    const theirs = [...ib.structureRegistry.all()].find((r) => r.kind === 'teleporter')!;
    const them = await harness.connectActive(OTHER, B, { shipKind: 'fighter' });
    const prompts: Array<{ requestId: string }> = [];
    them.onMessage('teleport_pair_request', (m: { requestId: string }) => prompts.push(m));
    const me = await harness.connectActive(OWNER, B, { shipKind: 'fighter' });
    me.send('teleport_pair_request', {
      type: 'teleport_pair_request', entityId: ib.swarmRegistry.get(theirs.id)!.entityId, sectorKey: A, uid: mine.uid,
    });
    await harness.waitUntil(() => prompts.length > 0, 3000, 'request reached the owner');
    them.send('teleport_pair_answer', { type: 'teleport_pair_answer', requestId: prompts[0]!.requestId, accept: true });
    await harness.waitUntil(() => theirs.tpPartner?.uid === mine.uid, 3000, 'paired');
    expect(mine.tpPartner).toEqual({ sectorKey: B, uid: theirs.uid });
  });
});
