/**
 * Edge feel P4, the place pop: one tinted flash (even with particles off)
 * plus a ring of the tier's sparks flung evenly outward, gone in under half
 * a second; a later wreck flash from the same pool is white again.
 */
import { describe, it, expect } from 'vitest';
import { Container, type Graphics } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { PLACE_POP_SPARKS, WreckBreakFx } from './WreckBreakFx';

function fx(q: EffectQuality, particlesDisabled = false): { world: Container; f: WreckBreakFx } {
  const world = new Container();
  return { world, f: new WreckBreakFx(world, () => q, particlesDisabled) };
}

describe('WreckBreakFx.spawnPlacePop', () => {
  it('one flash + the tier\'s sparks', () => {
    for (const q of ['high', 'medium', 'low', 'minimal'] as const) {
      const { f } = fx(q);
      f.spawnPlacePop(0, 0, 30, 0x5fe0ff);
      expect(f.activeCount(), q).toBe(1 + PLACE_POP_SPARKS[q]);
    }
  });

  it('only the flash with particles off', () => {
    const { f } = fx('high', true);
    f.spawnPlacePop(0, 0, 30, 0x5fe0ff);
    expect(f.activeCount()).toBe(1);
  });

  it('the sparks make an even ring about the post and are gone within half a second', () => {
    const { f, world } = fx('high');
    f.spawnPlacePop(100, 50, 30, 0x5fe0ff);
    for (let i = 0; i < 12; i++) f.tick(1 / 60);
    const layer = world.children[0] as Container;
    const d: number[] = [];
    for (const c of layer.children) if (c.visible && c.scale.x < 10) d.push(Math.hypot(c.x - 100, c.y + 50));
    const sparks = d.filter((v) => v > 1);
    expect(sparks.length).toBe(PLACE_POP_SPARKS.high);
    expect(Math.max(...sparks) - Math.min(...sparks)).toBeLessThan(1e-6); // one ring radius
    expect(sparks[0]!).toBeGreaterThan(30); // past the post
    for (let i = 0; i < 18; i++) f.tick(1 / 60);
    expect(f.activeCount()).toBe(0);
    expect(world.children.length).toBe(0);
  });

  it('a wreck flash after a pop is white again', () => {
    const { f, world } = fx('high', true);
    for (let i = 0; i < 4; i++) f.spawnPlacePop(0, 0, 30, 0x5fe0ff); // every flash slot tinted
    f.spawnBurst(0, 0, { radius: 200 });
    const layer = world.children[0] as Container;
    const tints = layer.children.filter((c) => c.visible).map((c) => (c as Graphics).tint);
    expect(tints).toContain(0xffffff);
  });
});
