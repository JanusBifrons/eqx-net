/**
 * Placement ghost vs server, both sides of the wire (#15). The server refuses
 * a `place_structure` that overlaps a structure, a landing pad or a rock
 * (`StructurePlacementSubsystem.place`); the client tints the ghost red at the
 * same spots (`PlacementGhostVerdict`). Both call the ONE core predicate,
 * `placementRejection`, and must give the same verdict, with the same notice
 * text, at every sample point around a base and a rock. A rule changed on one
 * side only fails here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/structures/placementRules.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/structures/placementRules.js')>();
  return { ...mod, placementRejection: vi.fn(mod.placementRejection) };
});

import { placementRejection, placementRejectionNotice } from '../../src/core/structures/placementRules.js';
import { StructurePlacementSubsystem } from '../../src/server/structures/StructurePlacementSubsystem.js';
import { StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { PlacementGhostVerdict } from '../../src/client/structures/placementGhostVerdict.js';
import { getStructureKind } from '../../src/shared-types/structureKinds.js';
import type { GridObstacle } from '../../src/core/structures/Grid.js';
import type { SwarmRenderState, StructureRenderState } from '../../src/core/contracts/IRenderer.js';

const ROCK: GridObstacle = { x: 2600, y: 0, radius: 300 };

function server() {
  const registry = new StructureRegistry();
  let n = 0;
  const sub = new StructurePlacementSubsystem({
    spawnStructure: () => true, seedHealth: () => {}, despawn: () => {},
    clamp: (x, y) => ({ x, y }), nextId: () => `s-${n++}`, registry,
    getObstacles: () => [ROCK],
  });
  // The base: a Capital (it has a crane-bay landing pad) and a turned freight dock.
  sub.place('p1', 'capital', 0, 0, { skipAutoConnect: true });
  sub.place('p1', 'freight_dock', -3000, 0, { skipAutoConnect: true, rot: 90 });
  return { sub, registry };
}

/** The client's render mirror of the server's registry (pose on the swarm wire). */
function mirrorOf(registry: StructureRegistry) {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  let id = 1;
  for (const r of registry.all()) {
    swarm.set(id, {
      x: r.x, y: r.y, vx: 0, vy: 0, angle: (r.rot * Math.PI) / 180, angvel: 0,
      prevX: r.x, prevY: r.y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: getStructureKind(r.kind).radius, kind: 2, shipKind: r.kind, sleeping: true, lastUpdateTick: 0,
    } as SwarmRenderState);
    structures.set(id, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 } as StructureRenderState);
    id++;
  }
  return { swarm, structures };
}

describe('placement: server and client agree', () => {
  it('same verdict and notice at every sample point, through the one shared predicate', () => {
    const { sub, registry } = server();
    const { swarm, structures } = mirrorOf(registry);
    const verdict = new PlacementGhostVerdict();
    const spy = vi.mocked(placementRejection);
    const seen = new Set<string | null>();
    let checked = 0;
    for (const kind of ['connector', 'battery', 'freight_dock'] as const) {
      for (const rot of [0, 90]) {
        for (let x = -4500; x <= 3500; x += 250) {
          for (let y = -1500; y <= 1500; y += 250) {
            spy.mockClear();
            const id = sub.place('p1', kind, x, y, { skipAutoConnect: true, rot });
            const serverCalls = spy.mock.calls.length;
            const serverSays = id === null ? sub.lastRefusal : null;
            if (id !== null) sub.remove('p1', id);
            const client = verdict.check({ kind, x, y, angle: (rot * Math.PI) / 180 }, structures, swarm, [ROCK]);
            expect(serverCalls).toBe(1);
            expect(spy.mock.calls.length).toBe(2); // the client ran the same function
            const clientSays = client === null ? null : placementRejectionNotice(client);
            expect(clientSays, `${kind} rot ${rot} at (${x}, ${y})`).toBe(serverSays);
            seen.add(client);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // The samples really cover every outcome.
    expect([...seen].sort()).toEqual([null, 'overlap-obstacle', 'overlap-pad', 'overlap-structure'].sort());
  });
});
