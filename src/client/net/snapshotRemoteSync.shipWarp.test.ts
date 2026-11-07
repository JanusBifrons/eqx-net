/**
 * Phase 4 warp-to (#16): the snapshot `states[].warp` (1 spool, 2 run; absent
 * = idle) decodes onto `mirror.ships[id].warp`, so every client can draw a
 * ship's warp build-up and run. Absent clears a stale phase.
 */
import { describe, it, expect } from 'vitest';
import { applyShipWarp } from './snapshotRemoteSync.js';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';

function mirrorWith(ids: string[]): RenderMirror {
  const ships = new Map<string, ShipRenderState>();
  for (const id of ids) ships.set(id, { x: 0, y: 0, vx: 0, vy: 0, angle: 0 } as ShipRenderState);
  return { ships } as unknown as RenderMirror;
}
const snap = (states: Record<string, { warp?: 1 | 2 }>) => ({ states }) as unknown as SnapshotMessage;

describe('applyShipWarp — states[].warp → mirror.ships[id].warp', () => {
  it('mirrors spool then run', () => {
    const m = mirrorWith(['p1']);
    applyShipWarp(snap({ p1: { warp: 1 } }), m);
    expect(m.ships.get('p1')!.warp).toBe(1);
    applyShipWarp(snap({ p1: { warp: 2 } }), m);
    expect(m.ships.get('p1')!.warp).toBe(2);
  });
  it('clears the phase when the wire omits it (idle)', () => {
    const m = mirrorWith(['p1']);
    m.ships.get('p1')!.warp = 2;
    applyShipWarp(snap({ p1: {} }), m);
    expect(m.ships.get('p1')!.warp).toBeUndefined();
  });
  it('ignores states for ships not in the mirror', () => {
    const m = mirrorWith([]);
    applyShipWarp(snap({ ghost: { warp: 1 } }), m);
    expect(m.ships.size).toBe(0);
  });
});
