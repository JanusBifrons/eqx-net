/**
 * Client cost per wreck piece (debris soak, 2026-11-13). In the
 * `fleet-fight-soak-lite` scene the client's frame p95 went from 16.7 ms to
 * 100+ ms at ~600 pieces and the page dropped. A CDP profile of the main
 * thread at ~480 pieces put 56 % of it in Rapier's `step` (the reconcile
 * replay and `tickPhysics`): every piece was an AWAKE predWorld body, woken by
 * the anchor on every snapshot, whatever its distance from the pilot.
 *
 * Two locks, both COUNTS (root CLAUDE.md "gate on counts"):
 *  1. a piece only gets a predWorld body near the local ship (the structure
 *     streaming radius), and gains one as the ship comes near;
 *  2. a piece the server reports ASLEEP stays asleep in the predWorld through
 *     the anchor and the following steps (#15: matches the server body), and
 *     the local ship touching it still wakes it (collision unchanged).
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from '../../src/client/net/ColyseusClient.js';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { POSE_RING_DEPTH, type PoseRingEntry, type SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { SWARM_KIND_WRECK } from '../../src/shared-types/swarmWireFormat.js';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from '../../src/server/rooms/CapitalWreckSubsystem.js';
import type { WreckGeometryStore } from '../../src/client/net/wreckGeometryStore.js';
import type { WreckDescriptor } from '../../src/shared-types/messages/snapshotMessages.js';
import { anchorRemoteSwarmBodies } from '../../src/client/net/snapshotRemoteSync.js';
import { PREDWORLD_STRUCTURE_RADIUS } from '../../src/shared-types/structureBudgets.js';
import type { ShipPhysicsState } from '../../src/core/physics/World.js';

type Internals = {
  predWorld: PhysicsWorld | null;
  predSwarmKeys: Set<string>;
  _wrecks: WreckGeometryStore;
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, { x: number; y: number }>;
    swarm?: Map<number, SwarmRenderState>;
  };
  syncSwarmIntoPredWorld(): void;
};

/** One sub-capital wreck (a fighter's), as the server describes it. */
function fighterWreck(): { desc: WreckDescriptor; pieces: WreckPieceSpawn[] } {
  const pieces: WreckPieceSpawn[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 1, wreckKindOf: () => 'fighter', positionOf: () => null,
    spawnPiece: (s) => { pieces.push(s); return true; }, removePiece: () => {},
    isLive: () => true, pieceAngle: () => 0, kickPiece: () => {},
  });
  sys.forcedSeed = 3;
  sys.onDeath('v', 'fighter', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 1e4);
  return { desc: sys.descriptors()[0]!, pieces };
}

/** A wreck-piece swarm entry at (x, y) with one server pose in its ring. */
function pieceEntry(desc: WreckDescriptor, piece: WreckPieceSpawn, x: number, y: number, sleeping: boolean): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true });
  }
  Object.assign(ring[0]!, { x, y, serverTick: 10, arrivalMs: 160, sleeping, empty: false });
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, radius: piece.radius, kind: SWARM_KIND_WRECK,
    shipKind: 'fighter', componentIndex: piece.pieceIndex, wreckId: desc.wreckId,
    sleeping, lastUpdateTick: 10, poseRing: ring, ringHead: 1,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 160,
  } as SwarmRenderState;
}

describe('wreck pieces: predWorld cost per piece', () => {
  it('only pieces near the local ship get a predWorld body; far ones join as the ship closes', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'me';
    c.mirror.ships.set('me', { x: 0, y: 0 });
    const { desc, pieces } = fighterWreck();
    c._wrecks.apply([desc]);
    const swarm = new Map<number, SwarmRenderState>();
    // 10 pieces by the ship, 200 in a pile 4 km away (the soak's shape).
    for (let i = 0; i < 10; i++) swarm.set(100 + i, pieceEntry(desc, pieces[0]!, 50 * i, 300, false));
    for (let i = 0; i < 200; i++) swarm.set(1000 + i, pieceEntry(desc, pieces[0]!, 4000 + (i % 20) * 30, Math.floor(i / 20) * 30, false));
    c.mirror.swarm = swarm;

    c.syncSwarmIntoPredWorld();
    expect(c.predSwarmKeys.size, 'bodies with the pile 4 km away').toBe(10);

    // Fly to the pile: its pieces gain bodies, the ones left behind are released.
    c.mirror.ships.set('me', { x: 4300, y: 150 });
    c.syncSwarmIntoPredWorld();
    expect(c.predSwarmKeys.size, 'bodies beside the pile').toBe(200);
    for (const key of c.predSwarmKeys) expect(c.predWorld!.hasShip(key)).toBe(true);
    // Within the radius: the whole pile spans < 600 u.
    expect(4000 + 19 * 30 - 4300).toBeLessThan(PREDWORLD_STRUCTURE_RADIUS);
  });

  it('a piece the server reports asleep stays asleep through the anchor and the replayed steps', async () => {
    const w = await PhysicsWorld.create();
    const { desc, pieces } = fighterWreck();
    const swarm = new Map<number, SwarmRenderState>();
    const keys = new Map<number, string>();
    const N = 40;
    for (let i = 0; i < N; i++) {
      const p = pieces[i % pieces.length]!;
      const e = pieceEntry(desc, p, 200 * i, 2000, i % 2 === 0); // every other piece asleep
      swarm.set(i, e);
      keys.set(i, `swarm-${i}`);
      w.spawnObstacle(`swarm-${i}`, e.x, e.y, p.radius, p.mass, undefined, p.linearDamping, p.collisionGroups, p.colliderParts);
    }
    const scratch: ShipPhysicsState = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    let awakeAfter = 0;
    for (let snap = 0; snap < 3; snap++) {
      anchorRemoteSwarmBodies(w, swarm, 10, keys, scratch);
      for (let t = 0; t < 6; t++) w.tick(1 / 60); // the replay + tickPhysics steps
    }
    for (const key of keys.values()) if (!w.isSleeping(key)) awakeAfter++;
    expect(awakeAfter, 'awake wreck bodies = the server-awake ones').toBe(N / 2);
  });

  it('the local ship flying into a sleeping piece still wakes and shoves it', async () => {
    const w = await PhysicsWorld.create();
    const { desc, pieces } = fighterWreck();
    const p = pieces[0]!;
    const e = pieceEntry(desc, p, 0, 150, true);
    w.spawnObstacle('swarm-1', 0, 150, p.radius, p.mass, undefined, p.linearDamping, p.collisionGroups, p.colliderParts);
    const scratch: ShipPhysicsState = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    anchorRemoteSwarmBodies(w, new Map([[1, e]]), 10, new Map([[1, 'swarm-1']]), scratch);
    expect(w.isSleeping('swarm-1')).toBe(true);
    w.spawnShip('local', 0, 0);
    for (let i = 0; i < 120; i++) {
      w.applyInput('local', { thrust: true, turnLeft: false, turnRight: false });
      w.tick(1 / 60);
    }
    const s = w.getShipState('swarm-1')!;
    expect(Math.hypot(s.x, s.y - 150), 'the piece was shoved').toBeGreaterThan(0.5);
    expect(w.getShipState('local')!.y, 'the ship did not pass through').toBeLessThan(s.y);
  });
});
