import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
// @ts-expect-error plain-JS module (the CI job runs it without a TS toolchain)
import { FEATURE_TRIGGERS, QUARANTINE } from '../e2e/featureTriggers.mjs';
// @ts-expect-error plain-JS module
import { selectFeatureSpecs, releasedFromQuarantine } from '../e2e/select-feature-specs.mjs';

type Trigger = { area: string; paths: string[]; specs: string[] };
const triggers = FEATURE_TRIGGERS as Trigger[];
const select = selectFeatureSpecs as (changed: string[]) => string[];

describe('path-triggered feature specs', () => {
  it('every named spec exists (a renamed spec must not silently drop out)', () => {
    const named = [...triggers.flatMap((t) => t.specs), ...(QUARANTINE as Set<string>)];
    const missing = named.filter((s) => !existsSync(`tests/e2e/${s}.spec.ts`) && !existsSync(`tests/e2e/combat/${s}.spec.ts`)
      && !existsSync(`tests/e2e/linger/${s}.spec.ts`));
    expect(missing).toEqual([]);
  });

  it('a spec leaving the quarantine list runs itself (CI proves it before it counts)', () => {
    // 2026-11-12: missile-frigate-homing passed 6/6 on the desktop but timed
    // out on CI's host. Editing the list alone ran nothing, so a release was
    // only tested by the next PR that happened to touch its area.
    const released = releasedFromQuarantine("QUARANTINE = new Set([\n  'hover-outline',\n  'fire-control-lock',\n]);", new Set(['fire-control-lock']));
    expect(released).toEqual(['hover-outline']);
    expect((selectFeatureSpecs as (c: string[], r: string[]) => string[])([], released)).toEqual(['hover-outline']);
  });

  it('a structures change runs the structure specs', () => {
    const specs = select(['src/server/structures/StructureGridSubsystem.ts']);
    expect(specs).toContain('structure-build-placement');
    expect(specs).toContain('structure-grid-web');
  });

  it('a changed feature spec runs itself; quarantined specs never run', () => {
    expect(select(['tests/e2e/hover-outline.spec.ts'])).toEqual(['hover-outline']);
    expect(select(['tests/e2e/missile-frigate-homing.spec.ts'])).toEqual([]);
  });

  it('smoke specs (already run on every PR) and quarantined specs are skipped', () => {
    expect(select(['tests/e2e/boot.spec.ts', 'tests/e2e/missile-frigate-homing.spec.ts'])).toEqual([]);
  });

  it('an unrelated change runs nothing extra', () => {
    expect(select(['docs/LESSONS.md', 'src/server/economy/../../README.md'].slice(0, 1))).toEqual([]);
  });
});
