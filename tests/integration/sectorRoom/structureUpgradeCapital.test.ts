/**
 * Phase 4 WS-B4 (plan: effervescent-umbrella) — review MUST-FIX #2:
 * "Capital structure upgrade hangs forever."
 *
 * Reproduces the orchestrator-confirmed defect: upgrading THE CAPITAL flips the
 * grid's ONLY mineral funder to `isConstructed=false`, so `findStorageRoute`
 * (which requires a built Capital with minerals) returns null for EVERY
 * blueprint — including the capital itself. `processConstruction` then `continue`s
 * before the completion check, so:
 *   (a) the capital's upgrade NEVER completes (permanent blueprint, level stuck), AND
 *   (b) the WHOLE grid loses its bank — every other structure's
 *       construction / upgrade / repair stalls for the duration.
 *
 * LOCKED DESIGN DECISION: the Capital is the operational mineral bank; an upgrade
 * is a visible RE-BUILD of an already-operational structure. A capital that is
 * MID-UPGRADE (`upgradeTargetLevel !== undefined`) must REMAIN funding-capable
 * AND grid-traversable so it funds its own completion AND keeps the grid alive.
 *
 * This test drives the REAL upgrade via `_internals.upgradeStructure` + the
 * deterministic grid pulse, and asserts BOTH halves of the bug:
 *   (a) the capital's level goes 1 -> 2 and re-builds (isConstructed true), AND
 *   (b) a SECOND structure (a DAMAGED turret) still gets REPAIR-funded DURING the
 *       capital's upgrade build phase (the grid is NOT bricked).
 *
 * FAIL-FIRST (invariant #13): on the pre-fix code the upgrade hangs (the capital
 * never re-builds within the pulse budget) AND the turret never heals.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import {
  effectiveStructureMaxHealth,
} from '../../../src/core/leveling/structureLevel.js';

const OWNER_UUID = '33333333-3333-4333-8333-333333333333';

describe('SectorRoom integration — Capital Upgrade does not hang / brick the grid (WS-B4 must-fix #2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('upgrades the CAPITAL to level 2 AND keeps funding a damaged turret during the build', async () => {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      // Capital (the bank + the structure we upgrade) + a Connector relay + a
      // Turret leaf (the SECOND structure that must keep getting funded).
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 150, y: 60 },
        { kind: 'turret', x: 0, y: 250 },
      ],
      prebuiltStructuresOwner: OWNER_UUID,
    });
    await harness.connectAs(OWNER_UUID);
    const internals = harness.getServerRoom()!._internals;

    const structures = [...internals.structureRegistry.all()];
    const capital = structures.find((s) => s.kind === 'capital')!;
    const turret = structures.find((s) => s.kind === 'turret')!;
    expect(capital.isConstructed).toBe(true);
    expect(capital.level).toBe(1);
    expect(capital.owner).toBe(OWNER_UUID);

    // The Capital is the bank.
    const bankBefore = capital.minerals;
    expect(bankBefore).toBeGreaterThan(0);

    // Damage the turret so it needs REPAIR-funding from the bank during the
    // capital's upgrade (the "second structure must still be funded" half).
    const turretKind = getStructureKind('turret');
    const turretMaxHp = turretKind.maxHealth;
    const damagedHp = Math.round(turretMaxHp * 0.5);
    internals.swarmHealth.set(turret.id, damagedHp);
    expect(internals.swarmHealth.get(turret.id)!).toBeLessThan(turretMaxHp);

    // ── Upgrade the CAPITAL (the bug trigger) ────────────────────────────────
    const started = internals.upgradeStructure(capital.id);
    expect(started).toBe(true);
    // The upgrade flipped the capital into a build phase.
    expect(capital.isConstructed).toBe(false);
    expect(capital.upgradeTargetLevel).toBe(2);

    // ── Pulse the grid: the capital's own upgrade must complete AND the turret
    //    must heal. On the PRE-FIX code the capital never re-builds (findStorage-
    //    Route returns null while it is the unbuilt funder) → this loop spins to
    //    the cap and BOTH assertions below fail.
    let pulses = 0;
    while (!capital.isConstructed && pulses < 500) {
      internals.pulseStructureGrid();
      pulses++;
    }

    // (a) the capital's upgrade COMPLETED — level 1 -> 2, re-built, target cleared.
    expect(capital.isConstructed).toBe(true);
    expect(capital.level).toBe(2);
    expect(capital.upgradeTargetLevel).toBeUndefined();
    // Its HP was seeded to the LEVELED max on completion.
    const capLeveledMax = effectiveStructureMaxHealth(getStructureKind('capital').maxHealth, 2);
    expect(internals.swarmHealth.get(capital.id)!).toBeCloseTo(capLeveledMax, 0);

    // (b) the grid was NOT bricked — the damaged turret got REPAIR-funded DURING
    //     the capital's upgrade build phase (its HP climbed back above the damaged
    //     value, drawing from the still-operational bank).
    expect(internals.swarmHealth.get(turret.id)!).toBeGreaterThan(damagedHp);

    // The bank funded both the upgrade (free for the capital) and the repair.
    expect(capital.minerals).toBeLessThanOrEqual(bankBefore);
  }, 30_000);
});
