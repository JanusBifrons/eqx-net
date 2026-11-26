/**
 * Readable construction (`?buildRing`, default on): the blueprint's small fill bar is
 * dropped while the hologram's progress ring shows the fraction; flag off, the
 * bar draws as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

function entry(shipKind: string): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0, radius: getStructureKind(shipKind).radius, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

/** Rects drawn on the per-frame layer for one unbuilt solar panel. */
function rectsDrawn(buildRing: boolean): number {
  const swarm = new Map<number, SwarmRenderState>([[1, entry('solar')]]);
  const st: StructureRenderState = { powered: true, netPower: 0, connTo: [], built: false, buildPct: 0.4, deconstructPct: 0 };
  const mirror = { swarm, structures: new Map([[1, st]]) } as unknown as RenderMirror;
  const r = new ConnectorRenderer();
  r.buildRing = buildRing;
  const spy = vi.spyOn(r.gfx, 'rect');
  r.update(mirror, 1, 0);
  return spy.mock.calls.length;
}

describe('ConnectorRenderer build bar vs the build ring', () => {
  it('flag off: the fill bar draws (track + fill)', () => {
    expect(rectsDrawn(false)).toBeGreaterThanOrEqual(2);
  });

  it('flag on: no fill bar', () => {
    expect(rectsDrawn(true)).toBe(rectsDrawn(false) - 2);
  });
});
