/**
 * v4 A — alien gates, with two real neighbouring galaxy rooms in one process.
 *
 *  - Each sector seeds a gate on the edge facing the other, owned by the
 *    Ancients, paired with its twin across the border.
 *  - The gates jump on their own timetable (sped up by `teleportCycleScale`),
 *    free: a pilot parked on the near pad is carried to the far sector.
 *  - They can't be damaged: a hit does nothing to the gate and DISABLES the
 *    attacker, whose own-ship snapshot then carries `disabledMs` (#16).
 *  - Firing inside a gate's zone disables the shooter too.
 *  - Nobody can build one or ask to pair with one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { ALIEN_GATE_OWNER } from '../../../src/core/galaxy/alienGates.js';
import { TP_PHASE } from '../../../src/shared-types/teleport.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';

const PILOT = 'face0000-0000-4000-8000-000000000004';
const A = 'sol-prime';
const B = 'vega-reach';

function gateToward(room: SectorRoom, neighbour: string, here: string): StructureRecord {
  const g = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'alien_gate' && r.alienNeighbour === neighbour);
  if (!g) throw new Error(`no gate in ${here} toward ${neighbour}`);
  return g;
}

describe('SectorRoom integration — alien gates (v4 A)', () => {
  let harness: LivingWorldTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('twinned gates jump on their timetable and carry a pilot across the border, free', { timeout: 40_000 }, async () => {
    harness = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, teleportCycleScale: 0.02, alienGates: true });
    const roomA = harness.getRoom(A) as SectorRoom;
    const roomB = harness.getRoom(B) as SectorRoom;
    const gA = gateToward(roomA, B, A);
    const gB = gateToward(roomB, A, B);
    expect(gA.owner).toBe(ALIEN_GATE_OWNER);
    expect(gA.isConstructed).toBe(true);
    // Each finds its twin across the border on its first timetable check.
    roomA._internals.tickStructureTurrets();
    roomB._internals.tickStructureTurrets();
    expect(gA.tpPartner).toEqual({ sectorKey: B, uid: gB.uid });
    expect(gB.tpPartner).toEqual({ sectorKey: A, uid: gA.uid });

    const client = await harness.connectActive(PILOT, A, { shipKind: 'fighter', spawnX: gA.x, spawnY: gA.y + 100 });
    const transits: Array<{ targetSectorKey?: string }> = [];
    client.onMessage('transit_ready', (m: { targetSectorKey?: string }) => transits.push(m));

    // No one fires it: the timetable does (A drives: its key sorts first).
    let armed = false;
    for (let i = 0; i < 200 && transits.length === 0; i++) {
      roomA._internals.tickStructureTurrets();
      roomB._internals.tickStructureTurrets();
      if ((gA.tpPhase ?? 0) !== TP_PHASE.IDLE) {
        armed = true;
        expect(gB.tpPhase).toBe(gA.tpPhase); // the twin runs the same cycle
      }
      await harness.advance(40);
    }
    expect(armed, 'the gate armed on its own').toBe(true);
    expect(transits[0]?.targetSectorKey).toBe(B);
    expect(gA.tpCharge ?? 0).toBe(0); // free: nothing to charge or spend
  });

  it('a gate takes no damage; its attacker is disabled and told so', { timeout: 30_000 }, async () => {
    harness = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, alienGates: true });
    const roomA = harness.getRoom(A) as SectorRoom;
    const ia = roomA._internals;
    const gA = gateToward(roomA, B, A);
    const client = await harness.connectActive(PILOT, A, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const disabled: number[] = [];
    client.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; disabledMs?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === PILOT && st.disabledMs !== undefined) disabled.push(st.disabledMs);
    });

    ia.applyDamage(gA.id, PILOT, 500);
    expect(ia.structureRegistry.get(gA.id)).toBeDefined(); // still there
    await harness.waitUntil(() => disabled.length > 0, 3000, 'disabledMs on the snapshot');
    expect(disabled[0]!).toBeGreaterThan(5000);
    expect(disabled[0]!).toBeLessThanOrEqual(10_000);
  });

  it('firing inside a gate’s zone disables the shooter; far away it does not', { timeout: 30_000 }, async () => {
    harness = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, alienGates: true });
    const roomA = harness.getRoom(A) as SectorRoom;
    const site = gateToward(roomA, B, A);
    // Every edge facing a neighbour has a gate; the centre is outside all their zones.
    const far = await harness.connectActive('face0000-0000-4000-8000-000000000005', A, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const near = await harness.connectActive(PILOT, A, { shipKind: 'fighter', spawnX: Math.round(site.x * (1 - 1000 / Math.hypot(site.x, site.y))), spawnY: Math.round(site.y * (1 - 1000 / Math.hypot(site.x, site.y))) }); // 1,000 u in from the gate (inside its 2,500 u zone at any sector size)
    const disabledFor = new Set<string>();
    for (const [c, pid] of [[far, 'far'], [near, 'near']] as const) {
      c.onMessage('snapshot', (snap: { states?: Record<string, { disabledMs?: number }> }) => {
        for (const st of Object.values(snap.states ?? {})) if ((st.disabledMs ?? 0) > 0) disabledFor.add(pid);
      });
    }
    const tick = roomA._internals.serverTick;
    for (const c of [far, near]) {
      c.send('fire', { type: 'fire', tick, clientShotId: `s-${Math.random().toString(36).slice(2, 8)}`, weapon: 'hitscan', dirAngle: 0 });
    }
    await harness.waitUntil(() => disabledFor.has('near'), 3000, 'the near shooter is disabled');
    await harness.advance(300);
    expect(disabledFor.has('far')).toBe(false);
  });

  it('nobody can build an alien gate or ask to pair with one', { timeout: 30_000 }, async () => {
    harness = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, alienGates: true });
    const roomA = harness.getRoom(A) as SectorRoom;
    const ia = roomA._internals;
    const client = await harness.connectActive(PILOT, A, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const before = [...ia.structureRegistry.all()].filter((r) => r.kind === 'alien_gate').length;
    client.send('place_structure', { type: 'place_structure', kind: 'alien_gate', x: 0, y: -1500 });
    const gA = gateToward(roomA, B, A);
    const requests: unknown[] = [];
    client.onMessage('teleport_pair_request', (m) => requests.push(m));
    client.send('teleport_pair_request', {
      type: 'teleport_pair_request', entityId: ia.swarmRegistry.get(gA.id)!.entityId, sectorKey: A, uid: 'whatever',
    });
    await harness.advance(400);
    expect([...ia.structureRegistry.all()].filter((r) => r.kind === 'alien_gate').length).toBe(before);
    expect(gA.tpPartner?.sectorKey).toBe(B);
  });
});
