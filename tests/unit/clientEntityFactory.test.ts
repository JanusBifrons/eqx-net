/**
 * Generic Entity Pipeline B4 lock — the client EntityFactory + leaves (the OOP
 * peer of the server leaves, replacing the `swarmKindProfile` data table).
 *
 * Asserts the spawn-time routing seam:
 *   - kind 0/1/2 resolve to the asteroid/drone/structure leaf;
 *   - an unrecognised kind resolves to `null` → the caller SKIPS it (HC#2 — a
 *     future pose-core kind must NOT be mis-routed as a drone);
 *   - each leaf's construction is byte-identical to the pre-refactor
 *     `syncSwarmIntoPredWorld` decisions:
 *       · asteroid: polygon collider + lock + repose, no AI, no shield;
 *       · drone: circular + catalogue mass + UNLOCKED + AI register + shield
 *         swap, never re-posed (the kinematic follower owns drone pose);
 *       · structure: POLYGON (structureHullPoints) + lock + repose, no AI, no shield;
 *   - `staticBody` derives from `!descriptor.sync.interpolated` (only static
 *     kinds re-pose via setShipState).
 *
 * Pure: a fake `PredWorldHandle` / `AiLedgerHandle` records calls — no Rapier
 * world, no ColyseusClient.
 */
import { describe, it, expect } from 'vitest';
import {
  SWARM_KIND_ASTEROID,
  SWARM_KIND_DRONE,
  SWARM_KIND_STRUCTURE,
} from '../../src/shared-types/swarmWireFormat.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { structureHullPoints } from '../../src/shared-types/structureKinds.js';
import { ClientEntityFactory } from '../../src/client/net/entity/ClientEntityFactory.js';
import type {
  ClientSpawnCtx,
  PredWorldHandle,
  AiLedgerHandle,
  SwarmRenderState,
} from '../../src/client/net/entity/IClientEntityLeaf.js';

interface Call {
  m: string;
  args: unknown[];
}

function makePredWorld(): { handle: PredWorldHandle; calls: Call[] } {
  const calls: Call[] = [];
  const handle: PredWorldHandle = {
    hasShip: () => false,
    spawnObstacle: (...args: unknown[]) => calls.push({ m: 'spawnObstacle', args }),
    lockBody: (...args: unknown[]) => calls.push({ m: 'lockBody', args }),
    setHullExposed: (...args: unknown[]) => calls.push({ m: 'setHullExposed', args }),
    setShipState: (...args: unknown[]) => calls.push({ m: 'setShipState', args }),
  } as unknown as PredWorldHandle;
  return { handle, calls };
}

function makeAi(): { handle: AiLedgerHandle; calls: Call[] } {
  const calls: Call[] = [];
  const handle: AiLedgerHandle = {
    register: (...args: unknown[]) => calls.push({ m: 'register', args }),
    unregister: (...args: unknown[]) => calls.push({ m: 'unregister', args }),
  } as unknown as AiLedgerHandle;
  return { handle, calls };
}

function makeEntry(kind: number, shipKind = 'scout'): SwarmRenderState {
  return {
    x: 100,
    y: 200,
    vx: 1,
    vy: 2,
    angle: 0.5,
    angvel: 0.1,
    radius: 24,
    kind,
    shipKind,
    shieldDown: false,
  } as unknown as SwarmRenderState;
}

function makeCtx(kind: number, shipKind = 'scout') {
  const pw = makePredWorld();
  const ai = makeAi();
  const ctx: ClientSpawnCtx = {
    predWorld: pw.handle,
    aiController: ai.handle,
    entityId: 42,
    key: 'swarm-42',
    entry: makeEntry(kind, shipKind),
    registeredAiId: null,
  };
  return { ctx, pw, ai };
}

const factory = new ClientEntityFactory();

describe('ClientEntityFactory.leafFor — routing (HC#2)', () => {
  it('maps each pose-core kind byte to its leaf, with the matching poseCoreKind', () => {
    expect(factory.leafFor(SWARM_KIND_ASTEROID)?.poseCoreKind).toBe(SWARM_KIND_ASTEROID);
    expect(factory.leafFor(SWARM_KIND_DRONE)?.poseCoreKind).toBe(SWARM_KIND_DRONE);
    expect(factory.leafFor(SWARM_KIND_STRUCTURE)?.poseCoreKind).toBe(SWARM_KIND_STRUCTURE);
  });

  it('returns null for an unrecognised kind — caller SKIPS, never the drone path', () => {
    expect(factory.leafFor(7)).toBeNull();
    expect(factory.leafFor(255)).toBeNull();
    expect(factory.leafFor(-1)).toBeNull();
  });
});

