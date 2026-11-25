/**
 * Base platforms slice 10 (#15): the server's grid projection
 * (`structureToGridNode`, fed `StructureRegistry.deck`) and the client build
 * preview's mirror (`structureMirrorToGridNode`, fed `preview.deck`) reach
 * the SAME `canConnect` verdict on the deck link rule, deck on and off.
 */
import { describe, it, expect } from 'vitest';
import { structureToGridNode } from '../../src/server/structures/structureGridView.js';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { structureMirrorToGridNode } from '../../src/client/structures/mirrorToGridNode.js';
import { canConnect, type GridNode } from '../../src/core/structures/Grid.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../src/shared-types/structureKinds.js';
import { structureHalfExtents } from '../../src/shared-types/structureKinds/geometry.js';
import { HEX_DIRS } from '../../src/core/hex/hex.js';
import { deckHexCentreInto, plateCentreHexInto } from '../../src/core/hex/plates.js';

function blank(): GridNode {
  return {
    id: '', kind: '', x: 0, y: 0, rot: 0, radius: 0, isHub: false, isCapital: false, isConnector: false,
    maxConnections: 0, powerOutput: 0, powerConsumption: 0, isConstructed: false,
  };
}

function record(id: string, kind: StructureKindId, x: number, y: number): StructureRecord {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, owner: 'p1', kind, subtypeIndex: 0, x, y, radius: k.radius, rot: 0, halfW: hw, halfH: hh,
    isConstructed: true, constructionProgress: k.constructionCost, constructionCost: k.constructionCost,
    isDeconstructing: false, minerals: 0, storedPower: 0,
  };
}

function swarmEntry(kind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
    radius: getStructureKind(kind).radius, kind: 2, shipKind: kind, sleeping: true, lastUpdateTick: 0,
  };
}

const STATE: StructureRenderState = { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 };

function both(id: string, kind: StructureKindId, x: number, y: number): [GridNode, GridNode] {
  return [structureToGridNode(record(id, kind, x, y)), structureMirrorToGridNode(id, STATE, swarmEntry(kind, x, y), blank())];
}

function hexOf(i: number, j: number, k: number): { x: number; y: number } {
  const c = plateCentreHexInto(i, j, { q: 0, r: 0 });
  const d = HEX_DIRS[k]!;
  return deckHexCentreInto(c.q + d.q, c.r + d.r, { x: 0, y: 0 });
}

const CASES: Array<{ name: string; kind: StructureKindId; at: { x: number; y: number } }> = [
  { name: 'hex building on the plate', kind: 'solar', at: hexOf(0, 0, 0) },
  { name: 'small building on the plate', kind: 'battery', at: hexOf(0, 0, 2) },
  { name: 'hex building on the next plate', kind: 'solar', at: hexOf(1, 0, 3) },
];

describe('deck link verdict parity: server projection vs client mirror (#15)', () => {
  for (const c of CASES) {
    for (const deck of [true, false]) {
      it(`${c.name}, deck ${deck ? 'on' : 'off'}`, () => {
        const [sCon, cCon] = both('1', 'connector', 0, 0);
        const [sB, cB] = both('2', c.kind, c.at.x, c.at.y);
        const server = canConnect(sB, sCon, new Map(), new Map([['1', sCon], ['2', sB]]), undefined, undefined, undefined, deck);
        const client = canConnect(cB, cCon, new Map(), new Map([['1', cCon], ['2', cB]]), undefined, undefined, undefined, deck);
        expect(client).toEqual(server);
        if (c.name.endsWith('on the plate')) expect(server.ok).toBe(deck);
        else expect(server.ok).toBe(false);
      });
    }
  }
});
