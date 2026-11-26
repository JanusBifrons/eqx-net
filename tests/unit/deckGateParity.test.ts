/**
 * Base platforms slice 21: a fence gate on a road seam. Six shield pylons on
 * the corners of one deck hex form the seam ring (slice 19); a shield gate
 * placed on one seam's midpoint, turned along it, CUTS that seam's
 * post-to-post link and links to the seam's two end posts instead
 * (`DECK_LINK_SEAM_GATE`). The server's `ShieldWallManager` walls and the
 * client's `visitDerivedWalls` agree, and the client build preview's mirror
 * nodes reach the server's `canConnect` verdicts for every pair.
 */
import { describe, it, expect } from 'vitest';
import { autoConnectStructure, structureToGridNode } from '../../src/server/structures/structureGridView.js';
import { StructureRegistry, type StructureRecord } from '../../src/server/structures/StructureRegistry.js';
import { ShieldWallManager } from '../../src/server/structures/ShieldWallManager.js';
import { structureMirrorToGridNode } from '../../src/client/structures/mirrorToGridNode.js';
import { visitDerivedWalls } from '../../src/client/structures/derivedWalls.js';
import { canConnect, type GridNode } from '../../src/core/structures/Grid.js';
import { DECK_LINK_SEAM_GATE, deckLinkKind } from '../../src/core/structures/deckLinks.js';
import type { StructureRenderState, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import { structureHalfExtents } from '../../src/shared-types/structureKinds/geometry.js';
import { hexCornerInto } from '../../src/core/hex/hex.js';
import { DECK_HEX_INRADIUS } from '../../src/core/hex/deckCorners.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../src/core/hex/plates.js';

interface Part { id: string; kind: string; x: number; y: number; rot: number }

function record(p: Part): StructureRecord {
  const k = getStructureKind(p.kind);
  const { hw, hh } = structureHalfExtents(p.kind, p.rot);
  return {
    id: p.id, owner: 'p1', kind: p.kind as StructureRecord['kind'], subtypeIndex: 0, x: p.x, y: p.y, radius: k.radius, rot: p.rot,
    halfW: hw, halfH: hh, isConstructed: true, constructionProgress: k.constructionCost, constructionCost: k.constructionCost,
    isDeconstructing: false, minerals: 0, storedPower: 0,
  };
}

function swarmEntry(p: Part): SwarmRenderState {
  const a = (p.rot * Math.PI) / 180;
  return {
    x: p.x, y: p.y, vx: 0, vy: 0, angle: a, angvel: 0, prevX: p.x, prevY: p.y, prevAngle: a,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
    radius: getStructureKind(p.kind).radius, kind: 2, shipKind: p.kind, sleeping: true, lastUpdateTick: 0,
  };
}

function blank(): GridNode {
  return {
    id: '', kind: '', x: 0, y: 0, rot: 0, radius: 0, isHub: false, isCapital: false, isConnector: false,
    maxConnections: 0, powerOutput: 0, powerConsumption: 0, isConstructed: false,
  };
}

const C = deckHexCentreInto(1, 0, { x: 0, y: 0 });

/** The six corner pylons of deck hex (1, 0), ids '1'..'6' (corner i at 30° + 60°·i). */
function ring(): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const p = hexCornerInto(C.x, C.y, DECK_HEX_SIZE, i, { x: 0, y: 0 });
    out.push({ id: String(i + 1), kind: 'shield_pylon', x: p.x, y: p.y, rot: 0 });
  }
  return out;
}

/** A gate on the midpoint of edge `e` (at 60°·e, between corners e − 1 and e), along its seam. */
function gate(e: number): Part {
  const a = (e * Math.PI) / 3;
  return { id: '7', kind: 'shield_gate', x: C.x + DECK_HEX_INRADIUS * Math.cos(a), y: C.y + DECK_HEX_INRADIUS * Math.sin(a), rot: (e * 60 + 90) % 180 };
}

