/**
 * Structures plan, Phase 3-5 — the testMode SCENARIO trigger
 * (`prebuiltStructures` + `scenarioDrones` + `scenarioAsteroids`), the bespoke
 * E2E primitive that seeds a pre-built, auto-connected, powered grid + targets.
 * This locks the seeding path server-side (the browser E2E that drives it can't
 * run in this environment).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — structure scenario seeding (Phase 3-5)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('seeds a pre-built, auto-connected, powered grid that mines + fires', async () => {
    harness = await bootSectorTestServer({
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'solar', x: 250, y: 0 },
        { kind: 'solar', x: 0, y: 250 },
        { kind: 'miner', x: -350, y: 0 },
        { kind: 'turret', x: 0, y: -350 },
      ],
      scenarioAsteroids: [{ x: -700, y: 0, radius: 30 }],
      scenarioDrones: [{ x: 0, y: -550 }],
    });
    await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // All five structures exist, built, and the grid is powered.
    const structures = [...internals.structureRegistry.all()];
    expect(structures.length).toBe(5);
    for (const s of structures) expect(s.isConstructed).toBe(true);
    const capital = structures.find((s) => s.kind === 'capital')!;
    const miner = structures.find((s) => s.kind === 'miner')!;
    const turret = structures.find((s) => s.kind === 'turret')!;
    expect(internals.structureRegistry.connectionCount(capital.id)).toBe(4); // 4 leaves

    // Mining: a pulse grows the bank (miner powered, asteroid in range).
    const bankBefore = capital.minerals;
    internals.pulseStructureGrid();
    expect(capital.minerals).toBeGreaterThan(bankBefore);
    expect(miner.miningTargetEntityId).toBeDefined();

    // Turret: a tick locks + damages the parked drone.
    // The scenario drone id is deterministic (`scenario-drone-*`).
    const droneId = [...internals.swarmRegistry.all()].find((r) => r.kind === 1)!.id;
    const droneHpBefore = internals.swarmHealth.get(droneId)!;
    expect(droneHpBefore).toBeGreaterThan(0);
    internals.tickStructureTurrets();
    const after = internals.swarmHealth.get(droneId);
    if (after !== undefined) {
      expect(after).toBeLessThan(droneHpBefore);
    } else {
      expect(internals.swarmRegistry.get(droneId) ?? null).toBeNull(); // overkilled
    }
    expect(turret.turretTargetEntityId).toBeDefined();
  }, 25_000);
});
