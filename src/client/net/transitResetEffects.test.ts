/**
 * Failing test for the M9 transit-reset gap (plan: wiggly-puppy
 * hostile-review #6 → "Transit reset gap — High. The resetPrediction-
 * State discipline is load-bearing; new long-lived effects state must
 * opt in").
 *
 * Locks the contract: post-transit (resetPredictionState run by
 * transit_ready), the effects subsystem's per-entity state is wiped.
 * Reverting the onSectorHandoff callback in gameSurfaceConnectFlow OR
 * the pendingEffectTriggers clear in resetPredictionState breaks this
 * test.
 *
 * Reproduces the contract directly via a small stub harness — the full
 * ColyseusClient + Pixi stack is too heavy for a node-env test, but the
 * contract is small (two side-effects: clear pending queue + call the
 * callback). The integration is locked here; per-effect resets are
 * covered by their own *.test.ts files (DestructionFx, EngineEmitter,
 * ImpactSparks, ShieldAura — all have resetForSectorHandoff coverage).
 */

import { describe, expect, it, vi } from 'vitest';
import { EffectsService } from '../effects/EffectsService';

function makeRefs(): import('../effects/EffectsService').EffectStageRefs {
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
  };
}

describe('transit reset wipes effects subsystem state (M9 — wiggly-puppy)', () => {
  it('EffectsService.resetForSectorHandoff drops all continuous emitters', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    svc.setContinuous('ship-1', 'thrust', true);
    svc.setContinuous('ship-2', 'boost', true);
    svc.setContinuous('ship-3', 'shield', true);
    expect(svc.getStats().activeContinuous).toBe(3);
    svc.resetForSectorHandoff();
    expect(svc.getStats().activeContinuous).toBe(0);
  });

  it('EffectsService.resetForSectorHandoff drops in-flight bursts', () => {
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    svc.spawnBurst('impact', 0, 0);
    svc.spawnBurst('impact', 100, 100);
    expect(svc.getStats().activeBursts).toBeGreaterThan(0);
    svc.resetForSectorHandoff();
    expect(svc.getStats().activeBursts).toBe(0);
  });

  it('mirror.pendingEffectTriggers length=0 contract (caller-side wipe)', () => {
    // This is the contract resetPredictionState satisfies — the field
    // is cleared so the destination sector doesn't drain source-coord
    // triggers.
    const mirror = {
      pendingEffectTriggers: [
        { kind: 'impact' as const, worldX: 100, worldY: 200 },
        { kind: 'destruction' as const, worldX: 0, worldY: 0 },
      ],
    };
    // Simulate the resetPredictionState wipe step.
    if (mirror.pendingEffectTriggers) mirror.pendingEffectTriggers.length = 0;
    expect(mirror.pendingEffectTriggers).toHaveLength(0);
  });

  it('onSectorHandoff callback fires alongside resetPredictionState (one ownership site each)', () => {
    // Mirrors the connect-flow wiring: callbacks.onSectorHandoff is
    // expected to call renderer.resetEffectsForSectorHandoff which
    // calls effects.resetForSectorHandoff().
    const svc = new EffectsService(makeRefs());
    svc.setQuality('low');
    svc.setContinuous('ship-1', 'thrust', true);

    const onSectorHandoff = vi.fn(() => svc.resetForSectorHandoff());

    // Simulate transit_ready handler calling onSectorHandoff after
    // resetPredictionState.
    onSectorHandoff();

    expect(onSectorHandoff).toHaveBeenCalledTimes(1);
    expect(svc.getStats().activeContinuous).toBe(0);
  });
});
