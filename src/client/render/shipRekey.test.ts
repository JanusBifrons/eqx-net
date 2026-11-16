/**
 * RTS Part A — seamless take controls, the renderer side.
 *
 * A ship's mirror key changes when someone takes or lets go of its controls.
 * The renderer keys every per-ship object by mirror key, so before the fix a
 * re-key meant: the sprite pass found no sprite under the new key and built a
 * new one (new art handle, new turret cluster, recoil and angles reset), and
 * the sweep destroyed the old one. These lock the "move, don't rebuild"
 * operation each manager now has, driven through the REAL sprite pass
 * (`updateShipSprites`), plus the pure helpers.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import { forEachShipRekey, moveKey, moveSetKey } from './shipRekey.js';
import { MountVisualManager } from './MountVisualManager.js';
import { HealthBarManager } from './HealthBars.js';
import { LabelManager } from './Labels.js';
import { FarZoomIcons } from './pixi/FarZoomIcons.js';
import { updateShipSprites, type ShipSpriteCtx } from './pixi/shipSpriteUpdater.js';

function mirrorWith(key: string, ship: ShipRenderState): RenderMirror {
  return { ships: new Map([[key, ship]]), localPlayerId: 'p-me' } as unknown as RenderMirror;
}

function ctxFor(): ShipSpriteCtx & { sprites: Map<string, Container> } {
  return {
    shipContainer: new Container(),
    sprites: new Map(),
    art: { art: null, handles: new Map(), sunAz: 0 },
    mountVisuals: new MountVisualManager(),
    remoteHitTargets: new Set(),
    localHitTargets: new Set(),
    seenScratch: new Set(),
  };
}

describe('moveKey / moveSetKey / forEachShipRekey', () => {
  it('moves an entry and hands back what it displaced', () => {
    const m = new Map([['a', 1], ['b', 2]]);
    expect(moveKey(m, 'a', 'b')).toBe(2);
    expect([...m]).toEqual([['b', 1]]);
    expect(moveKey(m, 'zz', 'b'), 'nothing to move').toBeUndefined();
    expect(m.get('b')).toBe(1);
    expect(moveKey(m, 'b', 'b')).toBeUndefined();
  });
  it('moves set membership', () => {
    const s = new Set(['a']);
    expect(moveSetKey(s, 'a', 'b')).toBe(true);
    expect([...s]).toEqual(['b']);
    expect(moveSetKey(s, 'a', 'c')).toBe(false);
  });
  it('visits flat pairs in order', () => {
    const seen: string[] = [];
    forEachShipRekey(['s1', 'p1', 'p2', 's2'], (f, t) => seen.push(`${f}>${t}`));
    expect(seen).toEqual(['s1>p1', 'p2>s2']);
    forEachShipRekey(undefined, () => seen.push('x'));
    expect(seen).toHaveLength(2);
  });
});

describe('the sprite pass keeps a re-keyed ship (no rebuild)', () => {
  const hull = (): ShipRenderState => ({ x: 10, y: 20, vx: 0, vy: 0, angle: 0, kind: 'heavy-cruiser', mountAngles: [0.3, -0.2] });

  it('with the move: same sprite, same turret cluster, nothing under the old key', () => {
    const ctx = ctxFor();
    const ship = hull();
    updateShipSprites(mirrorWith('ship-1', ship), ctx);
    const sprite = ctx.sprites.get('ship-1')!;
    const cluster = ctx.mountVisuals.clusterOf('ship-1')!;
    expect(cluster).toBeDefined();

    // Take controls: the entry is now under the pilot's playerId.
    moveKey(ctx.sprites, 'ship-1', 'p-me');
    moveKey(ctx.art.handles, 'ship-1', 'p-me');
    ctx.mountVisuals.rekeyShip('ship-1', 'p-me');
    ctx.seenScratch.clear();
    updateShipSprites(mirrorWith('p-me', ship), ctx);

    expect(ctx.sprites.get('p-me'), 'the same sprite object').toBe(sprite);
    expect(ctx.mountVisuals.clusterOf('p-me'), 'the same turret cluster').toBe(cluster);
    expect(cluster.parent, 'still on the same hull').toBe(sprite);
    expect(cluster.destroyed).toBe(false);
    expect(ctx.sprites.has('ship-1')).toBe(false);
    expect(ctx.mountVisuals.clusterOf('ship-1')).toBeUndefined();
    expect(ctx.shipContainer.children.filter((c) => c === sprite)).toHaveLength(1);
  });

  it('contrast: without the move the pass builds a second sprite and cluster (the flicker)', () => {
    const ctx = ctxFor();
    const ship = hull();
    updateShipSprites(mirrorWith('ship-1', ship), ctx);
    const sprite = ctx.sprites.get('ship-1')!;
    ctx.seenScratch.clear();
    updateShipSprites(mirrorWith('p-me', ship), ctx);
    expect(ctx.sprites.get('p-me')).not.toBe(sprite);
  });

  it('a stale cluster under the new key is freed, the moved one kept', () => {
    const mv = new MountVisualManager();
    const a = new Container(), b = new Container();
    const kept = mv.ensureForShip('ship-1', 'heavy-cruiser', a);
    const stale = mv.ensureForShip('p-me', 'heavy-cruiser', b);
    mv.rekeyShip('ship-1', 'p-me');
    expect(mv.clusterOf('p-me')).toBe(kept);
    expect(stale.destroyed).toBe(true);
    mv.rekeyShip('nobody', 'p-me');
    expect(mv.clusterOf('p-me'), 'no-op without a cluster to move').toBe(kept);
  });
});

describe('per-ship overlays move with the ship', () => {
  it('HealthBarManager: the bar (fill, chip, fade timer) moves; it keeps tracking the ship', () => {
    const parent = new Container();
    const bars = new HealthBarManager(parent);
    bars.onHit('ship-1', 0.4, 0.2, 0.6);
    bars.rekey('ship-1', 'p-me');
    expect(bars.hasBar('ship-1')).toBe(false);
    expect(bars.hasBar('p-me')).toBe(true);
    bars.update(mirrorWith('p-me', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }));
    expect(bars.hasBar('p-me'), 'still drawn over the ship under its new key').toBe(true);
  });

  it('LabelManager: the label moves (no destroy + re-create of its text)', () => {
    const labels = new LabelManager(new Container());
    const m = mirrorWith('p-b', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, displayName: 'Bee', ownerPlayerId: 'p-b', isActive: true });
    labels.update(m);
    const map = (labels as unknown as { labels: Map<string, { text: Container }> }).labels;
    const text = map.get('p:p-b')?.text;
    expect(text).toBeDefined();
    labels.rekey('p-b', 'ship-b');
    expect(map.get('p:ship-b')?.text).toBe(text);
    expect(text!.destroyed).toBe(false);
  });

  it('FarZoomIcons: a re-keyed ship is never left hidden behind a dropped icon', () => {
    const icons = new FarZoomIcons();
    const sprite = new Container();
    const m = mirrorWith('p-me', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' });
    // Far enough out that the fighter is drawn as an icon only.
    icons.update(m, new Map([['p-me', sprite]]), 0.001);
    expect(sprite.renderable).toBe(false);
    icons.forgetShip('p-me', sprite);
    expect(sprite.renderable, 'the moved sprite draws again until its new key re-applies an icon').toBe(true);
  });
});
