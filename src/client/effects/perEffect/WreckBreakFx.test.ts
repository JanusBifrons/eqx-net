/**
 * Capital destruction S3 — the break-up burst: a flash plus dust and shards,
 * counts capped by the effects tier, sized by the wreck, reused from one pool,
 * and off the stage once it has played out.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { WreckBreakFx, WRECK_BREAK_DIAL } from './WreckBreakFx';

function fx(q: EffectQuality, particlesDisabled = false): { world: Container; f: WreckBreakFx } {
  const world = new Container();
  return { world, f: new WreckBreakFx(world, () => q, particlesDisabled) };
}

describe('WreckBreakFx', () => {
  it('a burst is the flash plus the tier\'s dust and shards', () => {
    for (const q of ['high', 'medium', 'low', 'minimal'] as const) {
      const { f } = fx(q);
      f.spawnBurst(100, 200, { radius: 1500 });
      expect(f.activeCount(), q).toBe(1 + WRECK_BREAK_DIAL[q].dust + WRECK_BREAK_DIAL[q].shards);
    }
    expect(WRECK_BREAK_DIAL.minimal.dust + WRECK_BREAK_DIAL.minimal.shards)
      .toBeLessThan(WRECK_BREAK_DIAL.high.dust + WRECK_BREAK_DIAL.high.shards);
  });

  it('with particles off, only the flash plays', () => {
    const { f } = fx('high', true);
    f.spawnBurst(0, 0, { radius: 1500 });
    expect(f.activeCount()).toBe(1);
  });

  it('plays out, then leaves the stage (an idle pool adds no display objects)', () => {
    const { world, f } = fx('high');
    expect(world.children.length).toBe(0);
    f.spawnBurst(0, 0, { radius: 1500 });
    expect(world.children.length).toBe(1);
    for (let i = 0; i < 60 * 6; i++) f.tick(1 / 60);
    expect(f.activeCount()).toBe(0);
    expect(world.children.length).toBe(0);
  });

  it('many bursts reuse one bounded pool', () => {
    const { world, f } = fx('high');
    for (let i = 0; i < 10; i++) f.spawnBurst(i * 10, 0, { radius: 1500 });
    const layer = world.children[0] as Container;
    const size = layer.children.length;
    for (let i = 0; i < 10; i++) f.spawnBurst(i * 10, 0, { radius: 1500 });
    expect(layer.children.length).toBe(size);
    expect(f.activeCount()).toBeLessThanOrEqual(size);
  });
});
