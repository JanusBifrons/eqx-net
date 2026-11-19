/**
 * Structure restyle 0d slice 7: the build preview's link verdict is the
 * server's. For each layout the renderer's per-candidate verdict (ok or the
 * refusal, plus the socket pair it picked) must equal core `canConnect` run
 * on a hand-built server view: every owner's buildings in `nodes` (they all
 * block a cable), the asteroids as obstacles, the ghost as node `a`.
 */
import { describe, it, expect } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { getStructureKind, structureHalfExtents } from '../../../shared-types/structureKinds.js';
import { canConnect, type GridNode, type GridObstacle } from '../../../core/structures/Grid.js';
import { CABLE_NO_SOCKET, makeCableSocketPick } from '../../../core/structures/cableCurve.js';
import { GHOST_NODE_ID } from '../../structures/mirrorToGridNode.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

const ME = 'me';
const THEM = 'them';

interface Placed { id: number; kind: string; x: number; y: number; owner: string }
interface Rock { id: number; x: number; y: number; radius: number }

function swarmEntry(kind: 0 | 2, x: number, y: number, radius: number, shipKind?: string): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius, kind,
    ...(shipKind !== undefined ? { shipKind } : {}), sleeping: true, lastUpdateTick: 0,
  };
}

/** The server's view of a structure, built from the catalogue by hand (not
 *  through the client projection under test). */
function serverNode(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: kind === 'connector', isShieldPylon: false,
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

interface Verdict { id: string; ok: boolean; reason: string | null; sockA: number; sockB: number }

/** Core `canConnect` for the ghost against each of my structures. */
function coreVerdicts(ghost: { kind: string; x: number; y: number }, placed: Placed[], rocks: Rock[]): Verdict[] {
  const nodes = new Map<string, GridNode>();
  for (const p of placed) nodes.set(String(p.id), serverNode(String(p.id), p.kind, p.x, p.y));
  const g = serverNode(GHOST_NODE_ID, ghost.kind, ghost.x, ghost.y);
  g.isConstructed = false;
  const obstacles: GridObstacle[] = rocks.map((r) => ({ x: r.x, y: r.y, radius: r.radius, angle: 0 }));
  const pick = makeCableSocketPick();
  const out: Verdict[] = [];
  for (const p of placed) {
    if (p.owner !== ME) continue;
    const res = canConnect(g, nodes.get(String(p.id))!, new Map(), nodes, obstacles, pick);
    out.push({
      id: String(p.id), ok: res.ok, reason: res.ok ? null : res.reason,
      sockA: res.ok ? pick.a : CABLE_NO_SOCKET, sockB: res.ok ? pick.b : CABLE_NO_SOCKET,
    });
  }
  return out;
}

/** The renderer's verdicts for the same layout. */
function previewVerdicts(ghost: { kind: string; x: number; y: number }, placed: Placed[], rocks: Rock[]): Verdict[] {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (const p of placed) {
    swarm.set(p.id, swarmEntry(2, p.x, p.y, getStructureKind(p.kind).radius, p.kind));
    structures.set(p.id, {
      powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: p.owner,
    } as StructureRenderState);
  }
  for (const r of rocks) swarm.set(r.id, swarmEntry(0, r.x, r.y, r.radius));
  const mirror = {
    swarm, structures, localPlayerId: ME,
    pendingPlacementPreview: { ...ghost, angle: 0 },
  } as unknown as RenderMirror;
  const r = new ConnectorRenderer();
  r.update(mirror, 1, 0);
  const out: Verdict[] = [];
  for (let i = 0; i < r.previewVerdictCount; i++) {
    const v = r.previewVerdicts[i]!;
    out.push({ id: v.id, ok: v.ok, reason: v.reason, sockA: v.sockA, sockB: v.sockB });
  }
  return out;
}

function expectParity(ghost: { kind: string; x: number; y: number }, placed: Placed[], rocks: Rock[] = []): Verdict[] {
  const core = coreVerdicts(ghost, placed, rocks);
  expect(previewVerdicts(ghost, placed, rocks)).toEqual(core);
  return core;
}

describe('build preview link verdict = core canConnect (structure-restyle 0d slice 7)', () => {
  const ghost = { kind: 'connector', x: 0, y: 850 };
  const capital: Placed = { id: 1, kind: 'capital', x: 0, y: 0, owner: ME };

  it('facing sockets in reach: ok, same socket pair', () => {
    const v = expectParity(ghost, [capital]);
    expect(v).toHaveLength(1);
    expect(v[0]!.ok).toBe(true);
    expect(v[0]!.sockA).not.toBe(CABLE_NO_SOCKET);
    expect(v[0]!.sockB).not.toBe(CABLE_NO_SOCKET);
  });

  it('partner behind every building socket: no-facing-socket', () => {
    // The ghost connector inside a fabricator's outline: every fabricator
    // socket faces outward, away from it.
    const v = expectParity({ kind: 'connector', x: 0, y: 0 }, [{ id: 1, kind: 'fabricator', x: 0, y: 0, owner: ME }]);
    expect(v[0]!.reason).toBe('no-facing-socket');
  });

  it('a rock on the cable curve: blocked', () => {
    const v = expectParity(ghost, [capital], [{ id: 9, x: 0, y: 540, radius: 200 }]);
    expect(v[0]!.reason).toBe('blocked');
  });

  it("another owner's building on the curve blocks (the server sees every owner), and is no candidate", () => {
    const theirs: Placed = { id: 2, kind: 'battery_bank', x: 0, y: 540, owner: THEM };
    const v = expectParity(ghost, [capital, theirs]);
    expect(v.map((x) => x.id), 'only my structures are candidates').toEqual(['1']);
    expect(v[0]!.reason).toBe('blocked');
    // Control: without it the same link is fine.
    expect(expectParity(ghost, [capital])[0]!.ok).toBe(true);
  });

  it('several candidates, mixed verdicts, in mirror order', () => {
    const v = expectParity(ghost, [
      capital,
      { id: 3, kind: 'connector', x: 400, y: 850, owner: ME },
      { id: 4, kind: 'connector', x: 5000, y: 0, owner: ME },
      { id: 5, kind: 'battery_bank', x: 200, y: 400, owner: THEM },
    ], [{ id: 9, x: -200, y: 850, radius: 50 }]);
    expect(v.map((x) => x.reason)).toEqual([v[0]!.reason, null, 'out-of-range']);
  });
});
