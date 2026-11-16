/**
 * Rock cut — the cross-boundary lock (#15, #16): the real
 * `CapitalWreckSubsystem` wears a rock with mining-laser hits until it breaks;
 * its spawned bodies must be exactly what the real client
 * `WreckGeometryStore` rebuilds from the serialised descriptors (the rock's
 * root and a re-cut piece's child), with no vertex on the wire. The
 * descriptor round-trips its zod schema and the alloc-free guard; a rock
 * field on a child or with a ship `parentKind` is rejected.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn, type WreckPiecePose } from '../../../src/server/rooms/CapitalWreckSubsystem.js';
import type { WreckOre } from '../../../src/server/rooms/capitalWreckTypes.js';
import { WreckGeometryStore } from '../../../src/client/net/wreckGeometryStore.js';
import { isWreckDescriptor, WreckDescriptorSchema, type WreckDescriptor } from '../../../src/shared-types/messages/snapshotMessages.js';
import { WRECK_ROCK_PARENT_KIND } from '../../../src/shared-types/messages/wreckDescriptor.js';
import { asteroidShapeSeed } from '../../../src/core/swarm/asteroidShape.js';
import { wreckBodyParams } from '../../../src/core/destruction/wreckPieces.js';
import { rockWreckSource } from '../../../src/core/destruction/wreckSource.js';

const ROCK_ID = 'belt-2-5';
const R = 80;

function rig() {
  const poses = new Map<string, WreckPiecePose>([[ROCK_ID, { x: 500, y: -200, vx: 1, vy: 0, angle: 0.4, angvel: 0 }]]);
  const spawned: WreckPieceSpawn[] = [];
  const removed: string[] = [];
  const pods: Array<{ qty: number; ore: WreckOre | undefined }> = [];
  let rockLive = true;
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 9000,
    wreckKindOf: () => null,
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); poses.set(s.id, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel }); return true; },
    removePiece: (id) => { removed.push(id); poses.delete(id); if (id === ROCK_ID) rockLive = false; },
    isLive: (id) => poses.has(id),
    pieceAngle: (id) => poses.get(id)?.angle ?? null,
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => { const p = poses.get(id); return p ? { ...p } : null; },
    piecePoseInto: (id, out) => { const p = poses.get(id); if (!p) return false; Object.assign(out, p); return true; },
    dropSalvage: (qty, _x, _y, _vx, _vy, ore) => { pods.push({ qty, ore }); },
    rockOf: (id) => (id === ROCK_ID && rockLive ? { shape: asteroidShapeSeed(ROCK_ID), radius: R, resource: 'ice', resources: 50_000 } : null),
  });
  sys.forcedSeed = 3;
  return { sys, spawned, removed, pods, poses };
}

/** The descriptors as the snapshot carries them (a JSON round trip). */
const wire = (sys: CapitalWreckSubsystem): WreckDescriptor[] => JSON.parse(JSON.stringify(sys.descriptors())) as WreckDescriptor[];

