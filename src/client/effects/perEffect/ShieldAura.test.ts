/**
 * `ShieldAura` unit tests — plan M8 deliverable.
 *
 * Locks:
 *  - setActive registers/removes rings (re-entrant)
 *  - tier dial: high attaches GlowFilter to the container; medium drops it;
 *    minimal hides the container
 *  - hit pulse raises alpha then decays
 *  - getPose null hides ring (doesn't evict)
 *  - resetForSectorHandoff wipes all rings
 *
 * Failing test that locks "shielded ship spawns aura on join + on
 * SHIELD_RESTORED; aura removed on SHIELD_BROKEN" per the plan M8
 * deliverable. Reverting the M8 wiring in ColyseusClient + PixiRenderer
 * fails the integration story (covered separately); this file locks the
 * MANAGER's contract.
 */

import { describe, expect, it, vi } from 'vitest';
import { ShieldAura, type ShieldFactories } from './ShieldAura';

function makeStubGfx(): Record<string, unknown> {
  return { x: 0, y: 0, alpha: 0, visible: true, destroy: vi.fn() };
}

function makeStubContainer(): Record<string, unknown> {
  const children: unknown[] = [];
  return {
    visible: true,
    filters: null,
    addChild: vi.fn((c: unknown) => { children.push(c); return c; }),
    removeChild: vi.fn((c: unknown) => { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; }),
    children,
  };
}

function makeFactories(): ShieldFactories {
  return {
    makeRing: vi.fn(() => makeStubGfx() as never),
    makeGlowFilter: vi.fn(() => ({ outerStrength: 1, innerStrength: 1, quality: 0.15, color: 0xaaffff } as never)),
    makeContainer: vi.fn(() => makeStubContainer() as never),
  };
}

const POSE_AT_ORIGIN = () => ({ x: 0, y: 0, angle: 0 });

describe('ShieldAura — setActive', () => {
  it('registers and removes rings (re-entrant)', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    aura.setActive('ship-1', true);
    expect(aura.activeCount()).toBe(1);
    aura.setActive('ship-1', true);
    expect(aura.activeCount()).toBe(1);
    aura.setActive('ship-1', false);
    expect(aura.activeCount()).toBe(0);
  });
});

describe('ShieldAura — tier dial', () => {
  it('"high" attaches the GlowFilter to the container (lazy build)', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    const auraContainer = (parent.children as Record<string, unknown>[])[0]!;
    // Constructor starts at 'minimal' (no filter, hidden) — first explicit
    // applyQuality is what triggers the lazy filter build.
    aura.applyQuality('high');
    expect(Array.isArray(auraContainer.filters)).toBe(true);
    expect((auraContainer.filters as unknown[]).length).toBe(1);
    expect(auraContainer.visible).toBe(true);
    aura.applyQuality('medium');
    expect(auraContainer.filters).toBeNull();
  });

  it('default state after construct is "minimal" (container hidden, no filter)', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    const auraContainer = (parent.children as Record<string, unknown>[])[0]!;
    expect(auraContainer.visible).toBe(false);
    expect(auraContainer.filters).toBeNull();
    aura.applyQuality('minimal'); // re-apply minimal is idempotent
    expect(auraContainer.visible).toBe(false);
  });

  it('high → minimal → high cycles filter attach state', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    const auraContainer = (parent.children as Record<string, unknown>[])[0]!;
    aura.applyQuality('high');
    aura.applyQuality('minimal');
    expect(auraContainer.visible).toBe(false);
    aura.applyQuality('high');
    expect(auraContainer.visible).toBe(true);
    expect((auraContainer.filters as unknown[]).length).toBe(1);
  });
});

describe('ShieldAura — pulse + tick', () => {
  it('pulse raises ring alpha above base, decays back over ~250 ms', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    aura.applyQuality('high'); // activate the tick path
    aura.setActive('ship-1', true);
    aura.pulse('ship-1');
    aura.tick(16, POSE_AT_ORIGIN);
    const auraContainer = (parent.children as Record<string, unknown>[])[0]!;
    const ring = (auraContainer.children as Record<string, unknown>[])[0]!;
    expect((ring.alpha as number)).toBeGreaterThan(0.18);
    for (let i = 0; i < 25; i++) aura.tick(16, POSE_AT_ORIGIN);
    expect((ring.alpha as number)).toBeLessThan(0.30); // breathe wave may add a bit
  });

  it('pulse on an unregistered entity is a no-op', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    aura.applyQuality('high');
    expect(() => aura.pulse('absent')).not.toThrow();
  });

  it('hides ring (no evict) when getPose returns null', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    aura.applyQuality('high');
    aura.setActive('ship-1', true);
    aura.tick(16, () => null);
    expect(aura.activeCount()).toBe(1);
    const auraContainer = (parent.children as Record<string, unknown>[])[0]!;
    const ring = (auraContainer.children as Record<string, unknown>[])[0]!;
    expect(ring.visible).toBe(false);
  });
});

describe('ShieldAura — resetForSectorHandoff', () => {
  it('wipes all registered rings', () => {
    const parent = makeStubContainer();
    const aura = new ShieldAura(parent as never, () => 'high', makeFactories());
    aura.setActive('a', true);
    aura.setActive('b', true);
    aura.setActive('c', true);
    expect(aura.activeCount()).toBe(3);
    aura.resetForSectorHandoff();
    expect(aura.activeCount()).toBe(0);
  });
});
