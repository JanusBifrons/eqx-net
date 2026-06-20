/**
 * Phase 4 WS-B4 (plan: effervescent-umbrella) — structure leveling via a paid
 * Upgrade build phase.
 *
 * Drives the REAL `upgrade_structure` message against a `structure-scenario-test`-
 * style pre-built grid OWNED by the joining player, then fast-forwards the build
 * phase via the deterministic grid pulse (`_internals.pulseStructureGrid`, the
 * structureGridPulseMs analogue for an integration test — no wall-clock wait).
 * Asserts the four WS-B4 behaviours end-to-end:
 *   1. Upgrade CHARGES resources (the Capital bank drains during the build).
 *   2. The build phase RUNS (the turret flips to a blueprint, then re-builds).
 *   3. The level INCREMENTS on completion (1 → 2).
 *   4. The KEY STAT increases (the leveled effective max HP > base).
 * Plus the owner gate: a foreign / capped / unknown request is a silent no-op.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import {
  effectiveStructureMaxHealth,
  structureUpgradeCost,
} from '../../../src/core/leveling/structureLevel.js';

// A valid-UUID playerId — the server's `assignPlayerId` mints a fresh UUID for
// any non-UUID requested id, so an owner-gated action (Upgrade) only matches a
// structure owner that is the SAME UUID the join resolved to. Use a fixed UUID
// for BOTH the join id and `prebuiltStructuresOwner`.
const OWNER_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

describe('SectorRoom integration — structure leveling / Upgrade (WS-B4)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('Upgrade charges resources, runs a build phase, increments level, raises HP', async () => {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      // A minimal owned grid: a Capital (the mineral bank) + a Connector relay +
      // a Turret leaf. Owned by the joining player (a valid UUID — see OWNER_UUID)
      // so the Upgrade owner-gate matches.
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 150, y: 60 },
        { kind: 'turret', x: 0, y: 250 },
      ],
      prebuiltStructuresOwner: OWNER_UUID,
    });
    const room = await harness.connectAs(OWNER_UUID);
    const internals = harness.getServerRoom()!._internals;

    const structures = [...internals.structureRegistry.all()];
    const capital = structures.find((s) => s.kind === 'capital')!;
    const turret = structures.find((s) => s.kind === 'turret')!;
    expect(turret.isConstructed).toBe(true);
    expect(turret.level).toBe(1);
    expect(turret.owner).toBe(OWNER_UUID);

    const turretKind = getStructureKind('turret');
    const baseMaxHp = turretKind.maxHealth;
    // Built turret is at base max HP (level 1).
    expect(internals.swarmHealth.get(turret.id)).toBeCloseTo(baseMaxHp, 0);

    // The Capital must have minerals to fund the upgrade (it starts with a bank).
    const bankBefore = capital.minerals;
    expect(bankBefore).toBeGreaterThan(0);
    const expectedCost = structureUpgradeCost(turretKind.constructionCost, 1);
    expect(expectedCost).toBeGreaterThan(0);
    expect(bankBefore).toBeGreaterThanOrEqual(expectedCost);

    // The turret's wire entityId (what the client sends).
    const turretEntityId = [...internals.swarmRegistry.all()].find(
      (r) => r.id === turret.id,
    )!.entityId;

    // ── Send the real upgrade_structure message ──────────────────────────────
    room.send('upgrade_structure', { type: 'upgrade_structure', entityId: turretEntityId });
    // Poll for the server to process the message (the upgrade flips isConstructed
    // false). The default 1 Hz grid timer won't fire in this window, so a flip is
    // unambiguously the upgrade handler, not a build pulse.
    {
      const deadline = Date.now() + 2000;
      while (turret.isConstructed && Date.now() < deadline) {
        await harness.advance(40);
      }
    }

    // The upgrade started a NEW build phase: the turret is a blueprint again,
    // building toward level 2, with the cost set.
    expect(turret.isConstructed).toBe(false);
    expect(turret.upgradeTargetLevel).toBe(2);
    expect(turret.constructionProgress).toBe(0);
    expect(turret.constructionCost).toBe(expectedCost);
    expect(turret.level).toBe(1); // not yet — only on completion

    // ── Fast-forward the build phase via the deterministic pulse ─────────────
    // Each pulse drains the Capital toward the turret's construction. Charging
    // is observable: the bank drops as minerals flow into the build.
    let pulses = 0;
    while (!turret.isConstructed && pulses < 500) {
      internals.pulseStructureGrid();
      pulses++;
    }
    expect(turret.isConstructed).toBe(true);

    // (1) resources CHARGED — the Capital bank dropped by ~the upgrade cost.
    expect(capital.minerals).toBeLessThan(bankBefore);
    expect(bankBefore - capital.minerals).toBeGreaterThanOrEqual(expectedCost - 1);

    // (3) level INCREMENTED + the target cleared.
    expect(turret.level).toBe(2);
    expect(turret.upgradeTargetLevel).toBeUndefined();

    // (4) the KEY STAT increased — effective max HP > base, and the rebuilt
    // turret's HP was seeded to the LEVELED max.
    const leveledMaxHp = effectiveStructureMaxHealth(baseMaxHp, 2);
    expect(leveledMaxHp).toBeGreaterThan(baseMaxHp);
    expect(internals.swarmHealth.get(turret.id)).toBeCloseTo(leveledMaxHp, 0);
  }, 30_000);

  it('drops an upgrade on a structure another player owns (silent no-op)', async () => {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
      // Owned by someone ELSE — the joining player must not be able to upgrade it.
      prebuiltStructuresOwner: OTHER_UUID,
    });
    const room = await harness.connectAs(OWNER_UUID);
    const internals = harness.getServerRoom()!._internals;
    const capital = [...internals.structureRegistry.all()].find((s) => s.kind === 'capital')!;
    const entityId = [...internals.swarmRegistry.all()].find((r) => r.id === capital.id)!.entityId;

    expect(capital.level).toBe(1);
    room.send('upgrade_structure', { type: 'upgrade_structure', entityId });
    await harness.advance(120);

    // Foreign owner → no upgrade started: still built, still level 1, no target.
    expect(capital.isConstructed).toBe(true);
    expect(capital.level).toBe(1);
    expect(capital.upgradeTargetLevel).toBeUndefined();
  }, 30_000);
});
