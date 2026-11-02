/**
 * v4 T1 — teleporters in a real room (the teleport-test layout): a powered
 * Capital with a teleporter on each side, paired at seed.
 *
 *  - Spare power fills each capacitor up to the jump's charge (it depends on
 *    distance only), and no further.
 *  - Loading a pad moves goods out of base storage onto the pad hold.
 *  - Firing runs one cycle on BOTH pads; at the swap the pad holds trade
 *    places, only the firing end spends its charge, and the arrivals unload
 *    into base storage on the next pulse.
 *  - A late joiner sees the pair and the charge in room state (#16).
 *  - Messages are owner-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { jumpCharge, TP_PHASE } from '../../../src/shared-types/teleport.js';

const OWNER = 'face0000-0000-4000-8000-000000000002';
const LAYOUT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: -600, y: 0 },
  { kind: 'connector', x: 600, y: 0 },
  { kind: 'teleporter', x: -1300, y: 0 },
  { kind: 'teleporter', x: 1300, y: 0 },
];

describe('SectorRoom integration — teleporters (v4 T1)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot() {
    harness = await bootSectorTestServer({
      sectorKey: 'teleport-test',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: LAYOUT,
      prebuiltStructuresOwner: OWNER,
      prebuiltStorageGoods: { alloy: 50 },
      pairTeleporters: true,
      teleportCycleScale: 0.01,
      defaultSpawnX: 0,
      defaultSpawnY: 900,
    } as never);
    const client = await harness.connectActive(OWNER);
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const [a, b] = all.filter((r) => r.kind === 'teleporter');
    const capital = all.find((r) => r.kind === 'capital')!;
    const eid = (id: string): number => internals.swarmRegistry.get(id)!.entityId;
    return { client, internals, a: a!, b: b!, capital, eid };
  }

  async function pulses(n: number, internals: { pulseStructureGrid(): void }): Promise<void> {
    for (let i = 0; i < n; i++) internals.pulseStructureGrid();
    await harness.advance(20);
  }

  it('charges to the jump’s charge, loads a pad, and a fired jump swaps the pads', { timeout: 30_000 }, async () => {
    const { client, internals, a, b, capital, eid } = await boot();
    expect(a.tpPartner?.uid).toBe(b.uid);
    expect(b.tpPartner?.uid).toBe(a.uid);
    const need = jumpCharge(Math.hypot(a.x - b.x, a.y - b.y));

    // Spare power fills the capacitors, capped at the jump's charge.
    await pulses(400, internals);
    expect(a.tpCharge).toBe(need);
    expect(b.tpCharge).toBe(need);

    // Load 10 alloy onto A's pad from the Capital.
    client.send('teleport_pad_load', { type: 'teleport_pad_load', entityId: eid(a.id), good: 'alloy', qty: 10 });
    await harness.advance(150);
    expect(a.padHold?.goods.alloy).toBe(10);
    expect(capital.hold?.goods.alloy).toBe(40);

    // Fire A. Both pads run the cycle; A spends its charge, B keeps its own.
    client.send('teleport_fire', { type: 'teleport_fire', entityId: eid(a.id) });
    await harness.advance(100);
    expect(a.tpPhase).not.toBe(TP_PHASE.IDLE);
    expect(b.tpPhase).toBe(a.tpPhase);
    for (let i = 0; i < 40 && a.tpPhase !== TP_PHASE.IDLE; i++) {
      internals.tickStructureTurrets();
      await harness.advance(30);
    }
    expect(a.tpPhase).toBe(TP_PHASE.IDLE);
    expect(b.tpPhase).toBe(TP_PHASE.IDLE);
    expect(a.tpCharge).toBe(0);
    expect(b.tpCharge).toBe(need);
    // The pad holds traded places: the alloy is on B's pad…
    expect(a.padHold?.goods.alloy ?? 0).toBe(0);
    expect(b.padHold?.goods.alloy).toBe(10);
    // …and unloads into B's base storage (the same Capital here) next pulse.
    internals.pulseStructureGrid();
    expect(b.padHold?.goods.alloy ?? 0).toBe(0);
    expect(capital.hold?.goods.alloy).toBe(50);
  });

  it('a late joiner sees the pair and the charge in room state', { timeout: 30_000 }, async () => {
    const { internals, a, b, eid } = await boot();
    await pulses(50, internals);
    const late = await harness.connectActive(randomUUID());
    await harness.advance(200);
    const st = (late as unknown as { state: { structures: Map<string, { tpPartner?: number; tpChargePct?: number }> } }).state.structures;
    const row = st.get(String(eid(a.id)));
    expect(row?.tpPartner).toBe(eid(b.id));
    expect(row?.tpChargePct ?? 0).toBeGreaterThan(0);
  });

  it('another player cannot fire, pair or unload someone else’s teleporter', { timeout: 30_000 }, async () => {
    const { internals, a, eid } = await boot();
    await pulses(400, internals);
    const stranger = await harness.connectActive(randomUUID());
    stranger.send('teleport_fire', { type: 'teleport_fire', entityId: eid(a.id) });
    stranger.send('teleport_unpair', { type: 'teleport_unpair', entityId: eid(a.id) });
    await harness.advance(150);
    expect(a.tpPhase ?? TP_PHASE.IDLE).toBe(TP_PHASE.IDLE);
    expect(a.tpPartner).toBeDefined();
  });
});
