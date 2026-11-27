/**
 * Edge feel P4: each structure the player placed pops once as it lands
 * (in the structures slice AND drawn: a swarm pose), at its pose; another
 * player's build, one of ours far from the click and anything already there
 * before the send do not pop; a fence run's posts pop one by one.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { PlacePopTracker, nearSent } from './placePop.js';
import type { PendingPlacement } from './structurePlacementClient.js';

const ME = 'me';
function mirror(): RenderMirror {
  return { localPlayerId: ME, structures: new Map(), swarm: new Map(), pendingEffectTriggers: [] } as unknown as RenderMirror;
}
function land(m: RenderMirror, id: number, x: number, y: number, owner = ME, drawn = true): void {
  (m.structures as Map<number, unknown>).set(id, { owner });
  if (drawn) (m.swarm as Map<number, unknown>).set(id, { x, y });
}
function pending(x: number, y: number, run?: number[]): PendingPlacement {
  return { kind: 'shield_pylon', x, y, sentAtMs: 0, baselineStructureCount: 0, ...(run ? { run, sent: run.length / 2 } : {}) };
}
const pops = (m: RenderMirror) => m.pendingEffectTriggers!.filter((t) => t.kind === 'place-pop');

describe('place pop', () => {
  it('pops once when our structure lands at the sent point, at its pose', () => {
    const m = mirror(), t = new PlacePopTracker(), p = pending(500, 200);
    land(m, 1, 0, 0); // already there
    t.update(p, m);
    expect(pops(m)).toHaveLength(0);
    land(m, 2, 503, 198);
    t.update(p, m);
    t.update(p, m);
    expect(pops(m)).toHaveLength(1);
    expect(pops(m)[0]).toMatchObject({ worldX: 503, worldY: 198 });
    expect(pops(m)[0]!.radius).toBeGreaterThan(0);
  });

  it('waits for the swarm pose (drawn), then pops', () => {
    const m = mirror(), t = new PlacePopTracker(), p = pending(0, 0);
    t.update(p, m);
    land(m, 5, 0, 0, ME, false);
    t.update(p, m);
    expect(pops(m)).toHaveLength(0);
    (m.swarm as Map<number, unknown>).set(5, { x: 0, y: 0 });
    t.update(p, m);
    expect(pops(m)).toHaveLength(1);
  });

  it('no pop for another player\'s build or ours far from the click', () => {
    const m = mirror(), t = new PlacePopTracker(), p = pending(0, 0);
    t.update(p, m);
    land(m, 3, 0, 0, 'them');
    land(m, 4, 5000, 0);
    t.update(p, m);
    expect(pops(m)).toHaveLength(0);
  });

  it('a fence run pops each post as it lands, at the run corners', () => {
    const m = mirror(), t = new PlacePopTracker();
    const p = pending(400, 0, [0, 0, 200, 0, NaN, NaN, 400, 0]);
    t.update(p, m);
    land(m, 10, 0, 0); t.update(p, m);
    expect(pops(m)).toHaveLength(1);
    land(m, 11, 200, 0); land(m, 12, 400, 0); t.update(p, m);
    expect(pops(m)).toHaveLength(3);
  });

  it('a cleared record disarms: the next send treats what is there as old', () => {
    const m = mirror(), t = new PlacePopTracker();
    t.update(pending(0, 0), m);
    land(m, 1, 0, 0); t.update(pending(0, 0), m);
    t.update(null, m);
    const p2 = pending(0, 0);
    t.update(p2, m);
    t.update(p2, m);
    expect(pops(m)).toHaveLength(1);
  });

  it('nearSent skips the NaN break between clicks', () => {
    const p = pending(0, 0, [NaN, NaN, 100, 0]);
    expect(nearSent(p, 100, 1, 4)).toBe(true);
    expect(nearSent(p, 50, 0, 4)).toBe(false);
  });
});
