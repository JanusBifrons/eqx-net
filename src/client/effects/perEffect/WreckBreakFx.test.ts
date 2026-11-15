/**
 * Capital destruction S3 — the break-up burst: a flash plus dust and shards,
 * counts capped by the effects tier, sized by the wreck, reused from one pool,
 * and off the stage once it has played out.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { WreckBreakFx, WRECK_BREAK_DIAL, WRECK_ASH_DIAL } from './WreckBreakFx';

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

  it('the flash is a short, small bright core, not a hull-covering disc (money-shot review)', () => {
    // The review: "a large flat white translucent disc plus a grey halo
    // covers the mid-hull for ~3 frames". The core flash must stay a small
    // fraction of the wreck's radius and be gone in about a quarter second.
    const R = 2200; // heavy cruiser (2×) wreck radius
    const { world, f } = fx('high', true);
    f.spawnBurst(0, 0, { radius: R });
    const layer = world.children[0] as Container;
    let maxExtent = 0;
    let frames = 0;
    for (let i = 0; i < 60; i++) {
      f.tick(1 / 60);
      for (const c of layer.children) {
        if (!c.visible || c.alpha <= 0.02) continue;
        maxExtent = Math.max(maxExtent, c.getLocalBounds().maxX * c.scale.x);
      }
      if (f.activeCount() > 0) frames++;
    }
    expect(maxExtent, 'flash radius (world u)').toBeLessThan(0.15 * R);
    expect(frames, 'flash frames at 60 Hz').toBeLessThanOrEqual(16);
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

describe('WreckBreakFx channel ash (a railgun channel kill)', () => {
  const R = 2200;
  // Game space (Y up): the channel runs from (0, 0) to (1000, 0).
  const A = { x: 0, y: 0 }, B = { x: 1000, y: 0 };

  it('the tier\'s ash and sparks, from the same pool; none with particles off', () => {
    for (const q of ['high', 'medium', 'low', 'minimal'] as const) {
      const { f } = fx(q);
      f.spawnChannelAsh(A.x, A.y, B.x, B.y, R);
      expect(f.activeCount(), q).toBe(WRECK_ASH_DIAL[q].ash + WRECK_ASH_DIAL[q].sparks);
    }
    expect(WRECK_ASH_DIAL.minimal.ash + WRECK_ASH_DIAL.minimal.sparks)
      .toBeLessThan(WRECK_ASH_DIAL.high.ash + WRECK_ASH_DIAL.high.sparks);
    const off = fx('high', true);
    off.f.spawnChannelAsh(A.x, A.y, B.x, B.y, R);
    expect(off.f.activeCount()).toBe(0);
    expect(off.world.children.length, 'no pool, nothing on stage').toBe(0);
  });

  it('is a LINE emitter: the ash starts spread along the whole channel, on it', () => {
    const { world, f } = fx('high');
    f.spawnChannelAsh(A.x, A.y, B.x, B.y, R);
    const layer = world.children[0] as Container;
    const xs: number[] = [];
    for (const c of layer.children) {
      if (!c.visible) continue;
      // Pixi space: y = -gameY; the channel lies on y = 0.
      expect(Math.abs(c.position.y)).toBeLessThan(1e-6);
      expect(c.position.x).toBeGreaterThanOrEqual(-1e-6);
      expect(c.position.x).toBeLessThanOrEqual(1000 + 1e-6);
      xs.push(c.position.x);
    }
    // Ash along the line (not a point burst): both halves of the channel.
    expect(xs.filter((x) => x < 400).length).toBeGreaterThan(5);
    expect(xs.filter((x) => x > 600).length).toBeGreaterThan(5);
  });

  it('ash glows white-hot first and cools; sparks fly on out of the far end; then it leaves the stage', () => {
    const { world, f } = fx('high');
    f.spawnChannelAsh(A.x, A.y, B.x, B.y, R);
    const layer = world.children[0] as Container;
    f.tick(1 / 60);
    const tints = layer.children.filter((c) => c.visible).map((c) => (c as unknown as { tint: number }).tint);
    const whiteHot = tints.filter((t) => ((t >> 16) & 255) > 0xf0 && ((t >> 8) & 255) > 0xd0 && (t & 255) > 0xa0);
    expect(whiteHot.length, 'fresh ash is white-hot').toBeGreaterThan(WRECK_ASH_DIAL.high.ash / 2);
    for (let i = 0; i < 20; i++) f.tick(1 / 60);
    // Sparks (beyond the far end) went on in the slug's direction (+x).
    const beyond = layer.children.filter((c) => c.visible && c.position.x > 1000);
    expect(beyond.length).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 4; i++) f.tick(1 / 60);
    expect(f.activeCount()).toBe(0);
    expect(world.children.length).toBe(0);
  });
});
