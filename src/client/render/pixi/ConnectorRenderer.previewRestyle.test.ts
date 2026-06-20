/**
 * ConnectorRenderer placement-preview RESTYLE lock (WS-D PR1 / #6; Invariant #13
 * — failing test FIRST).
 *
 * Mirrors ConnectorRenderer.placementPreview.test.ts's headless harness but
 * asserts the NEW counts the restyle publishes:
 *   - `placementPreviewSelectedCount` — the SOLID-green hubs that WILL connect
 *     (= the old `placementPreviewConnectionCount`, capped at the kind's
 *     maxConnections AND the global PLACEMENT_MAX_CONNECTIONS).
 *   - `placementPreviewDeferredCount` — the DOTTED-green hubs that COULD connect
 *     but lost the cap race (= the old `placementPreviewOverflowCount`, restyled
 *     from red overflow to dotted-green deferred).
 *
 * The point of the restyle: a leaf near several hubs shows exactly ONE solid
 * line to the one it'll grab + dotted lines to the rest, instead of one green +
 * the rest RED (which read as "errors").
 *
 * Before the feature exists this FAILS: the renderer publishes
 * `placementPreviewSelectedCount`/`placementPreviewDeferredCount` as undefined.
 */
import { describe, it, expect } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type {
  RenderMirror,
  SwarmRenderState,
  StructureRenderState,
} from '../../../core/contracts/IRenderer.js';

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0,
    radius: getStructureKind(shipKind).radius,
    kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState> = {}): StructureRenderState {
  return { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, ...over };
}

describe('ConnectorRenderer — preview restyle (one solid + rest dotted, WS-D PR1)', () => {
  it('a leaf near 3 hubs → exactly 1 SELECTED (solid) + 2 DEFERRED (dotted)', () => {
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const id = i + 1;
      swarm.set(id, structureEntry('connector', Math.cos(angle) * 200, Math.sin(angle) * 200));
      structures.set(id, structureState({ connTo: [] }));
    }
    const mirror: RenderMirror = {
      swarm, structures,
      pendingPlacementPreview: { kind: 'solar', x: 0, y: 0, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    // solar maxConnections is 1 → exactly one solid, the rest deferred.
    expect(getStructureKind('solar').maxConnections).toBe(1);
    expect(r.placementPreviewSelectedCount).toBe(1);
    expect(r.placementPreviewDeferredCount).toBe(2);
    // The legacy field name still tracks the SELECTED count (renderer-feedback hook).
    expect(r.placementPreviewConnectionCount).toBe(1);
  });

  it('a Connector (cap 6) near 8 hubs → 6 selected + 2 deferred', () => {
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const id = i + 1;
      swarm.set(id, structureEntry('connector', Math.cos(angle) * 200, Math.sin(angle) * 200));
      structures.set(id, structureState({ connTo: [] }));
    }
    const mirror: RenderMirror = {
      swarm, structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 0, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewSelectedCount).toBe(6);
    expect(r.placementPreviewDeferredCount).toBe(2);
  });

  it('no deferred when in-range hubs are at/below the cap (all solid)', () => {
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const id = i + 1;
      swarm.set(id, structureEntry('connector', Math.cos(angle) * 200, Math.sin(angle) * 200));
      structures.set(id, structureState({ connTo: [] }));
    }
    const mirror: RenderMirror = {
      swarm, structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 0, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewSelectedCount).toBe(4);
    expect(r.placementPreviewDeferredCount).toBe(0);
  });
});
