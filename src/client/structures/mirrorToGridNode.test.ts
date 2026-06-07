/**
 * Pure-projection unit lock for the connection-range preview (structures
 * follow-up Item C). `structureMirrorToGridNode` / `ghostToGridNode` must map
 * the catalogue facts (isHub / maxConnections / isCapital / radius /
 * isConstructed) and pose correctly; `asteroidObstaclesFromSwarm` must yield
 * only the kind===0 {x,y,radius} list INTO A REUSED scratch array (invariant
 * #14 — no fresh array per call).
 *
 * These are the side-neutral building blocks the renderer's preview pass feeds
 * into the SAME obstacle-aware `canConnect` the server runs on placement.
 */
import { describe, it, expect } from 'vitest';
import {
  structureMirrorToGridNode,
  ghostToGridNode,
  asteroidObstaclesFromSwarm,
  GHOST_NODE_ID,
} from './mirrorToGridNode.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { GridNode, GridObstacle } from '../../core/structures/Grid.js';
import type {
  StructureRenderState,
  SwarmRenderState,
} from '../../core/contracts/IRenderer.js';

function blankNode(): GridNode {
  return {
    id: '',
    x: 0,
    y: 0,
    radius: 0,
    isHub: false,
    isCapital: false,
    maxConnections: 0,
    powerOutput: 0,
    powerConsumption: 0,
    isConstructed: false,
  };
}

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
    prevX: x,
    prevY: y,
    prevAngle: 0,
    prevArrivalMs: 0,
    latestArrivalMs: 0,
    poseRing: [],
    ringHead: 0,
    radius: getStructureKind(shipKind).radius,
    kind: 2,
    shipKind,
    sleeping: true,
    lastUpdateTick: 0,
  };
}

function asteroidEntry(x: number, y: number, radius: number): SwarmRenderState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
    prevX: x,
    prevY: y,
    prevAngle: 0,
    prevArrivalMs: 0,
    latestArrivalMs: 0,
    poseRing: [],
    ringHead: 0,
    radius,
    kind: 0,
    sleeping: true,
    lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState>): StructureRenderState {
  return {
    powered: true,
    netPower: 0,
    connTo: [],
    built: true,
    buildPct: 1,
    deconstructPct: 0,
    ...over,
  };
}

describe('structureMirrorToGridNode', () => {
  it('maps a built CAPITAL hub: isHub/isCapital true, catalogue cap + radius, constructed', () => {
    const out = blankNode();
    const cap = getStructureKind('capital');
    structureMirrorToGridNode('7', structureState({ built: true }), structureEntry('capital', 100, -50), out);
    expect(out.id).toBe('7');
    expect(out.x).toBe(100);
    expect(out.y).toBe(-50);
    expect(out.radius).toBe(cap.radius);
    expect(out.isHub).toBe(true);
    expect(out.isCapital).toBe(true);
    expect(out.maxConnections).toBe(cap.maxConnections);
    expect(out.isConstructed).toBe(true);
    expect(out.powerOutput).toBe(cap.powerOutput);
  });

  it('maps a leaf SOLAR: isHub false, maxConnections 1, NOT capital', () => {
    const out = blankNode();
    const solar = getStructureKind('solar');
    structureMirrorToGridNode('9', structureState({ built: true }), structureEntry('solar', 0, 0), out);
    expect(out.isHub).toBe(false);
    expect(out.isCapital).toBe(false);
    expect(out.maxConnections).toBe(solar.maxConnections);
    expect(out.maxConnections).toBe(1);
  });

  it('gates a BLUEPRINT (not built) to zero power and isConstructed=false', () => {
    const out = blankNode();
    structureMirrorToGridNode('3', structureState({ built: false }), structureEntry('solar', 0, 0), out);
    expect(out.isConstructed).toBe(false);
    expect(out.powerOutput).toBe(0);
    expect(out.powerConsumption).toBe(0);
  });

  it('writes IN PLACE into the caller-owned node (no new object)', () => {
    const out = blankNode();
    const ret = structureMirrorToGridNode('1', structureState({}), structureEntry('connector', 5, 6), out);
    expect(ret).toBe(out);
  });
});

describe('ghostToGridNode', () => {
  it('projects a connector ghost with the reserved ghost id + catalogue facts', () => {
    const out = blankNode();
    const conn = getStructureKind('connector');
    ghostToGridNode({ kind: 'connector', x: 12, y: 34 }, out);
    expect(out.id).toBe(GHOST_NODE_ID);
    expect(out.x).toBe(12);
    expect(out.y).toBe(34);
    expect(out.radius).toBe(conn.radius);
    expect(out.isHub).toBe(true);
    expect(out.maxConnections).toBe(conn.maxConnections);
    expect(out.isConstructed).toBe(false);
  });

  it('a solar ghost is a non-hub leaf', () => {
    const out = blankNode();
    ghostToGridNode({ kind: 'solar', x: 0, y: 0 }, out);
    expect(out.isHub).toBe(false);
    expect(out.isCapital).toBe(false);
  });
});

describe('asteroidObstaclesFromSwarm', () => {
  it('yields one {x,y,radius} per kind===0 asteroid, skipping drones + structures', () => {
    const swarm = new Map<number, SwarmRenderState>([
      [1, asteroidEntry(100, 200, 40)],
      [2, structureEntry('capital', 0, 0)], // kind 2 — skipped
      [3, asteroidEntry(-10, -20, 25)],
    ]);
    // a drone (kind 1) — skipped
    const drone = asteroidEntry(9, 9, 12);
    drone.kind = 1;
    swarm.set(4, drone);

    const scratch: GridObstacle[] = [];
    const out = asteroidObstaclesFromSwarm(swarm, scratch);
    expect(out).toBe(scratch); // same array returned
    expect(out.length).toBe(2);
    expect(out).toEqual([
      { x: 100, y: 200, radius: 40 },
      { x: -10, y: -20, radius: 25 },
    ]);
  });

  it('reuses the scratch array across calls (invariant #14 — no fresh alloc)', () => {
    const scratch: GridObstacle[] = [];
    const swarmA = new Map<number, SwarmRenderState>([
      [1, asteroidEntry(1, 1, 10)],
      [2, asteroidEntry(2, 2, 20)],
      [3, asteroidEntry(3, 3, 30)],
    ]);
    asteroidObstaclesFromSwarm(swarmA, scratch);
    expect(scratch.length).toBe(3);
    const firstObj = scratch[0];

    // Fewer asteroids next frame — array shortens but the backing objects are
    // reused (firstObj identity preserved).
    const swarmB = new Map<number, SwarmRenderState>([[5, asteroidEntry(9, 9, 99)]]);
    asteroidObstaclesFromSwarm(swarmB, scratch);
    expect(scratch.length).toBe(1);
    expect(scratch[0]).toBe(firstObj); // same pooled object, rewritten
    expect(scratch[0]).toEqual({ x: 9, y: 9, radius: 99 });
  });

  it('empty swarm → empty list', () => {
    const scratch: GridObstacle[] = [];
    asteroidObstaclesFromSwarm(new Map(), scratch);
    expect(scratch.length).toBe(0);
  });
});
