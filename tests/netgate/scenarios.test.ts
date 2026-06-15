/**
 * Lock for the netgate scenario resolver (plan: misty-teapot). The CSV →
 * descriptor mapping is load-bearing: a silent miss would run the WRONG
 * scenario set (a fail-open gate). So `resolveScenarios` must throw loudly
 * on an unknown name and default to `core`.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, resolveScenarios } from './scenarios';
import { GATED_SCENARIO_GLOBS, selectScenarios } from './select-scenarios.mjs';

describe('resolveScenarios', () => {
  it('empty / whitespace CSV ⇒ defaults to core', () => {
    expect(resolveScenarios('').map((s) => s.name)).toEqual(['core']);
    expect(resolveScenarios('   ').map((s) => s.name)).toEqual(['core']);
  });

  it('resolves a known name', () => {
    expect(resolveScenarios('core').map((s) => s.name)).toEqual(['core']);
  });

  it('dedups and preserves catalogue order', () => {
    const names = resolveScenarios('core,core').map((s) => s.name);
    expect(names).toEqual(['core']);
  });

  it('throws LOUDLY on an unknown name (a typo must fail, never silently skip)', () => {
    expect(() => resolveScenarios('core,bogus')).toThrow(/unknown scenario 'bogus'/);
  });

  it('every catalogue scenario has the required descriptor fields', () => {
    for (const s of SCENARIOS) {
      expect(s.name).toBeTruthy();
      expect(s.room).toBeTruthy();
      expect(s.liveSelector).toBeTruthy();
      expect(['gate', 'print-only']).toContain(s.gating);
      expect(s.triggerGlobs.length).toBeGreaterThan(0);
    }
  });

  it('core is gated and points at the historical feel-test-25 room', () => {
    const core = SCENARIOS.find((s) => s.name === 'core');
    expect(core?.room).toBe('feel-test-25');
    expect(core?.gating).toBe('gate');
    expect(core?.urlParams).toBe('');
  });
});

describe('select-scenarios.mjs — SoT consistency with scenarios.ts', () => {
  it('the .mjs gated-glob table mirrors the gated SCENARIOS exactly (no drift)', () => {
    const gated = SCENARIOS.filter((s) => s.gating === 'gate');
    // Same set of gated names.
    expect(Object.keys(GATED_SCENARIO_GLOBS).sort()).toEqual(gated.map((s) => s.name).sort());
    // Same globs, in the same order, per scenario.
    for (const s of gated) {
      expect(GATED_SCENARIO_GLOBS[s.name], `globs for ${s.name}`).toEqual(s.triggerGlobs);
    }
  });
});

describe('selectScenarios — fail-CLOSED routing (hostile review M3)', () => {
  it('docs / diag / unrelated-only diff ⇒ empty (gate legitimately skips)', () => {
    expect(selectScenarios(['docs/x.md', 'README.md'])).toEqual([]);
    expect(selectScenarios(['diag/_pr-body.md', 'diag/adb-shots/foo.mjs'])).toEqual([]);
    expect(selectScenarios(['src/server/routes/authRouter.ts'])).toEqual([]);
  });

  it('a structures / scrap change routes to core (closes the path-filter hole)', () => {
    expect(selectScenarios(['src/server/structures/StructureGridSubsystem.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/core/structures/Grid.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/shared-types/structureKinds.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/server/spawn/ScrapSpawner.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/core/geometry/scrapCollider.ts'])).toEqual(['core']);
  });

  it('a shared live-loop change routes to core', () => {
    expect(selectScenarios(['src/server/rooms/SnapshotBroadcaster.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/core/prediction/reconciler.ts'])).toEqual(['core']);
  });

  it('empty / null / non-array changed-file list ⇒ ALL gated (fail-closed)', () => {
    expect(selectScenarios([])).toEqual(['core']);
    expect(selectScenarios(null)).toEqual(['core']);
    expect(selectScenarios(undefined)).toEqual(['core']);
  });

  it('a NEW unenumerated file in a live-loop dir ⇒ ALL gated (default-deny safety net)', () => {
    // Not in any specific scenario glob, but under a live-loop prefix.
    expect(selectScenarios(['src/server/rooms/SomeBrandNewBroadcaster.ts'])).toEqual(['core']);
    expect(selectScenarios(['src/core/combat/NewWeapon.ts'])).toEqual(['core']);
  });

  it('normalises backslash paths (Windows diff lists)', () => {
    expect(selectScenarios(['src\\server\\structures\\Foo.ts'])).toEqual(['core']);
  });

  it('a mixed docs + live-loop diff still selects core (the live-loop file wins)', () => {
    expect(selectScenarios(['README.md', 'src/server/structures/StructureRegistry.ts'])).toEqual([
      'core',
    ]);
  });
});
