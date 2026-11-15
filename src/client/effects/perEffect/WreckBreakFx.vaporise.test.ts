/**
 * The vaporise ash puff (fracture v11): a 'wreck-ash' burst with no line end
 * is a point puff of glowing ash where the hull was burned away, in the
 * weapon's tint, short, counts by the effects tier, none with particles off.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { WreckBreakFx, WRECK_ASH_DIAL } from './WreckBreakFx';

function fx(q: EffectQuality, particlesDisabled = false): { world: Container; f: WreckBreakFx } {
  const world = new Container();
  return { world, f: new WreckBreakFx(world, () => q, particlesDisabled) };
}

describe('WreckBreakFx.spawnVaporAsh', () => {
  it('the tier\'s ash count, no sparks or flash', () => {
    for (const q of ['high', 'medium', 'low', 'minimal'] as const) {
      const { f } = fx(q);
      f.spawnVaporAsh(0, 0, 24, 0xc8a8ff);
      expect(f.activeCount(), q).toBe(WRECK_ASH_DIAL[q].ash);
    }
  });

  it('none with particles off', () => {
    const { f, world } = fx('high', true);
    f.spawnVaporAsh(0, 0, 24, 0xc8a8ff);
    expect(f.activeCount()).toBe(0);
    expect(world.children.length).toBe(0);
  });

  it('spreads out about the hull and is gone within a second', () => {
    const { f, world } = fx('high');
    f.spawnVaporAsh(100, 50, 24, 0xc8a8ff);
    for (let i = 0; i < 20; i++) f.tick(1 / 60);
    const layer = world.children[0] as Container;
    let far = 0;
    for (const c of layer.children) if (c.visible && Math.hypot(c.x - 100, c.y + 50) > 12) far++;
    expect(far, 'the puff spreads to about the hull radius').toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) f.tick(1 / 60);
    expect(f.activeCount()).toBe(0);
    expect(world.children.length).toBe(0);
  });

  it('starts in the weapon tint, not the railgun channel\'s orange', () => {
    const { f, world } = fx('high');
    f.spawnVaporAsh(0, 0, 24, 0xc8a8ff);
    f.tick(1 / 60);
    const layer = world.children[0] as Container;
    const lit = layer.children.filter((c) => c.visible);
    for (const c of lit) {
      const t = (c as unknown as { tint: number }).tint;
      expect(t & 255, 'blue-dominant at first').toBeGreaterThanOrEqual((t >> 8) & 255);
    }
  });
});
