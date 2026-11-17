/**
 * Wreck re-split on the server (salvage stream PR 5/6, capital-destruction.md
 * §S4 "Re-split"), driven with plain mocks: hidden integrity wears per
 * weapon factor, a worn-out piece splits into a child wreck (its descriptor
 * names the parent; the parent's stays while the child lives), a too-small
 * piece or a full cap turns into salvage, and splits are rate-limited.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { WEAPONS } from '../../core/combat/WeaponCatalogue.js';
import { wreckChildGeometry, wreckChildSeed, type WreckChildChain } from '../../core/destruction/wreckChildren.js';
import { wreckPieceIntegrity, wreckSalvageQty, WRECK_RESPLITS_PER_TICK } from '../../core/destruction/wreckIntegrity.js';
import type { WreckDescriptor } from '../../shared-types/messages/snapshotMessages.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';

function make(kind: ShipKindId = 'battleship') {
  let tick = 1000;
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>();
  const drops: Array<{ qty: number; x: number; y: number }> = [];
  const splits: Array<{ from: string; ids: string[] }> = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: (id) => (id === 'cap' ? kind : null),
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? spawned.get(id)!.angle : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => {
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    dropSalvage: (qty, x, y) => { drops.push({ qty, x, y }); return `pod-${drops.length}`; },
    pieceSplit: (from, ids) => { splits.push({ from, ids: [...ids] }); },
  });
  sys.forcedSeed = 11;
  const pose = { x: 1000, y: -500, vx: 3, vy: 1, angle: 0.7, angvel: 0.01 };
  sys.onDeath('cap', kind, pose, 10_000);
  // Past any crack hold.
  tick += 10_000;
  return {
    sys, spawned, live, drops, splits,
    nextTick: () => { tick++; },
    livePieces: () => [...live],
    biggest: () => [...live].reduce((a, b) => (spawned.get(b)!.mass > spawned.get(a)!.mass ? b : a)),
    smallest: () => [...live].reduce((a, b) => (spawned.get(b)!.mass < spawned.get(a)!.mass ? b : a)),
  };
}

/** Hit piece `id` square on its centre from the +x side. */
function hit(sys: CapitalWreckSubsystem, s: WreckPieceSpawn, damage: number, weapon: 'laser' | 'railgun' = 'laser'): boolean {
  return sys.onWreckHit(s.id, s.x - 1, s.y, 1, 0, damage, weapon);
}

/** Run `fn` with the laser wearing wrecks at factor 1 (a stand-in for the
 *  mining laser, whose record lands with its own PR). */
function asMiner(fn: () => void): void {
  const def = WEAPONS.get('laser')!;
  def.targetFactor = { wreck: 1 };
  try { fn(); } finally { delete def.targetFactor; }
}

function chainOf(d: WreckDescriptor, byId: Map<number, WreckDescriptor>): WreckChildChain {
  const steps = [];
  let cur = d;
  while (cur.parentWreck !== undefined) {
    steps.push({ pieceIndex: cur.parentPiece!, killX: cur.killX, killY: cur.killY, cutKind: cur.cutKind, cutAng: cur.cutAng, cutW: cur.cutW });
    cur = byId.get(cur.parentWreck)!;
  }
  steps.reverse();
  return {
    root: {
      kindId: cur.parentKind as ShipKindId, seed: cur.seed, killX: cur.killX, killY: cur.killY,
      killBlowDamage: cur.killBlowDamage, recentDamageRate: cur.recentDamageRate, snapChance: cur.snapChance,
      cutKind: cur.cutKind, cutAng: cur.cutAng, cutW: cur.cutW,
    },
    steps,
  };
}

