/**
 * Wreck lineage: every wreck in a re-split chain names the root wreck it
 * descends from (`LiveWreck.root`), and `forEachLineagePiece` visits every
 * live piece of that lineage (for lasers spreading over a locked rock's or
 * wreck's pieces). Grandchildren report the original root, for a ship's
 * wreck and for a cut rock alike.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { wreckWearFactor } from '../../core/destruction/wreckIntegrity.js';
import type { WreckDescriptor } from '../../shared-types/messages/snapshotMessages.js';

const ROCK = 'rock-1';

function make() {
  let tick = 1000;
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>([ROCK]);
  const rockPose = { x: 0, y: 400, vx: 0, vy: 0, angle: 0.3, angvel: 0 };
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: (id) => (id.startsWith('cap') ? 'battleship' : null),
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? (spawned.get(id)?.angle ?? rockPose.angle) : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => {
      if (id === ROCK) return live.has(ROCK) ? rockPose : null;
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    dropSalvage: () => {},
    rockOf: (id) => (id === ROCK && live.has(ROCK) ? { shape: 4242, radius: 400, resource: 'rock', resources: undefined } : null),
  });
  sys.forcedSeed = 11;
  return { sys, spawned, live, nextTick: () => { tick++; } };
}

type Rig = ReturnType<typeof make>;

/** Wear the biggest live piece of wreck `wreckId` out with the mining laser
 *  until it re-splits; returns the child wreck's descriptor. */
function splitBiggestOf(r: Rig, wreckId: number, rock: boolean): WreckDescriptor {
  const before = new Set(r.sys.descriptors().map((d) => d.wreckId));
  const mine = [...r.live].map((id) => r.spawned.get(id)).filter((s): s is WreckPieceSpawn => s !== undefined && s.wreckId === wreckId);
  const s = mine.reduce((a, b) => (b.mass > a.mass ? b : a));
  const f = wreckWearFactor('mining_laser', rock);
  for (let i = 0; i < 5 && r.live.has(s.id); i++) {
    const dmg = (r.sys.pieceIntegrity(s.id)! / f) * 1.01;
    r.sys.onWreckHit(s.id, s.x - 1, s.y, 1, 0, dmg, 'mining_laser');
    r.nextTick();
  }
  expect(r.live.has(s.id), 'the worn-out piece split').toBe(false);
  const child = r.sys.descriptors().find((d) => !before.has(d.wreckId));
  expect(child, 'a child wreck').toBeDefined();
  expect(child!.parentWreck).toBe(wreckId);
  return child!;
}

function lineage(r: Rig, root: number): string[] {
  const out: string[] = [];
  r.sys.forEachLineagePiece(root, (id) => out.push(id));
  return out.sort();
}

function expectGrandchildrenReportRoot(r: Rig, root: number, rock: boolean): void {
  const child = splitBiggestOf(r, root, rock);
  const grand = splitBiggestOf(r, child.wreckId, rock);
  const grandPieces = [...r.live].filter((id) => r.spawned.get(id)?.wreckId === grand.wreckId);
  expect(grandPieces.length).toBeGreaterThanOrEqual(2);
  for (const id of grandPieces) expect(r.sys.lineageRootOf(id), 'a grandchild names the original root').toBe(root);
  // Every live piece of the lineage (root, child and grandchild pieces) is visited, once.
  const want = [...r.live].filter((id) => {
    const w = r.spawned.get(id)?.wreckId;
    return w === root || w === child.wreckId || w === grand.wreckId;
  }).sort();
  expect(lineage(r, root)).toEqual(want);
  expect(lineage(r, child.wreckId), 'a child is no lineage root').toEqual([]);
}

describe('wreck lineage root', () => {
  it('a ship wreck: re-split grandchildren report the original root; another wreck is not in its lineage', () => {
    const r = make();
    r.sys.onDeath('cap-a', 'battleship', { x: 1000, y: -500, vx: 0, vy: 0, angle: 0.7, angvel: 0 }, 10_000);
    const rootA = r.sys.descriptors()[0]!.wreckId;
    r.sys.onDeath('cap-b', 'battleship', { x: -9000, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 10_000);
    const rootB = r.sys.descriptors().find((d) => d.wreckId !== rootA)!.wreckId;
    for (let i = 0; i < 10_000; i++) r.nextTick(); // past any crack hold
    expectGrandchildrenReportRoot(r, rootA, false);
    const bPieces = [...r.live].filter((id) => r.spawned.get(id)?.wreckId === rootB).sort();
    expect(lineage(r, rootB)).toEqual(bPieces);
    for (const id of bPieces) expect(lineage(r, rootA)).not.toContain(id);
  });

  it('a cut rock: re-split grandchildren report the rock break\'s root wreck', () => {
    const r = make();
    for (let i = 0; i < 400 && r.live.has(ROCK); i++) {
      r.sys.onWreckHit(ROCK, 6, 0, 0, 1, 5_000, 'mining_laser');
      r.nextTick();
    }
    expect(r.live.has(ROCK), 'the rock broke').toBe(false);
    const desc = r.sys.descriptors().find((d) => d.rock?.id === ROCK)!;
    expect(desc).toBeDefined();
    expectGrandchildrenReportRoot(r, desc.wreckId, true);
  });
});
