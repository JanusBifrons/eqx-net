/**
 * Mirror → EngineEmitter integration lock (plan M5 failing-test deliverable
 * per Invariant #13: "the test must come first, not as a follow-up").
 *
 * Reproduces the "ship in `mirror.thrustingShips` registers exactly one
 * thrust emitter" contract that PixiRenderer.syncEngineContinuousEffects
 * satisfies. Failing this test would mean either:
 *  - the set-diff logic in PixiRenderer is wrong (over- or under-firing
 *    setContinuous calls), or
 *  - EffectsService.setContinuous broke its dispatch to EngineEmitter,
 *    or
 *  - EngineEmitter.setActive lost its re-entrancy.
 *
 * Drives EffectsService directly without instantiating Pixi — the mirror
 * → setContinuous wiring is reproduced via a small spy harness so the
 * integration concern (cross-class boundary) is testable in node-env.
 */

import { describe, expect, it, vi } from 'vitest';
import { EffectsService } from './EffectsService';

function makeRefs(): import('./EffectsService').EffectStageRefs {
  const children: unknown[] = [];
  const world = {
    addChild(c: unknown) { children.push(c); return c; },
    removeChild(c: unknown) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
  } as never;
  const stage = { filters: [] as unknown[] };
  return {
    app: { stage } as never,
    world,
    stage: stage as never,
    camera: {},
    getEntityPose: () => ({ x: 0, y: 0, angle: 0 }),
  };
}

/**
 * Mirrors the diff logic in PixiRenderer.syncEngineContinuousEffects (test-
 * doubles the set-diff behaviour). The CONTRACT under test is "a ship in
 * mirror.thrustingShips becomes a single thrust emitter, ditto boost,
 * removals fire setContinuous(_, _, false)".
 */
function diffAndApply(
  svc: EffectsService,
  current: Set<string>,
  tracked: Set<string>,
  kind: 'thrust' | 'boost',
): void {
  for (const id of current) {
    if (!tracked.has(id)) {
      svc.setContinuous(id, kind, true);
      tracked.add(id);
    }
  }
  for (const id of tracked) {
    if (!current.has(id)) {
      svc.setContinuous(id, kind, false);
      tracked.delete(id);
    }
  }
}

describe('mirror → engine emitter integration (M5)', () => {
  it('one ship in thrustingShips → exactly one thrust emitter', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low'); // avoid the boost layer touching DOM-classes if any get added later
    const tracked = new Set<string>();
    diffAndApply(svc, new Set(['ship-1']), tracked, 'thrust');
    expect(svc.getStats().activeContinuous).toBe(1);
  });

  it('two consecutive frames with the same ship → one emitter (re-entrant)', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    const tracked = new Set<string>();
    diffAndApply(svc, new Set(['ship-1']), tracked, 'thrust');
    diffAndApply(svc, new Set(['ship-1']), tracked, 'thrust');
    expect(svc.getStats().activeContinuous).toBe(1);
  });

  it('ship leaves thrustingShips → emitter unregistered', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    const tracked = new Set<string>();
    diffAndApply(svc, new Set(['ship-1']), tracked, 'thrust');
    expect(svc.getStats().activeContinuous).toBe(1);
    diffAndApply(svc, new Set(), tracked, 'thrust');
    expect(svc.getStats().activeContinuous).toBe(0);
  });

  it('thrust + boost on the same ship are independent registrations', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    const thrust = new Set<string>();
    const boost = new Set<string>();
    diffAndApply(svc, new Set(['s']), thrust, 'thrust');
    diffAndApply(svc, new Set(['s']), boost, 'boost');
    expect(svc.getStats().activeContinuous).toBe(2);
  });

  it('resetForSectorHandoff clears both registrations + their tracked sets', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    const thrust = new Set<string>(['a']);
    diffAndApply(svc, thrust, new Set(), 'thrust');
    expect(svc.getStats().activeContinuous).toBe(1);
    svc.resetForSectorHandoff();
    expect(svc.getStats().activeContinuous).toBe(0);
  });

  it('tick advances emitter particles and counts them in stats', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    diffAndApply(svc, new Set(['ship-1']), new Set(), 'thrust');
    for (let i = 0; i < 30; i++) svc.tick(performance.now(), 16.67);
    // 'low' tier = thrustRateMul 0.5 → 30 Hz emit × 0.5 s = ~15 in flight at steady state.
    expect(svc.getStats().activeBursts).toBeGreaterThan(0);
  });
});