describe('wreck re-split (server)', () => {
  it('an ordinary gun needs 10x the damage the mining-like factor-1 weapon does', () => {
    const a = make();
    const id = a.biggest();
    const s = a.spawned.get(id)!;
    const iMax = wreckPieceIntegrity('battleship', s.mass);
    expect(a.sys.pieceIntegrity(id)).toBeCloseTo(iMax, 6);
    hit(a.sys, s, 100);
    expect(a.sys.pieceIntegrity(id)).toBeCloseTo(iMax - 10, 6);
    asMiner(() => hit(a.sys, s, 100));
    expect(a.sys.pieceIntegrity(id)).toBeCloseTo(iMax - 110, 6);
  });

  it('a worn-out big piece splits into a child wreck that names it; the parent descriptor stays while the child lives', () => {
    const a = make();
    const id = a.biggest();
    const s = a.spawned.get(id)!;
    const root = a.sys.descriptors()[0]!;
    const iMax = a.sys.pieceIntegrity(id)!;
    const before = a.livePieces().length;
    // Just short of worn out: still there, shoved.
    asMiner(() => { expect(hit(a.sys, s, iMax * 0.99)).toBe(true); });
    expect(a.live.has(id)).toBe(true);
    asMiner(() => { expect(hit(a.sys, s, iMax * 0.02)).toBe(true); });
    expect(a.live.has(id), 'the worn-out piece left').toBe(false);
    const descs = a.sys.descriptors();
    expect(descs.length).toBe(2);
    const child = descs.find((d) => d.parentWreck !== undefined)!;
    expect(child.parentWreck).toBe(root.wreckId);
    expect(child.parentPiece).toBe(s.pieceIndex);
    expect(child.seed).toBe(wreckChildSeed(root.seed, s.pieceIndex));
    expect(child.parentKind).toBe(root.parentKind);
    expect(child.algoVersion).toBe(root.algoVersion);
    const kids = [...a.live].map((k) => a.spawned.get(k)!).filter((k) => k.wreckId === child.wreckId);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    expect(a.livePieces().length).toBe(before - 1 + kids.length);

    // Determinism (#15): the spawned children are wreckChildGeometry of the
    // chain the descriptors name, which is what a client rebuilds.
    const byId = new Map(descs.map((d) => [d.wreckId, d]));
    const geom = wreckChildGeometry(chainOf(child, byId));
    for (const k of kids) {
      const g = geom.find((x) => x.index === k.pieceIndex)!;
      expect(k.parts).toEqual(g.parts);
      expect(k.colliderParts).toEqual(g.colliderParts);
      expect(k.mass).toBe(g.mass);
    }
    // Placement: the children tile the parent, so their mass centre is
    // where the parent's centre was (frame mapping from the live pose).
    let mx = 0, my = 0, m = 0;
    for (const k of kids) { mx += k.x * k.mass; my += k.y * k.mass; m += k.mass; }
    expect(m).toBeCloseTo(s.mass, 0);
    expect(Math.hypot(mx / m - s.x, my / m - s.y)).toBeLessThan(1e-3 * Math.sqrt(s.mass));
    // The children part (no child closes on the hit point's side).
    for (const k of kids) expect(Number.isFinite(k.vx) && Number.isFinite(k.vy)).toBe(true);

    // Refcount: every root piece gone, the root descriptor stays for the child.
    for (const p of a.livePieces()) if (a.spawned.get(p)!.wreckId === root.wreckId) { a.live.delete(p); a.sys.pieceGone(p); }
    expect(a.sys.descriptors().map((d) => d.wreckId).sort()).toEqual([root.wreckId, child.wreckId].sort());
    for (const k of kids) { a.live.delete(k.id); a.sys.pieceGone(k.id); }
    expect(a.sys.descriptors().length).toBe(0);
  });

  it('a worn-out piece too small to split becomes a salvage pod worth its mass share', () => {
    const a = make();
    let pods = 0;
    asMiner(() => {
      for (let i = 0; i < 400 && a.drops.length === 0; i++) {
        const id = a.smallest();
        const s = a.spawned.get(id)!;
        hit(a.sys, s, a.sys.pieceIntegrity(id)! + 1);
        a.nextTick();
        if (a.drops.length > pods) {
          pods = a.drops.length;
          expect(a.drops[0]!.qty).toBe(wreckSalvageQty('battleship', s.mass));
          expect(a.live.has(id)).toBe(false);
        }
      }
    });
    expect(a.drops.length, 'grinding the smallest pieces ends in a salvage pod').toBe(1);
  });

  it(`splits at most ${WRECK_RESPLITS_PER_TICK} pieces per tick; the rest split on a later hit`, () => {
    const a = make();
    const ids = a.livePieces().slice(0, WRECK_RESPLITS_PER_TICK + 1);
    const descs = () => a.sys.descriptors().length;
    asMiner(() => {
      for (const id of ids) hit(a.sys, a.spawned.get(id)!, a.sys.pieceIntegrity(id)! + 1);
      const last = ids[ids.length - 1]!;
      expect(a.live.has(last), 'over budget: still there').toBe(true);
      expect(a.sys.pieceIntegrity(last)!).toBeLessThanOrEqual(0);
      const n = descs();
      a.nextTick();
      hit(a.sys, a.spawned.get(last)!, 1);
      expect(a.live.has(last)).toBe(false);
      expect(descs() + a.drops.length).toBeGreaterThan(n);
    });
  });

  it('with the sub-cap FIFO full, a worn-out piece turns to salvage instead of splitting', () => {
    const a = make('fighter');
    const id = a.biggest();
    a.sys.subcapCapOverride = a.sys.liveSubcapCount();
    asMiner(() => hit(a.sys, a.spawned.get(id)!, a.sys.pieceIntegrity(id)! + 1));
    expect(a.live.has(id)).toBe(false);
    expect(a.drops.length).toBe(1);
    expect(a.sys.descriptors().every((d) => d.parentWreck === undefined)).toBe(true);
  });

  it('a piece worn out into a pod hands no lock to the pod (a pod is never a lineage member: owner 2026-11-17)', () => {
    const a = make('fighter');
    const id = a.biggest();
    a.sys.subcapCapOverride = a.sys.liveSubcapCount();
    asMiner(() => hit(a.sys, a.spawned.get(id)!, a.sys.pieceIntegrity(id)! + 1));
    expect(a.drops.length, 'the piece wore out into a pod').toBe(1);
    expect(a.splits, 'no split names the pod: the locks move on through the lineage').toEqual([]);
  });
});
