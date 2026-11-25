/**
 * Base platforms slice 19 (#15): a deck fence ring. Six shield pylons on the
 * corners of one deck hex auto-connect on the server (`autoConnectStructure`,
 * `StructureRegistry.deck`) along the six seams only; the server's
 * `ShieldWallManager` walls and the client's `visitDerivedWalls` (from the
 * mirrored `connTo`) are the same six seam segments; the client build
 * preview's mirror nodes reach the same `canConnect` verdicts.
 */
import { describe, it, expect } from 'vitest';
import { autoConnectStructure, structureToGridNode } from '../../src/server/structures/structureGridView.js';
import { StructureRegistry, type StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { ShieldWallManager } from '../../src/server/structures/ShieldWallManager.js';
import { structureMirrorToGridNode } from '../../src/client/structures/mirrorToGridNode.js';
import { visitDerivedWalls } from '../../src/client/structures/derivedWalls.js';
import { canConnect, type GridNode } from '../../src/core/structures/Grid.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import { structureHalfExtents } from '../../src/shared-types/structureKinds/geometry.js';
import { hexCornerInto } from '../../src/core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../src/core/hex/plates.js';

function record(id: string, x: number, y: number): StructureRecord {
  const k = getStructureKind('shield_pylon');
  const { hw, hh } = structureHalfExtents('shield_pylon', 0);
  return {
    id, owner: 'p1', kind: 'shield_pylon', subtypeIndex: 0, x, y, radius: k.radius, rot: 0, halfW: hw, halfH: hh,
    isConstructed: true, constructionProgress: k.constructionCost, constructionCost: k.constructionCost,
    isDeconstructing: false, minerals: 0, storedPower: 0,
  };
}

function swarmEntry(x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
    radius: getStructureKind('shield_pylon').radius, kind: 2, shipKind: 'shield_pylon', sleeping: true, lastUpdateTick: 0,
  };
}

function blank(): GridNode {
  return {
    id: '', kind: '', x: 0, y: 0, rot: 0, radius: 0, isHub: false, isCapital: false, isConnector: false,
    maxConnections: 0, powerOutput: 0, powerConsumption: 0, isConstructed: false,
  };
}

/** The six corners of deck hex (1, 0), ids '1'..'6'. */
function ring(): Array<{ id: string; x: number; y: number }> {
  const c = deckHexCentreInto(1, 0, { x: 0, y: 0 });
  const out: Array<{ id: string; x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const p = hexCornerInto(c.x, c.y, DECK_HEX_SIZE, i, { x: 0, y: 0 });
    out.push({ id: String(i + 1), x: p.x, y: p.y });
  }
  return out;
}

const segKey = (ax: number, ay: number, bx: number, by: number): string => {
  const a = `${ax.toFixed(1)},${ay.toFixed(1)}`, b = `${bx.toFixed(1)},${by.toFixed(1)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

describe('deck fence ring: server links + walls match the client derivation (#15)', () => {
  for (const deck of [true, false]) {
    it(`six corner pylons, deck ${deck ? 'on' : 'off'}`, () => {
      const registry = new StructureRegistry();
      registry.deck = deck;
      for (const p of ring()) {
        registry.add(record(p.id, p.x, p.y));
        autoConnectStructure(registry, p.id);
      }

      // Server walls.
      const server: string[] = [];
      const mgr = new ShieldWallManager({
        registry,
        powerSummaryFor: () => ({ netPower: 50, powered: true }),
        componentBatteryCharge: () => 0,
        drainComponentBatteries: () => 0,
        spawnWall: (_id, ax, ay, bx, by) => server.push(segKey(ax, ay, bx, by)),
        setWallActive: () => {},
        removeWall: () => {},
      });
      mgr.update(1000);

      // Client walls from the mirror (connTo = the server's links).
      const structures = new Map<number, StructureRenderState>();
      const swarm = new Map<number, SwarmRenderState>();
      for (const p of ring()) {
        const connTo = registry.connectionsOf(p.id).map((c) => Number(c.getOtherNode(p.id)));
        structures.set(Number(p.id), { powered: true, netPower: 0, connTo, built: true, buildPct: 1, deconstructPct: 0, wallActive: true });
        swarm.set(Number(p.id), swarmEntry(p.x, p.y));
      }
      const client: string[] = [];
      visitDerivedWalls(structures, swarm, { wall: (_k, ax, ay, bx, by) => client.push(segKey(ax, ay, bx, by)) });

      expect(client.sort()).toEqual(server.sort());
      if (deck) {
        // Exactly the six seams: every wall is one hex edge long.
        expect(server).toHaveLength(6);
        for (const p of ring()) expect(registry.connectionsOf(p.id)).toHaveLength(2);
      }

      // The client build preview's mirror nodes give the server's verdicts.
      const pts = ring();
      for (const a of pts) {
        for (const b of pts) {
          if (a.id >= b.id) continue;
          const sa = structureToGridNode(record(a.id, a.x, a.y)), sb = structureToGridNode(record(b.id, b.x, b.y));
          const st: StructureRenderState = { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 };
          const ca = structureMirrorToGridNode(a.id, st, swarmEntry(a.x, a.y), blank());
          const cb = structureMirrorToGridNode(b.id, st, swarmEntry(b.x, b.y), blank());
          const sv = canConnect(sa, sb, new Map(), new Map([[a.id, sa], [b.id, sb]]), undefined, undefined, undefined, deck);
          const cv = canConnect(ca, cb, new Map(), new Map([[a.id, ca], [b.id, cb]]), undefined, undefined, undefined, deck);
          expect(cv).toEqual(sv);
        }
      }
    });
  }
});
