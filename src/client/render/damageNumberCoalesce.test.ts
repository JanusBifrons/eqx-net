/**
 * Damage-number pile-up (owner review of the long-guns / fleet-melee
 * clips, docs/HANDOFF-2026-11-10.md Next #2; WS7.3 in
 * HANDOFF-consolidated-2026-11-09): "damage numbers pile up and linger" —
 * many overlapping numbers stacked on one target, smearing into dark
 * blocks inside fireballs. One bucket per targetId was not enough: a
 * packed melee / splash puts several targetIds under one screen spot, each
 * with its own black-stroked number drawn over the others.
 *
 * Lock: a new hit within MERGE_RADIUS_PX (screen px) of a live number
 * folds into it (summed), so one screen spot shows at most one number.
 */
import { describe, it, expect } from 'vitest';
import { Container, Text } from 'pixi.js';
import { findCoalesceIndex, MERGE_RADIUS_PX } from './damageNumberCoalesce.js';
import { DamageNumberManager, STAY_FRAMES, FADE_FRAMES } from './DamageNumbers.js';
import type { Camera } from './worker/Camera.js';

function pts(list: Array<[number, number]>): Array<{ curX: number; curY: number }> {
  return list.map(([x, y]) => ({ curX: x, curY: y }));
}

describe('findCoalesceIndex (pure)', () => {
  it('returns -1 when nothing is live', () => {
    expect(findCoalesceIndex([], 0, 0, 0, 30)).toBe(-1);
  });

  it('returns the live number within the radius', () => {
    expect(findCoalesceIndex(pts([[500, 500], [10, 5]]), 2, 0, 0, 30)).toBe(1);
  });

  it('returns -1 when every live number is outside the radius', () => {
    expect(findCoalesceIndex(pts([[31, 0], [0, -40]]), 2, 0, 0, 30)).toBe(-1);
  });

  it('picks the NEAREST of several in range', () => {
    expect(findCoalesceIndex(pts([[20, 0], [5, 5], [-15, 0]]), 3, 0, 0, 30)).toBe(1);
  });

  it('ignores entries past `count` (pooled array tail)', () => {
    expect(findCoalesceIndex(pts([[100, 0], [0, 0]]), 1, 0, 0, 30)).toBe(-1);
  });
});

function cam(scale: number): Camera {
  return { scale: { x: scale, y: scale } } as unknown as Camera;
}

describe('DamageNumberManager — one number per screen spot', () => {
  it('hits on DIFFERENT targets at the same spot fold into ONE summed number', () => {
    const parent = new Container();
    const mgr = new DamageNumberManager(parent, cam(1));
    for (let i = 0; i < 8; i++) mgr.spawn(`robot-${i}`, i * 2, 0, 10);
    expect(mgr.getActiveCount()).toBe(1);
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(1);
    expect((inner.children[0] as Text).text).toBe('80');
  });

  it('the merge radius is in SCREEN px: zoomed out, far-apart world hits still merge', () => {
    const mgr = new DamageNumberManager(new Container(), cam(0.1));
    // 100 world u at scale 0.1 = 10 screen px < MERGE_RADIUS_PX.
    mgr.spawn('a', 0, 0, 5);
    mgr.spawn('b', 100, 0, 5);
    expect(mgr.getActiveCount()).toBe(1);
    // Well clear on screen ⇒ its own number.
    mgr.spawn('c', (MERGE_RADIUS_PX * 3) / 0.1, 0, 5);
    expect(mgr.getActiveCount()).toBe(2);
  });

  it('later hits on a merged-in target keep folding into the same number', () => {
    const mgr = new DamageNumberManager(new Container(), cam(1));
    mgr.spawn('a', 0, 0, 5);
    mgr.spawn('b', 4, 0, 5);
    mgr.update();
    mgr.spawn('b', 6, 0, 5);
    expect(mgr.getActiveCount()).toBe(1);
  });

  it('cancelByTag still subtracts a tagged hit that merged into another target\'s number', () => {
    const parent = new Container();
    const mgr = new DamageNumberManager(parent, cam(1));
    mgr.spawn('a', 0, 0, 10);
    mgr.spawn('b', 3, 0, 7, 'shot-1');
    expect(mgr.cancelByTag('shot-1')).toBe(1);
    expect(((parent.children[0] as Container).children[0] as Text).text).toBe('10');
  });

  it('a single hit is gone within one second at 60 Hz', () => {
    expect(STAY_FRAMES + FADE_FRAMES).toBeLessThanOrEqual(60);
  });
});
