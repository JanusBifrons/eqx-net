/**
 * WS-4 Phase 6 (R2.23 enabler) — the snapshot `asteroids[]` slice decodes into
 * the swarm mirror's `resources` / `resourcesMax` (the WS-9 inspector's
 * remaining-ore readout). The server emits an entry ONLY for a MINED rock, so
 * an absent slice is a no-op and an entry's presence is the "mined" signal.
 */
import { describe, it, expect } from 'vitest';
import { applyAsteroidResources } from './snapshotRemoteSync.js';
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '@shared-types/messages';

function asteroidEntry(): SwarmRenderState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 0 } as unknown as SwarmRenderState;
}

function mirrorWith(ids: number[]): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  for (const id of ids) swarm.set(id, asteroidEntry());
  return { swarm } as unknown as RenderMirror;
}

describe('applyAsteroidResources — asteroids[] → mirror resources (WS-4 Phase 6)', () => {
  it('mirrors a mined asteroid resources + resourcesMax by entityId', () => {
    const mirror = mirrorWith([10]);
    const snap = { asteroids: [{ id: 10, resources: 50, resourcesMax: 100 }] } as unknown as SnapshotMessage;
    applyAsteroidResources(snap, mirror);
    expect(mirror.swarm!.get(10)!.resources).toBe(50);
    expect(mirror.swarm!.get(10)!.resourcesMax).toBe(100);
  });

  it('no-ops when the slice is absent (untouched rock stays bare)', () => {
    const mirror = mirrorWith([10]);
    applyAsteroidResources({} as unknown as SnapshotMessage, mirror);
    expect(mirror.swarm!.get(10)!.resources).toBeUndefined();
    expect(mirror.swarm!.get(10)!.resourcesMax).toBeUndefined();
  });

  it('skips entries whose entityId is not in the mirror (out of interest)', () => {
    const mirror = mirrorWith([10]);
    const snap = { asteroids: [{ id: 99, resources: 5, resourcesMax: 100 }] } as unknown as SnapshotMessage;
    expect(() => applyAsteroidResources(snap, mirror)).not.toThrow();
    expect(mirror.swarm!.get(10)!.resources).toBeUndefined();
  });
});