describe('AsteroidClientLeaf (kind 0) — static polygon, no AI, no shield', () => {
  it('spawnBody: polygon collider + lockBody, never registers AI', () => {
    const { ctx, pw, ai } = makeCtx(SWARM_KIND_ASTEROID);
    factory.leafFor(SWARM_KIND_ASTEROID)!.spawnBody(ctx);
    const spawn = pw.calls.find((c) => c.m === 'spawnObstacle')!;
    expect(spawn).toBeDefined();
    expect(Array.isArray(spawn.args[5])).toBe(true); // deterministic vertices (polygon)
    expect((spawn.args[5] as unknown[]).length).toBeGreaterThan(2);
    expect(pw.calls.some((c) => c.m === 'lockBody')).toBe(true);
    expect(ai.calls.length).toBe(0);
    expect(ctx.registeredAiId).toBeNull();
  });

  it('onSync: re-poses (setShipState), never swaps a shield', () => {
    const { ctx, pw } = makeCtx(SWARM_KIND_ASTEROID);
    factory.leafFor(SWARM_KIND_ASTEROID)!.onSync(ctx);
    expect(pw.calls.some((c) => c.m === 'setShipState')).toBe(true);
    expect(pw.calls.some((c) => c.m === 'setHullExposed')).toBe(false);
  });
});

describe('DroneClientLeaf (kind 1) — dynamic, AI ledger, shield swap', () => {
  it('spawnBody: circular collider + catalogue mass + UNLOCKED + AI register', () => {
    // Use a kind with an explicit catalogue mass (crossguard = 30) to prove the
    // body uses the catalogue mass, NOT the hardcoded fallback (the 2026-05-28
    // mass-match fix). Most kinds (scout/fighter) leave `mass` undefined.
    const { ctx, pw, ai } = makeCtx(SWARM_KIND_DRONE, 'crossguard');
    factory.leafFor(SWARM_KIND_DRONE)!.spawnBody(ctx);
    const spawn = pw.calls.find((c) => c.m === 'spawnObstacle')!;
    expect(spawn.args[5]).toBeUndefined(); // circular (no vertices)
    expect(spawn.args[4]).toBe(getShipKind('crossguard').mass); // mass-match (2026-05-28)
    expect(spawn.args[4]).not.toBe(3); // proves it is NOT the fallback
    expect(pw.calls.some((c) => c.m === 'lockBody')).toBe(false); // dynamic
    expect(ai.calls.some((c) => c.m === 'register')).toBe(true);
    expect(ctx.registeredAiId).toBe(42);
  });

  it('spawnBody: falls back to mass 3 when the kind has no catalogue mass (scout)', () => {
    const { ctx, pw } = makeCtx(SWARM_KIND_DRONE, 'scout');
    factory.leafFor(SWARM_KIND_DRONE)!.spawnBody(ctx);
    const spawn = pw.calls.find((c) => c.m === 'spawnObstacle')!;
    expect(getShipKind('scout').mass).toBeUndefined(); // most kinds omit mass
    expect(spawn.args[4]).toBe(3); // fallback, byte-identical to the old code
  });

  it('onSync: swaps the shield collider, never re-poses (follower owns drone pose)', () => {
    const { ctx, pw } = makeCtx(SWARM_KIND_DRONE);
    factory.leafFor(SWARM_KIND_DRONE)!.onSync(ctx);
    expect(pw.calls.some((c) => c.m === 'setHullExposed')).toBe(true);
    expect(pw.calls.some((c) => c.m === 'setShipState')).toBe(false);
  });
});

describe('StructureClientLeaf (kind 2) — static, no AI, no shield, damageable server-side', () => {
  it('spawnBody: POLYGON collider (structureHullPoints) + lockBody, never registers AI', () => {
    const { ctx, pw, ai } = makeCtx(SWARM_KIND_STRUCTURE, 'capital');
    factory.leafFor(SWARM_KIND_STRUCTURE)!.spawnBody(ctx);
    const spawn = pw.calls.find((c) => c.m === 'spawnObstacle')!;
    // Unified-hull: the structure's polygon hull (from the single hull-points
    // source) is its collider — matching the rendered silhouette AND the server
    // collider built from the same points. Replaces the old circular collider.
    expect(spawn.args[5]).toEqual(structureHullPoints('capital', 24)); // entry radius 24
    expect(pw.calls.some((c) => c.m === 'lockBody')).toBe(true);
    expect(ai.calls.length).toBe(0);
    expect(ctx.registeredAiId).toBeNull();
  });

  it('onSync: re-poses (setShipState), never swaps a shield', () => {
    const { ctx, pw } = makeCtx(SWARM_KIND_STRUCTURE);
    factory.leafFor(SWARM_KIND_STRUCTURE)!.onSync(ctx);
    expect(pw.calls.some((c) => c.m === 'setShipState')).toBe(true);
    expect(pw.calls.some((c) => c.m === 'setHullExposed')).toBe(false);
  });
});
