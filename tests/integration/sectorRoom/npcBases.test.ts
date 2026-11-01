/**
 * D2 (plan soft-leaping-truffle v3) — an NPC base grown by the generator in a
 * real room. Every generated structure is placed and every generated edge
 * applied under the real rules; the base is built, owned by its NPC side,
 * fuelled, and its processors run on the real grid pulse.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { PROD_STATE } from '../../../src/shared-types/production.js';
import { GATE_ACCESS_IDS } from '../../../src/shared-types/gateAccess.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';

describe('SectorRoom integration — NPC bases from the generator (D2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a refinery settlement is placed, linked, built, fuelled and producing', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      npcBases: [{ baseId: 'b1', role: 'refinery', tier: 'settlement', seed: 12, x: 0, y: 0, features: ['minerals'] }],
      defaultSpawnX: 0,
      defaultSpawnY: -6000,
    });
    await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const recs = [...internals.structureRegistry.all()];
    expect(recs.length).toBeGreaterThan(20);
    expect(recs.every((r) => r.owner === 'npc:traders:b1')).toBe(true);
    expect(recs.every((r) => r.isConstructed)).toBe(true);
    // Every structure is reachable from the Capital through the live grid
    // (each generated edge was applied with the real canConnect).
    const capital = recs.find((r) => r.kind === 'capital')!;
    const seen = new Set([capital.id]);
    const queue = [capital.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const c of internals.structureRegistry.connectionsOf(id)) {
        const other = (c as { getOtherNode(id: string): string | null }).getOtherNode(id)!;
        if (!seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
    expect(seen.size).toBe(recs.length);

    for (let i = 0; i < 12; i++) internals.pulseStructureGrid();
    const reactors = recs.filter((r) => r.kind === 'reactor');
    for (const r of reactors) expect(r.fueled, 'reactors start with fuel').toBe(true);
    const processors = recs.filter((r) => ['smelter', 'refinery', 'silicon_works', 'reclaimer'].includes(r.kind));
    expect(processors.length).toBeGreaterThan(0);
    expect(processors.some((p) => p.prodState === PROD_STATE.running), 'some processor runs').toBe(true);
    // Civilian gates open for anyone not hostile.
    for (const g of recs.filter((r) => r.kind === 'shield_gate')) expect(GATE_ACCESS_IDS[g.gateAccess ?? 0]).toBe('open');
  });

  it('a manufactory loads bound faction blueprints (a break-in cannot steal them)', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      npcBases: [{ baseId: 'm1', role: 'manufactory', tier: 'settlement', seed: 4, x: 0, y: 0 }],
      defaultSpawnX: 0,
      defaultSpawnY: -6000,
    });
    await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const fabs = [...internals.structureRegistry.all()].filter((r) => r.kind === 'fabricator' || r.kind === 'munitions_works');
    expect(fabs.length).toBeGreaterThan(0);
    for (const f of fabs) {
      expect(f.blueprint?.bound).toBe(true);
      expect(f.blueprint?.kind).toBe('bpo');
    }
    // Leveled structures carry their leveled hull.
    const lvl = [...internals.structureRegistry.all()].find((r) => (r.level ?? 1) > 1);
    if (lvl) expect(internals.swarmHealth.get(lvl.id)).toBeGreaterThan(getStructureKind(lvl.kind).maxHealth);
  });
});