describe('rock cut: server bodies == client rebuild (#15, #16)', () => {
  it('a mined-out rock breaks into pieces the client rebuilds exactly; other weapons do not wear it', () => {
    const { sys, spawned, removed } = rig();
    // A heavy beam (cuts wrecks) does not wear rock: nothing happens.
    for (let i = 0; i < 50; i++) expect(sys.onWreckHit(ROCK_ID, 420, -200, 1, 0, 1e4, 'heavy_beam', 'p1')).toBe(false);
    expect(sys.pieceIntegrity(ROCK_ID)).toBeUndefined();
    // The mining laser wears it to a break.
    let broke = false;
    for (let i = 0; i < 400 && !broke; i++) broke = sys.onWreckHit(ROCK_ID, 420, -195, 1, 0.05, 120, 'mining_laser', 'p1');
    expect(broke).toBe(true);
    expect(removed).toContain(ROCK_ID);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    const descs = wire(sys);
    expect(descs).toHaveLength(1);
    const d = descs[0]!;
    expect(d.parentKind).toBe(WRECK_ROCK_PARENT_KIND);
    expect(d.rock).toEqual({ id: ROCK_ID, shape: asteroidShapeSeed(ROCK_ID), r: R, res: 'ice' }); // an ice rock: its resource rides (the pieces keep its look)
    expect(d.cutKind).toBe('slice');
    expect(WreckDescriptorSchema.safeParse(d).success).toBe(true);
    expect(isWreckDescriptor(d)).toBe(true);
    // The client (a late joiner too: only the descriptor) rebuilds the bodies.
    const store = new WreckGeometryStore();
    store.apply(descs);
    for (const s of spawned) {
      const g = store.piece(d.wreckId, s.pieceIndex)!;
      expect(g).not.toBeNull();
      expect(g.parts).toEqual(s.parts);
      expect(g.colliderParts).toEqual(s.colliderParts);
      expect(g.mass).toBe(s.mass);
      expect(s.parentShipKind).toBeUndefined();
      // Same body params both sides (the leaf reads the rock via the store).
      expect(store.rockOf(d.wreckId)).toEqual(d.rock);
      const body = wreckBodyParams(rockWreckSource(store.rockOf(d.wreckId)!));
      expect(s.linearDamping).toBe(body.linearDamping);
      expect(s.collisionGroups).toBe(body.collisionGroups);
    }
  });

  it('a rock piece re-cuts like a wreck piece; the child resolves through the rock root; slivers pod the rock ore', () => {
    const { sys, spawned, pods, poses } = rig();
    for (let i = 0; i < 400 && sys.descriptors().length === 0; i++) sys.onWreckHit(ROCK_ID, 420, -195, 1, 0.05, 120, 'mining_laser', 'p1');
    const root = wire(sys)[0]!;
    const big = spawned.reduce((a, b) => (b.mass > a.mass ? b : a));
    const p = poses.get(big.id)!;
    // Other weapons do not wear a rock's piece either.
    const i0 = sys.pieceIntegrity(big.id)!;
    sys.onWreckHit(big.id, p.x - 1, p.y, 1, 0, 1e5, 'laser', 'p1');
    expect(sys.pieceIntegrity(big.id)).toBe(i0);
    const n0 = spawned.length;
    for (let i = 0; i < 400 && poses.has(big.id); i++) sys.onWreckHit(big.id, p.x - 1, p.y + 2, 0, 1, 120, 'mining_laser', 'p1');
    expect(poses.has(big.id), 'the piece broke').toBe(false);
    const descs = wire(sys);
    const child = descs.find((x) => x.parentWreck === root.wreckId);
    expect(child, 'the piece re-split into a child wreck (seed 3)').toBeDefined();
    if (child !== undefined) {
      expect(child.parentKind).toBe(WRECK_ROCK_PARENT_KIND);
      expect(child.rock).toBeUndefined();
      expect(WreckDescriptorSchema.safeParse(child).success).toBe(true);
      const store = new WreckGeometryStore();
      store.apply(descs);
      expect(store.rockOf(child.wreckId)).toEqual(root.rock);
      for (const s of spawned.slice(n0)) expect(store.piece(child.wreckId, s.pieceIndex)!.parts).toEqual(s.parts);
    } else {
      // Every child was a sliver: all pods.
      expect(pods.length).toBeGreaterThan(0);
    }
    // Grind everything to pods: each carries the rock's ore, never salvage.
    for (let round = 0; round < 60; round++) {
      const live = [...poses.keys()].filter((id) => id !== ROCK_ID);
      if (live.length === 0) break;
      for (const id of live) {
        const q = poses.get(id);
        if (q) sys.onWreckHit(id, q.x - 1, q.y, 1, 0, 1e4, 'mining_laser', 'p1');
      }
    }
    expect(pods.length).toBeGreaterThan(0);
    for (const pod of pods) {
      expect(pod.ore).toEqual({ rockId: ROCK_ID, resource: 'ice', perArea: expect.any(Number) });
      expect(pod.qty).toBeGreaterThan(0);
    }
    // The rock's ore is shared out by area, never minted: pods hold at most it.
    expect(pods.reduce((s, x) => s + x.qty, 0)).toBeLessThanOrEqual(50_000 + pods.length);
  });

  it('the schema rejects a rock on a child or under a ship parentKind', () => {
    const base = {
      wreckId: 5, parentKind: WRECK_ROCK_PARENT_KIND, seed: 1, killX: 0, killY: 0, killBlowDamage: 0,
      recentDamageRate: 0, snapChance: 0.2, algoVersion: 12, rock: { id: ROCK_ID, shape: 7, r: 40 },
    };
    expect(WreckDescriptorSchema.safeParse(base).success).toBe(true);
    expect(isWreckDescriptor(base)).toBe(true);
    const child = { ...base, parentWreck: 4, parentPiece: 0 };
    expect(WreckDescriptorSchema.safeParse(child).success).toBe(false);
    expect(isWreckDescriptor(child)).toBe(false);
    const ship = { ...base, parentKind: 'battleship' };
    expect(WreckDescriptorSchema.safeParse(ship).success).toBe(false);
    expect(isWreckDescriptor(ship)).toBe(false);
    const bad = { ...base, rock: { id: '', shape: 7, r: 40 } };
    expect(WreckDescriptorSchema.safeParse(bad).success).toBe(false);
    expect(isWreckDescriptor(bad)).toBe(false);
  });
});
