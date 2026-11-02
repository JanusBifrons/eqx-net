/**
 * An NPC base grown by the generator must stay powered: its shield fence holds
 * and nothing browns out while its processors run.
 *
 * Bug (user report 2026-11-02, from the week-44 showcase footage of the
 * `npc-base-stronghold` room): "the shield fences are constantly flickering or
 * offline … they're browning out". Measured: the stronghold generated 950
 * against 1,880 at full draw. The generator sized processors as busy 60 % of
 * the time, but a stocked NPC base runs them back to back, so the grid went
 * negative every other pulse; its 3,000 of battery started empty and never
 * charged; every structure lost power and all 28 fence emitters dropped their
 * walls on 20 of 40 pulses.
 *
 * Covers every NPC base the showcase rooms spawn (each tier + the colony).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

const BASES = [
  { baseId: 'outpost', role: 'mining', tier: 'outpost', seed: 11, x: 0, y: 0, features: ['asteroid'] },
  { baseId: 'settlement', role: 'refinery', tier: 'settlement', seed: 12, x: 0, y: 0, features: ['minerals'] },
  { baseId: 'stronghold', role: 'manufactory', tier: 'stronghold', seed: 14, x: 0, y: 0, features: [] },
  { baseId: 'citadel', role: 'assembly', tier: 'citadel', seed: 15, x: 0, y: 0, features: [] },
  { baseId: 'colony', role: 'colony', tier: 'settlement', seed: 16, x: 0, y: 0, features: ['station'] },
] as const;

describe('SectorRoom integration — NPC base power is stable', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  for (const base of BASES) {
    it(`a ${base.tier} ${base.role} base keeps power and its fence over many pulses`, async () => {
      harness = await bootSectorTestServer({
        sectorKey: 'sol-prime',
        droneCount: 0,
        testMode: true,
        asteroidConfig: [],
        peacefulDrones: true,
        sectorFeatures: [],
        npcBases: [{ ...base, features: [...base.features] }],
        defaultSpawnX: 0,
        defaultSpawnY: -6000,
      });
      await harness.connectAs(randomUUID());
      const internals = harness.getServerRoom()!._internals;

      const unpowered = new Map<string, number>();
      const wallsDown = new Map<string, number>();
      const STEPS = 40;
      for (let step = 0; step < STEPS; step++) {
        internals.pulseStructureGrid();
        // The 10 Hz structure tick runs ~10× per 1 Hz pulse (walls, turrets, production gates).
        for (let t = 0; t < 10; t++) internals.tickStructureTurrets();
        for (const row of internals.getStructuresSlice() ?? []) {
          const label = `#${row.id}`;
          if (!row.powered) unpowered.set(label, (unpowered.get(label) ?? 0) + 1);
          if (row.wallActive === false) wallsDown.set(label, (wallsDown.get(label) ?? 0) + 1);
        }
      }
      const summary = (m: Map<string, number>): string =>
        [...m.entries()].slice(0, 8).map(([k, n]) => `${k}: ${n}/${STEPS}`).join(', ');
      expect.soft(unpowered.size, `structures that lost power: ${summary(unpowered)}`).toBe(0);
      expect(wallsDown.size, `fence emitters whose wall dropped: ${summary(wallsDown)}`).toBe(0);
    });
  }
});
