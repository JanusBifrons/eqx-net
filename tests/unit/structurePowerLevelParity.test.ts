/**
 * #15 — a leveled generator's power output is one value on both sides of the
 * wire: the server grid (`server/structures/structureGridView.ts`
 * `structureToGridNode`) and the client mirror the placement preview + stats
 * panel read (`client/structures/mirrorToGridNode.ts`
 * `structureMirrorToGridNode`). Fails when one side scales by level alone.
 */
import { describe, expect, it } from 'vitest';
import { structureToGridNode } from '../../src/server/structures/structureGridView.js';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { structureMirrorToGridNode } from '../../src/client/structures/mirrorToGridNode.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import type { GridNode } from '../../src/core/structures/Grid.js';
import type { StructureRenderState } from '../../src/core/contracts/render/StructureRenderState.js';
import type { SwarmRenderState } from '../../src/core/contracts/IRenderer.js';

function blankNode(): GridNode {
  return {
    id: '', x: 0, y: 0, radius: 0, isHub: false, isCapital: false,
    maxConnections: 0, powerOutput: 0, powerConsumption: 0, isConstructed: false,
  };
}

function serverRec(kind: string, level: number): StructureRecord {
  const k = getStructureKind(kind);
  return {
    id: 's1', kind, owner: 'p', x: 0, y: 0, radius: k.radius,
    isConstructed: true, constructionProgress: 1, constructionCost: 1,
    level, fueled: true,
  } as unknown as StructureRecord;
}

function clientState(level: number): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, level };
}

function swarmEntry(kind: string): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
    radius: getStructureKind(kind).radius, kind: 2, shipKind: kind, sleeping: true, lastUpdateTick: 0,
  };
}

describe('structure power-output level parity (server grid ↔ client mirror)', () => {
  for (const kind of ['solar', 'capital'] as const) {
    for (const level of [1, 2, 3, 5]) {
      it(`a level-${level} ${kind} outputs the same power on both sides`, () => {
        const server = structureToGridNode(serverRec(kind, level)).powerOutput;
        const client = structureMirrorToGridNode('s1', clientState(level), swarmEntry(kind), blankNode()).powerOutput;
        expect(client).toBe(server);
        if (level > 1) expect(server).toBeGreaterThan(getStructureKind(kind).powerOutput);
      });
    }
  }
});
