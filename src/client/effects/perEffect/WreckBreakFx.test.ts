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

  // Hostile film review 2026-11-15 (heavy-beam take 8): on a cut kill the
  // break-up read as "dozens of flat, saturated orange triangles, 8–15 px,
  // scattered widely … confetti" over the cut. On a cut kill the shards are
  // metal chips: fewer, smaller, mostly hull-dark, a few hot ones near the
  // cut. A kill without a cut keeps its burst.
  describe('a cut kill tones the shards down so the cut reads first', () => {
    const R = 2200;
    /** Shards live after `secs` (layer children 140..219 are the shard pool). */
    function shards(cutKill: boolean | undefined, secs: number): Array<{ x: number; y: number; size: number; tint: number }> {
      const { world, f } = fx('high');
      f.spawnBurst(0, 0, { radius: R, ...(cutKill === undefined ? {} : { cutKill }) });
      for (let i = 0; i < Math.round(secs * 60); i++) f.tick(1 / 60);
      const layer = world.children[0] as Container;
      const out: Array<{ x: number; y: number; size: number; tint: number }> = [];
      for (let i = 140; i < 220; i++) {
        const g = layer.children[i]!;
        if (!g.visible) continue;
        out.push({ x: g.x, y: g.y, size: g.scale.x, tint: (g as unknown as { tint: number }).tint });
      }
      return out;
    }
    const sat = (c: number): number => {
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const bright = (c: number): number => Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255);

    it('fewer and smaller shards than an un-cut burst', () => {
      const plain = shards(false, 0.1), cut = shards(true, 0.1);
      expect(plain.length).toBe(WRECK_BREAK_DIAL.high.shards);
      expect(shards(undefined, 0.1).length, 'no flag: unchanged').toBe(plain.length);
      expect(cut.length, 'fewer').toBeLessThanOrEqual(0.4 * plain.length);
      expect(cut.length).toBeGreaterThan(0);
      const mean = (a: Array<{ size: number }>): number => a.reduce((s, p) => s + p.size, 0) / a.length;
      expect(mean(cut), 'smaller').toBeLessThanOrEqual(0.6 * mean(plain));
    });

    it('mostly dark, hull-coloured metal chips, a few hot ones', () => {
      const cut = shards(true, 0.1);
      const hot = cut.filter((p) => sat(p.tint) > 0x60 && bright(p.tint) > 0xb0);
      expect(hot.length, 'a few hot chips').toBeGreaterThan(0);
      expect(hot.length, 'only a few hot').toBeLessThanOrEqual(Math.ceil(0.34 * cut.length));
      for (const p of cut) if (!hot.includes(p)) {
        expect(sat(p.tint), `chip 0x${p.tint.toString(16)}: grey metal, not saturated orange`).toBeLessThanOrEqual(0x30);
        expect(bright(p.tint), `chip 0x${p.tint.toString(16)}: darker than hot`).toBeLessThanOrEqual(0xa0);
      }
      // An un-cut burst keeps its hot orange shards.
      expect(shards(false, 0.1).every((p) => sat(p.tint) > 0x60)).toBe(true);
    });

    it('chips stay closer to the cut than an un-cut burst\'s shards (not scattered widely)', () => {
      const far = (a: Array<{ x: number; y: number }>): number => Math.max(...a.map((p) => Math.hypot(p.x, p.y)));
      const cut = shards(true, 1), plain = shards(false, 1);
      expect(far(cut)).toBeLessThanOrEqual(0.6 * far(plain));
      // The hot ones stay nearest the cut.
      const hot = cut.filter((p) => sat(p.tint) > 0x40 && bright(p.tint) > 0x90);
      if (hot.length > 0) expect(far(hot)).toBeLessThanOrEqual(0.5 * far(cut) + 1e-6);
    });
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
