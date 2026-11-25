/**
 * Base platforms 16, both sides of the wire (#15): with buildings turned by
 * 30° steps, the server's `StructurePlacementSubsystem.place` and the client's
 * `PlacementGhostVerdict` give the same verdict at every sample point. The
 * server feeds `placementRejection` its registry records (rot in degrees);
 * the client feeds the render mirror's swarm angle (radians). If either side
 * drops the turn (or turns the other way), the oriented-box verdicts differ.
 */
import { describe, expect, it } from 'vitest';
import { placementRejectionNotice } from '../../src/core/structures/placementRules.js';
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
  // A turned base: a Solar at 30°, a freight dock (landing pad) at 60°.
  expect(sub.place('p1', 'solar', 0, 0, { skipAutoConnect: true, rot: 30 })).not.toBeNull();
  expect(sub.place('p1', 'freight_dock', -3000, 0, { skipAutoConnect: true, rot: 60 })).not.toBeNull();
  return { sub, registry };
}

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

describe('placement at 30° steps: server and client agree (oriented boxes)', () => {
  it('same verdict and notice at every sample point', () => {
    const { sub, registry } = server();
    const { swarm, structures } = mirrorOf(registry);
    const verdict = new PlacementGhostVerdict();
    const seen = new Set<string | null>();
    let checked = 0;
    for (const kind of ['solar', 'freight_dock'] as const) {
      for (const rot of [30, 60, 120]) {
        for (let x = -4500; x <= 3500; x += 250) {
          for (let y = -1500; y <= 1500; y += 250) {
            const id = sub.place('p1', kind, x, y, { skipAutoConnect: true, rot });
            const serverSays = id === null ? sub.lastRefusal : null;
            if (id !== null) sub.remove('p1', id);
            const client = verdict.check({ kind, x, y, angle: (rot * Math.PI) / 180 }, structures, swarm, [ROCK]);
            const clientSays = client === null ? null : placementRejectionNotice(client);
            expect(clientSays, `${kind} rot ${rot} at (${x}, ${y})`).toBe(serverSays);
            seen.add(client);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect([...seen].sort()).toEqual([null, 'overlap-obstacle', 'overlap-pad', 'overlap-structure'].sort());
  });
});
