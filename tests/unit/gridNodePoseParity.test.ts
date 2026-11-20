/**
 * 0d cable sockets, slice 2 — a `GridNode` carries the structure's `kind` and
 * `rot` (radians), and the server (`structureToGridNode`) and client
 * (`structureMirrorToGridNode`, the build preview's `ghostToGridNode`)
 * builders must agree on kind, rotation and footprint box (invariant #15),
 * or the preview's socket/link verdict differs from what placement does.
 * The server stores `rot` in degrees and sends `rot°·π/180` as the swarm
 * angle, so the same structure through each builder must give one pose.
 */
import { describe, it, expect } from 'vitest';
import { structureToGridNode } from '../../src/server/structures/structureGridView.js';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { structureMirrorToGridNode, ghostToGridNode } from '../../src/client/structures/mirrorToGridNode.js';
import type { GridNode } from '../../src/core/structures/Grid.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../src/shared-types/structureKinds.js';
import { structureHalfExtents } from '../../src/shared-types/structureKinds/geometry.js';

function blank(): GridNode {
  return {
    id: '', kind: '', x: 0, y: 0, rot: 0, radius: 0, isHub: false, isCapital: false, isConnector: false,
    maxConnections: 0, powerOutput: 0, powerConsumption: 0, isConstructed: false,
  };
}

/** The record as the placement path builds it (box cached from `rot`). */
function record(kind: StructureKindId, x: number, y: number, rot: number): StructureRecord {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, rot);
  return {
    id: '1', owner: 'p1', kind, subtypeIndex: 0, x, y, radius: k.radius, rot, halfW: hw, halfH: hh,
    isConstructed: true, constructionProgress: k.constructionCost, constructionCost: k.constructionCost,
    isDeconstructing: false, minerals: 0, storedPower: 0,
  };
}

/** The swarm entry the client decodes for that record (angle = rot°·π/180). */
function swarmEntry(kind: string, x: number, y: number, rotDeg: number): SwarmRenderState {
  const angle = (rotDeg * Math.PI) / 180;
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
    radius: getStructureKind(kind).radius, kind: 2, shipKind: kind, sleeping: true, lastUpdateTick: 0,
  };
}

const STATE: StructureRenderState = {
  powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0,
};

/** Non-square kinds, so a wrong rotation swaps the box and fails. */
function nonSquareKinds(): StructureKindId[] {
  const out: StructureKindId[] = [];
  for (const id of ['shipyard', 'shield_gate', 'solar', 'connector', 'capital'] as const) {
    const fp = getStructureKind(id).footprint;
    if (fp.w !== fp.h) out.push(id);
  }
  return out;
}

describe('GridNode pose parity: server, client mirror and preview ghost agree (0d, #15)', () => {
  const kinds = nonSquareKinds();

  it('has at least one non-square kind to test', () => {
    expect(kinds.length).toBeGreaterThan(0);
  });

  for (const kind of kinds) {
    for (const rotDeg of [0, 90, 180, 270]) {
      it(`${kind} at ${rotDeg}°`, () => {
        const server = structureToGridNode(record(kind, 120, -40, rotDeg));
        const client = structureMirrorToGridNode('1', STATE, swarmEntry(kind, 120, -40, rotDeg), blank());
        const ghost = ghostToGridNode({ kind, x: 120, y: -40, angle: (rotDeg * Math.PI) / 180 }, blank());
        for (const n of [client, ghost]) {
          expect(n.kind).toBe(server.kind);
          expect(n.rot).toBeCloseTo(server.rot, 12);
          expect(n.halfW).toBe(server.halfW);
          expect(n.halfH).toBe(server.halfH);
        }
        expect(server.kind).toBe(kind);
        expect(server.rot).toBeCloseTo((rotDeg * Math.PI) / 180, 12);
        const want = structureHalfExtents(kind, rotDeg);
        expect([server.halfW, server.halfH]).toEqual([want.hw, want.hh]);
      });
    }
  }
});
