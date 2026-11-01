/**
 * Economy v2 W3 (plan peppy-jumping-pinwheel) — the RESEARCH LAB through a real
 * SectorRoom and the real `lab_query` / `lab_start` / `lab_cancel` messages.
 *
 * A pre-built, powered base (Capital + relays + 2 Solars + a Research Lab)
 * owned by the pilot; blueprints sit in the Capital's hold.
 *  1. the panel view lists the base's blueprints by name, powered + connected;
 *  2. research takes the original out of storage, charges the wallet, advances
 *     one step per powered pulse, and returns it improved;
 *  3. copy returns the original plus a copy with the chosen runs;
 *  4. combine turns 3 copies into 1 that's never worse than the best;
 *  5. a busy lab refuses a 2nd job; a short wallet is refused; cancel returns
 *     the blueprints (fee spent);
 *  6. a lab destroyed mid-job spills its blueprints as a pod, and its job ends.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getLabBoard, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { SCENARIO } from '../../../src/server/rooms/scenarioLayouts.js';
import type { BlueprintItem } from '../../../src/shared-types/items.js';
import type { LabState } from '../../../src/shared-types/messages/labMessages.js';
import { COMBINE_FEE, COMBINE_PULSES, copyFee, copyPulses, researchFee, researchPulses } from '../../../src/shared-types/research.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function bp(uid: string, over: Partial<BlueprintItem> = {}): BlueprintItem {
  return { uid, product: 'hull:gunship', kind: 'bpo', runs: null, material: 2, output: 30, research: 0, ...over };
}

const LAB_POSE = { x: 0, y: -720 };

describe('SectorRoom integration — Research Lab (economy v2 W3)', () => {
  let harness: SectorTestHarness;
  const pid = randomUUID();
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructuresOwner: pid,
      prebuiltStructures: [
        { kind: 'capital', ...SCENARIO.capital },
        { kind: 'connector', ...SCENARIO.connectorN },
        { kind: 'connector', ...SCENARIO.connectorS },
        { kind: 'solar', ...SCENARIO.solarNE },
        { kind: 'solar', ...SCENARIO.solarNW },
        { kind: 'research_lab', ...LAB_POSE },
      ],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('researches, copies, combines, refuses, cancels — and spills when destroyed', { timeout: 60_000 }, async () => {
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 600, shipKind: 'fighter' });
    const r = room(cr.roomId);
    const internal = r._internals;
    const structures = [...internal.structureRegistry.all()];
    const lab = structures.find((s) => s.kind === 'research_lab');
    expect(lab, 'the lab was seeded').toBeDefined();
    const cap = structures.find((s) => s.kind === 'capital')!;
    expect(lab!.isConstructed).toBe(true);
    const labEid = internal.swarmRegistry.get(lab!.id)!.entityId;
    internal.pulseStructureGrid(); // settle the grid (power + components)

    cap.hold = {
      goods: {},
      blueprints: [
        bp('orig', { material: 2 }),
        bp('c1', { kind: 'bpc', runs: 4, material: 1, output: 20 }),
        bp('c2', { kind: 'bpc', runs: 5, material: 6, output: 10 }),
        bp('c3', { kind: 'bpc', runs: 6, material: 2, output: 70 }),
      ],
    };
    getWallet().credit(pid, 2000, 'test');

    const replies: LabState[] = [];
    cr.onMessage('lab_state', (m: LabState) => replies.push(m));
    const ask = async (type: string, body: Record<string, unknown>): Promise<LabState> => {
      const n = replies.length;
      cr.send(type, { entityId: labEid, ...body });
      expect(await until(() => replies.length > n, 4000)).toBe(true);
      return replies[replies.length - 1]!;
    };
    const pulse = (n: number): void => {
      for (let i = 0; i < n; i++) internal.pulseStructureGrid();
    };
    const uids = (): string[] => cap.hold!.blueprints.map((b) => b.uid).sort();

    // 1. The panel view.
    const v = await ask('lab_query', {});
    expect(v.powered).toBe(true);
    expect(v.connected).toBe(true);
    expect(v.job).toBeNull();
    expect(v.blueprints.map((b) => b.name)).toEqual(['Gunship', 'Gunship', 'Gunship', 'Gunship']);

    // 2. Research the original's materials.
    const w0 = getWallet().balance(pid);
    const s1 = await ask('lab_start', { job: { kind: 'research', stat: 'material', uid: 'orig' } });
    expect(s1.ok, s1.message).toBe(true);
    expect(s1.job).toMatchObject({ kind: 'research', done: 0, pulses: researchPulses(2) });
    expect(uids()).toEqual(['c1', 'c2', 'c3']);
    expect(getWallet().balance(pid)).toBe(w0 - researchFee(2));
    // A busy lab refuses another job.
    expect((await ask('lab_start', { job: { kind: 'copy', uid: 'orig', runs: 2 } })).ok).toBe(false);
    pulse(researchPulses(2) - 1);
    expect(getLabBoard().get(lab!.uid!)!.done).toBe(researchPulses(2) - 1);
    // Active power: a lab with a running job draws full power.
    expect(lab!.drawFull).toBe(true);
    pulse(1);
    expect(getLabBoard().get(lab!.uid!)).toBeUndefined();
    // Finished: back to the idle trickle on the next pulse.
    pulse(1);
    expect(lab!.drawFull).toBe(false);
    const orig = cap.hold!.blueprints.find((b) => b.uid === 'orig')!;
    expect(orig).toMatchObject({ material: 3, research: 1 });

    // 3. Copy: the original comes back with a 3-run copy.
    const w1 = getWallet().balance(pid);
    expect((await ask('lab_start', { job: { kind: 'copy', uid: 'orig', runs: 3 } })).ok).toBe(true);
    expect(getWallet().balance(pid)).toBe(w1 - copyFee(3));
    pulse(copyPulses(3));
    const copies = cap.hold!.blueprints.filter((b) => b.kind === 'bpc' && !['c1', 'c2', 'c3'].includes(b.uid));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ runs: 3, material: 3, output: 30 });
    expect(cap.hold!.blueprints.some((b) => b.uid === 'orig')).toBe(true);

    // 4. Combine three copies into one.
    expect((await ask('lab_start', { job: { kind: 'combine', uids: ['c1', 'c2', 'c3'] } })).ok).toBe(true);
    expect(getWallet().balance(pid)).toBe(w1 - copyFee(3) - COMBINE_FEE);
    pulse(COMBINE_PULSES);
    expect(cap.hold!.blueprints.some((b) => ['c1', 'c2', 'c3'].includes(b.uid))).toBe(false);
    const combined = cap.hold!.blueprints.filter((b) => b.kind === 'bpc' && b.uid !== copies[0]!.uid);
    expect(combined).toHaveLength(1);
    expect(combined[0]!.material).toBeGreaterThanOrEqual(6);
    expect(combined[0]!.output).toBeGreaterThanOrEqual(70);

    // 5. A short wallet is refused; cancel returns the blueprint, fee spent.
    getWallet().debit(pid, getWallet().balance(pid), 'test');
    const poor = await ask('lab_start', { job: { kind: 'research', stat: 'output', uid: 'orig' } });
    expect(poor.ok).toBe(false);
    expect(poor.message).toMatch(/You need/);
    getWallet().credit(pid, 1000, 'test');
    expect((await ask('lab_start', { job: { kind: 'research', stat: 'output', uid: 'orig' } })).ok).toBe(true);
    expect(cap.hold!.blueprints.some((b) => b.uid === 'orig')).toBe(false);
    const c = await ask('lab_cancel', {});
    expect(c.ok, c.message).toBe(true);
    expect(c.job).toBeNull();
    expect(cap.hold!.blueprints.find((b) => b.uid === 'orig')!.output).toBe(30);

    // 6. Destroyed mid-job ⇒ the job ends and its blueprint spills as a pod.
    expect((await ask('lab_start', { job: { kind: 'research', stat: 'output', uid: 'orig' } })).ok).toBe(true);
    const podsBefore = [...internal.swarmRegistry.all()].filter((e) => e.kind === 3).length;
    (r as unknown as { evictSwarmEntity(rec: unknown, o: { broadcast: boolean; emitDestroyed: boolean }): void })
      .evictSwarmEntity(internal.swarmRegistry.get(lab!.id), { broadcast: true, emitDestroyed: true });
    expect(getLabBoard().get(lab!.uid!)).toBeUndefined();
    expect([...internal.swarmRegistry.all()].filter((e) => e.kind === 3).length).toBeGreaterThan(podsBefore);
  });

  it('refuses another pilot’s lab and drops malformed jobs',{ timeout: 30_000 }, async () => {
    const other = randomUUID();
    const cr = await harness.connectActive(other, { spawnX: 0, spawnY: 600, shipKind: 'fighter' });
    const internal = room(cr.roomId)._internals;
    const lab = [...internal.structureRegistry.all()].find((s) => s.kind === 'research_lab')!;
    const labEid = internal.swarmRegistry.get(lab.id)!.entityId;
    const replies: LabState[] = [];
    cr.onMessage('lab_state', (m: LabState) => replies.push(m));
    cr.send('lab_query', { entityId: labEid });
    expect(await until(() => replies.length > 0, 4000)).toBe(true);
    expect(replies[0]).toMatchObject({ ok: false, blueprints: [] });
    // Malformed payloads are dropped (no reply).
    cr.send('lab_start', { entityId: labEid, job: { kind: 'combine', uids: ['a'] } });
    await new Promise((res) => setTimeout(res, 300));
    expect(replies).toHaveLength(1);
  });
});
