/**
 * Owner, flying a lance battlecruiser at a wreck: "the beam goes behind the
 * barrels" and "there is some sort of invisible shield it's hitting".
 *
 * One cause: the pilot's OWN beam was drawn from a fixed 20 u off the mount
 * pivot, while the client ray that measures `mirror.liveBeams[m].dist` (and
 * the server's fire ray) leave the shared barrel tip (`shipShotMuzzle`,
 * 445 u on a lance main). So the drawn beam started inside the gunhouse,
 * under the barrel, and ended 425 u SHORT of what the ray hit: empty space
 * in front of the wreck, like an invisible shield.
 *
 * Locks: the drawn line starts at the shared muzzle (the point the client
 * ray is cast from) and ends exactly `dist` beyond it (the ray's hit).
 */
import { describe, it, expect } from 'vitest';
import { liveBeamLine, findMount, type RemoteBeamLine } from './beamStyles';
import { getShipKind } from '../../shared-types/shipKinds';
import { shipShotMuzzle } from '../../core/combat/muzzle';

const out: RemoteBeamLine = { fromX: 0, fromY: 0, toX: 0, toY: 0 };

function expected(kindId: string, mountId: string, x: number, y: number, a: number, ma: number, dist: number) {
  const kind = getShipKind(kindId);
  const m = findMount(kind.mounts, mountId)!;
  const c = Math.cos(a), s = Math.sin(a);
  const px = x + m.localX * c - m.localY * s, py = y + m.localX * s + m.localY * c;
  const fa = a + m.baseAngle + ma, fx = -Math.sin(fa), fy = Math.cos(fa);
  const d = shipShotMuzzle(kind, m);
  return { kind, m, d, fromX: px + fx * d, fromY: py + fy * d, toX: px + fx * (d + dist), toY: py + fy * (d + dist) };
}

describe('liveBeamLine — the pilot\'s own beam leaves the barrel tip', () => {
  it('lance main-1: starts at the shared muzzle (beyond the barrel), not 20 u off the pivot', () => {
    const e = expected('battlecruiser-lance', 'main-1', 1000, -500, 0.7, -0.4, 6000);
    expect(e.d).toBeGreaterThan(100); // fixture: a capital barrel tip is far past 20 u
    liveBeamLine(e.kind, e.m, 1000, -500, 0.7, -0.4, 6000, out);
    expect(out.fromX).toBeCloseTo(e.fromX, 6);
    expect(out.fromY).toBeCloseTo(e.fromY, 6);
  });

  it('lance main-1: ends where the client ray stopped (muzzle + dist), not short of it', () => {
    const e = expected('battlecruiser-lance', 'main-1', 1000, -500, 0.7, -0.4, 6000);
    liveBeamLine(e.kind, e.m, 1000, -500, 0.7, -0.4, 6000, out);
    expect(out.toX).toBeCloseTo(e.toX, 6);
    expect(out.toY).toBeCloseTo(e.toY, 6);
  });

  it('a fighter\'s nose turret starts at its barrel tip too', () => {
    const kind = getShipKind('fighter');
    const m = kind.mounts![0]!;
    const e = expected('fighter', m.id, 50, 60, 1.2, 0, 300);
    liveBeamLine(kind, m, 50, 60, 1.2, 0, 300, out);
    expect(out.fromX).toBeCloseTo(e.fromX, 6);
    expect(out.toY).toBeCloseTo(e.toY, 6);
  });
});
