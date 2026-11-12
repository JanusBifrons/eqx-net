/**
 * New explosions and missile smoke (plan iridescent-seeking-rainbow v3, B4).
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { blastRadiusFor, fireballLife, FxExplosions, FxMissileTrails } from './FxExplosions.js';
import { getShipKind } from '../../../../shared-types/shipKinds.js';

function fakeArt(ready = true): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: ready ? 'ready' : 'pending', ship: null, struct: null,
    fx: ready ? { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } : null });
  return { fx: () => h() } as unknown as ArtService;
}

describe('blast sizing', () => {
  it('scales with the dying sprite, within limits', () => {
    expect(blastRadiusFor(10)).toBe(34);
    expect(blastRadiusFor(100)).toBeCloseTo(110);
    // Fighters, frigates and cruisers keep the 280 cap.
    expect(blastRadiusFor(500)).toBe(280);
    expect(fireballLife(280)).toBeGreaterThan(fireballLife(40));
  });

  /**
   * Hostile review of the filmed `showcase-capital-duel` clip (2026-11-12): a
   * player's heavy cruiser died to the battleship and left "a small fireball
   * much smaller than the ship". The blast was capped at a fixed 280 u while
   * the cruiser is ~4,400 u long (invariant #18: a fixed size is a bug at any
   * other size). A capital's death blast must cover its hull.
   */
  it('a capital going up covers its hull, not a fighter-sized puff', () => {
    for (const id of ['destroyer', 'heavy-cruiser', 'battleship']) {
      const r = getShipKind(id).radius;
      expect(blastRadiusFor(2 * r), id).toBeGreaterThanOrEqual(r);
    }
  });
});

describe('FxExplosions', () => {
  it('does nothing until its textures are ready (the caller keeps today\'s effect)', () => {
    const fx = new FxExplosions(fakeArt(false), () => 'high');
    expect(fx.spawn(0, 0, 50, 0)).toBe(false);
  });

  it('plays a burst and frees it after its life', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    expect(fx.spawn(0, 0, 100, 1000)).toBe(true);
    fx.tick(1100);
    expect(fx.activeCount()).toBe(1);
    expect(fx.fireLayer.children.some((c) => c.visible)).toBe(true);
    fx.tick(1000 + 3500);
    expect(fx.activeCount()).toBe(0);
    expect(fx.fireLayer.children.every((c) => !c.visible)).toBe(true);
  });

  it('pools bursts: at most 24 alive, the oldest is reused', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    for (let i = 0; i < 30; i++) fx.spawn(i, 0, 60, 1000 + i);
    fx.tick(1040);
    expect(fx.activeCount()).toBe(24);
    const kids = fx.fireLayer.children.length;
    for (let i = 0; i < 30; i++) fx.spawn(i, 0, 60, 2000 + i);
    expect(fx.fireLayer.children.length).toBe(kids);
  });

  it('low quality drops the smoke', () => {
    const fx = new FxExplosions(fakeArt(), () => 'low');
    fx.spawn(0, 0, 100, 0);
    fx.tick(500);
    expect(fx.smokeLayer.children.every((c) => !c.visible)).toBe(true);
  });
});

describe('FxMissileTrails', () => {
  it('gives each missile a ribbon and releases it when the missile is gone', () => {
    const t = new FxMissileTrails(fakeArt());
    for (let f = 0; f < 10; f++) { t.beginFrame(); t.draw(1, f * 10, 0, 0, f * 16); t.draw(2, 0, f * 10, 1, f * 16); t.endFrame(); }
    expect(t.liveCount()).toBe(2);
    t.beginFrame(); t.draw(2, 0, 100, 1, 200); t.endFrame();
    expect(t.liveCount()).toBe(1);
    const ropes = t.smokeLayer.children.length;
    t.beginFrame(); t.draw(3, 0, 0, 0, 220); t.draw(2, 0, 110, 1, 220); t.endFrame();
    expect(t.smokeLayer.children.length).toBe(ropes); // missile 3 took 1's ribbon
  });
});