const segKey = (ax: number, ay: number, bx: number, by: number): string => {
  const a = `${ax.toFixed(1)},${ay.toFixed(1)}`, b = `${bx.toFixed(1)},${by.toFixed(1)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

function serverWalls(registry: StructureRegistry): string[] {
  const out: string[] = [];
  new ShieldWallManager({
    registry,
    powerSummaryFor: () => ({ netPower: 50, powered: true }),
    componentBatteryCharge: () => 0,
    drainComponentBatteries: () => 0,
    spawnWall: (_id, ax, ay, bx, by) => out.push(segKey(ax, ay, bx, by)),
    setWallActive: () => {},
    removeWall: () => {},
  }).update(1000);
  return out;
}

function clientWalls(registry: StructureRegistry, parts: readonly Part[]): string[] {
  const structures = new Map<number, StructureRenderState>();
  const swarm = new Map<number, SwarmRenderState>();
  for (const p of parts) {
    const connTo = registry.connectionsOf(p.id).map((c) => Number(c.getOtherNode(p.id)));
    structures.set(Number(p.id), { powered: true, netPower: 0, connTo, built: true, buildPct: 1, deconstructPct: 0, wallActive: true });
    swarm.set(Number(p.id), swarmEntry(p));
  }
  const out: string[] = [];
  visitDerivedWalls(structures, swarm, { wall: (_k, ax, ay, bx, by) => out.push(segKey(ax, ay, bx, by)) });
  return out;
}

describe('deck fence gate: links + walls, server vs client (slice 21)', () => {
  // Edge 0 is a 90° seam (a quarter turn), edge 1 a 150° seam, edge 2 a 30° one.
  for (const e of [0, 1, 2]) {
    it(`gate on edge ${e} replaces its seam wall, server and client agree`, () => {
      const registry = new StructureRegistry();
      registry.deck = true;
      const posts = ring();
      for (const p of posts) {
        registry.add(record(p));
        autoConnectStructure(registry, p.id);
      }
      const endA = String(((e + 5) % 6) + 1), endB = String(e + 1);
      expect(registry.hasConnection(endA, endB)).toBe(true);

      const g = gate(e);
      registry.add(record(g));
      autoConnectStructure(registry, g.id);

      // The seam's post-to-post link is cut; the gate links to both ends, nothing else.
      expect(registry.hasConnection(endA, endB)).toBe(false);
      expect(registry.hasConnection(g.id, endA)).toBe(true);
      expect(registry.hasConnection(g.id, endB)).toBe(true);
      expect(registry.connectionsOf(g.id)).toHaveLength(2);

      const parts = [...posts, g];
      const server = serverWalls(registry);
      expect(server).toHaveLength(5 + 2);
      expect(clientWalls(registry, parts).sort()).toEqual(server.sort());

      // The build preview's mirror nodes give the server's verdicts, every pair.
      const nodeS = new Map(parts.map((p) => [p.id, structureToGridNode(record(p))] as const));
      const st: StructureRenderState = { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 };
      const nodeC = new Map(parts.map((p) => [p.id, structureMirrorToGridNode(p.id, st, swarmEntry(p), blank())] as const));
      for (const a of parts) {
        for (const b of parts) {
          if (a.id >= b.id) continue;
          const sa = nodeS.get(a.id)!, sb = nodeS.get(b.id)!, ca = nodeC.get(a.id)!, cb = nodeC.get(b.id)!;
          const sv = canConnect(sa, sb, new Map(), nodeS, undefined, undefined, undefined, true);
          const cv = canConnect(ca, cb, new Map(), nodeC, undefined, undefined, undefined, true);
          expect(cv).toEqual(sv);
          const gatePair = a.id === g.id || b.id === g.id;
          const seamEnd = gatePair && [a.id, b.id].some((id) => id === endA || id === endB);
          expect(deckLinkKind(sa, sb) === DECK_LINK_SEAM_GATE).toBe(seamEnd);
          if (gatePair) expect(sv).toEqual(seamEnd ? { ok: true } : { ok: false, reason: 'off-seam' });
          // The two seam ends cannot relink across the gate.
          if ((a.id === endA && b.id === endB) || (a.id === endB && b.id === endA)) expect(sv).toEqual({ ok: false, reason: 'blocked' });
        }
      }
    });
  }

  it('gate placed before the pylons: the posts link to it, not across it', () => {
    const registry = new StructureRegistry();
    registry.deck = true;
    const g = gate(1);
    registry.add(record(g));
    autoConnectStructure(registry, g.id);
    const posts = ring();
    for (const p of posts) {
      registry.add(record(p));
      autoConnectStructure(registry, p.id);
    }
    expect(registry.hasConnection('1', '2')).toBe(false);
    expect(registry.hasConnection(g.id, '1')).toBe(true);
    expect(registry.hasConnection(g.id, '2')).toBe(true);
    const server = serverWalls(registry);
    expect(server).toHaveLength(7);
    expect(clientWalls(registry, [...posts, g]).sort()).toEqual(server.sort());
  });
});
