/**
 * Part C — the snapshot `drones[].hp` percent decodes into the swarm mirror's
 * `healthFrac` (0..1) that feeds the health-weighted player turret aim.
 * Absent `hp` ⇒ full (1), since the server omits it for undamaged drones.
 */
import { describe, it, expect } from 'vitest';
import { applyDroneMountAngles } from './snapshotRemoteSync.js';
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';

function swEntry(): SwarmRenderState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 1 } as unknown as SwarmRenderState;
}

function mirrorWith(ids: number[]): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  for (const id of ids) swarm.set(id, swEntry());
  return { swarm } as unknown as RenderMirror;
}

describe('applyDroneMountAngles — hp → healthFrac (Part C)', () => {
  it('decodes a damaged drone hp percent into a 0..1 fraction', () => {
    const mirror = mirrorWith([7]);
    const snap = { drones: [{ id: 7, hp: 20 }] } as unknown as SnapshotMessage;
    applyDroneMountAngles(snap, mirror);
    expect(mirror.swarm!.get(7)!.healthFrac).toBeCloseTo(0.2, 6);
  });

  it('treats an entry WITHOUT hp as full health (1)', () => {
    const mirror = mirrorWith([7]);
    // Entry present (e.g. for shieldDown) but hp omitted ⇒ full.
    const snap = { drones: [{ id: 7, shieldDown: true }] } as unknown as SnapshotMessage;
    applyDroneMountAngles(snap, mirror);
    expect(mirror.swarm!.get(7)!.healthFrac).toBe(1);
    expect(mirror.swarm!.get(7)!.shieldDown).toBe(true);
  });

  it('no-ops when the slice is absent', () => {
    const mirror = mirrorWith([7]);
    applyDroneMountAngles({} as unknown as SnapshotMessage, mirror);
    expect(mirror.swarm!.get(7)!.healthFrac).toBeUndefined();
  });
});
