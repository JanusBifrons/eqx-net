/**
 * `EffectsService` smoke tests. Plan M1 deliverable.
 *
 * Validates the skeleton: construction, re-entrant `setContinuous`,
 * tier propagation via `getQuality`/`setQuality`, `resetForSectorHandoff`
 * clearing semantics, `effectsDisabledByUrl` escape hatch parsing.
 */

import { describe, expect, it } from 'vitest';
import { EffectsService, effectsDisabledByUrl } from './EffectsService';

function makeRefs(): import('./EffectsService').EffectStageRefs {
  return { app: {}, world: {}, stage: {}, camera: {} };
}

describe('EffectsService — skeleton (M1)', () => {
  it('constructs without touching refs', () => {
    const svc = new EffectsService(makeRefs());
    expect(svc.getQuality()).toBe('high');
    expect(svc.getStats().activeContinuous).toBe(0);
  });

  it('spawnBurst is a no-op in M1 (no throw, no observable counters)', () => {
    const svc = new EffectsService(makeRefs());
    svc.spawnBurst('impact', 100, 200);
    svc.spawnBurst('destruction', 0, 0, { intensity: 1.5 });
    expect(svc.getStats().activeBursts).toBe(0);
  });

  it('setContinuous is re-entrant — identical (id, kind, active) is a no-op', () => {
    const svc = new EffectsService(makeRefs());
    svc.setContinuous('ship-1', 'thrust', true);
    expect(svc.getStats().activeContinuous).toBe(1);
    svc.setContinuous('ship-1', 'thrust', true); // re-entrant
    expect(svc.getStats().activeContinuous).toBe(1);
  });

  it('setContinuous handles different kinds per entity independently', () => {
    const svc = new EffectsService(makeRefs());
    svc.setContinuous('ship-1', 'thrust', true);
    svc.setContinuous('ship-1', 'boost', true);
    svc.setContinuous('ship-1', 'shield', true);
    expect(svc.getStats().activeContinuous).toBe(3);
    svc.setContinuous('ship-1', 'boost', false);
    expect(svc.getStats().activeContinuous).toBe(2);
  });

  it('resetForSectorHandoff clears all continuous + counters', () => {
    const svc = new EffectsService(makeRefs());
    svc.setContinuous('ship-1', 'thrust', true);
    svc.setContinuous('ship-2', 'boost', true);
    expect(svc.getStats().activeContinuous).toBe(2);
    svc.resetForSectorHandoff();
    expect(svc.getStats().activeContinuous).toBe(0);
  });

  it('setQuality propagates to getQuality (pushed lower wins)', () => {
    const svc = new EffectsService(makeRefs());
    expect(svc.getQuality()).toBe('high');
    svc.setQuality('low');
    expect(svc.getQuality()).toBe('low');
  });

  it('tick advances the budget without throwing', () => {
    const svc = new EffectsService(makeRefs());
    for (let i = 0; i < 30; i++) svc.tick(performance.now(), 16.67);
    expect(svc.getQuality()).toBe('high');
  });
});

describe('effectsDisabledByUrl — escape hatch', () => {
  // jsdom provides window.location; node does not — feature-test before relying.
  const hasLocation = typeof globalThis !== 'undefined'
    && typeof (globalThis as { location?: unknown }).location !== 'undefined';

  it.skipIf(!hasLocation)('returns true when ?effects=0 is in the URL', () => {
    const orig = window.location.search;
    Object.defineProperty(window.location, 'search', { value: '?effects=0', configurable: true });
    try {
      expect(effectsDisabledByUrl()).toBe(true);
    } finally {
      Object.defineProperty(window.location, 'search', { value: orig, configurable: true });
    }
  });

  it.skipIf(!hasLocation)('returns false when ?effects=1 or absent', () => {
    const orig = window.location.search;
    Object.defineProperty(window.location, 'search', { value: '?effects=1&other=x', configurable: true });
    try {
      expect(effectsDisabledByUrl()).toBe(false);
    } finally {
      Object.defineProperty(window.location, 'search', { value: orig, configurable: true });
    }
  });

  it('handles missing location object (node)', () => {
    // The function should not throw even in node-like envs.
    expect(() => effectsDisabledByUrl()).not.toThrow();
  });
});
