/**
 * Fracture v12 multi-cut, the server half (owner 2026-11-15, "one cut per
 * beam"): `CapitalWreckSubsystem` keeps each hull's and each wreck piece's
 * recent cutting-beam lines (`BurnLines`, any shooter), and both breaks use
 * them: a live ship's kill split and a worn-out piece's re-split cut along
 * every line, the descriptor carries the further lines, and a re-split child
 * under the kind's re-split floor turns into a salvage pod. Plain mocks.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn, type WreckPiecePose } from './CapitalWreckSubsystem.js';
import { wreckPieceGeometry, type WreckFractureInputs } from '../../core/destruction/wreckPieces.js';
import { wreckChildGeometry } from '../../core/destruction/wreckChildren.js';
import { wreckHullArea } from '../../core/destruction/wreckIntegrity.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import type { WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';

function make() {
  let tick = 1000;
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const pods: Array<{ qty: number; x: number; y: number }> = [];
  const hullPose = { x: 0, y: 0, angle: 0 };
  const poseOf = (id: string): WreckPiecePose | null => {
    const s = spawned.find((p) => p.id === id);
    return s === undefined || !live.has(id) ? null : { x: s.x, y: s.y, vx: 0, vy: 0, angle: 0, angvel: 0 };
  };
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: (id) => (id === 'cap' ? 'battleship' : null),
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? 0 : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: poseOf,
    piecePoseInto: (id, out) => {
      const p = poseOf(id);
      if (p === null) return false;
      Object.assign(out, p);
      return true;
    },
    hullPoseInto: (id, out) => {
      if (id !== 'cap') return false;
      out.x = hullPose.x; out.y = hullPose.y; out.angle = hullPose.angle;
      return true;
    },
    dropSalvage: (qty, x, y) => { pods.push({ qty, x, y }); },
  });
  return { sys, spawned, live, pods, hullPose, setTick: (t: number) => { tick = t; }, now: () => tick };
}

const inputsOf = (d: WreckDescriptor): WreckFractureInputs => ({
  kindId: 'battleship', seed: d.seed, killX: d.killX, killY: d.killY, killBlowDamage: d.killBlowDamage,
  recentDamageRate: d.recentDamageRate, snapChance: d.snapChance, cutKind: d.cutKind, cutAng: d.cutAng, cutW: d.cutW,
  extraCuts: d.extraCuts,
});

describe('multi-cut: the kill split of a live ship cuts along every beam that burned it', () => {
  it('two ships firing heavy beams together: the wreck carries both lines and its pieces are cut by both', () => {
    const { sys, spawned } = make();
    sys.forcedSeed = 7;
    const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    // Ship B's beam crosses the hull at 90° to ship A's, then A's beam kills.
    sys.noteHit('cap', 'shipB', 100, 0, -400, 0, 1, 'heavy_beam');
    sys.noteHit('cap', 'shipA', 100, -2000, 0, 1, 0, 'heavy_beam');
    expect(sys.onDeath('cap', 'battleship', pose, 1e6).pieces).toBeGreaterThan(0);
    const d = sys.descriptors()[0]!;
    expect(d.cutKind).toBe('slice');
    expect(d.extraCuts, 'ship B\'s line rides the descriptor').toHaveLength(1);
    expect(d.extraCuts![0]!.w).toBeGreaterThan(0); // the heavy beam's strip
    // The bodies are the descriptor's pieces (what the client rebuilds), and
    // the second line changed them.
    const geom = wreckPieceGeometry(inputsOf(d));
    expect(spawned.map((s) => s.parts)).toEqual(geom.map((g) => g.parts));
    expect(wreckPieceGeometry({ ...inputsOf(d), extraCuts: undefined })).not.toEqual(geom);
  });

  it('a line older than ~1 s, a non-cutting gun and the killing beam\'s own line add no further cut', () => {
    const { sys, setTick } = make();
    sys.forcedSeed = 7;
    const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    sys.noteHit('cap', 'shipB', 100, 0, -400, 0, 1, 'heavy_beam');
    setTick(1100);
    sys.noteHit('cap', 'shipC', 100, 300, -400, 0, 1, 'laser' as WeaponId);
    sys.noteHit('cap', 'shipA', 100, -2000, 0, 1, 0, 'heavy_beam');
    sys.noteHit('cap', 'shipA', 100, -2000, 1, 1, 0, 'heavy_beam');
    sys.onDeath('cap', 'battleship', pose, 1e6);
    expect(sys.descriptors()[0]!.extraCuts).toBeUndefined();
  });
});

describe('multi-cut: a worn-out piece re-splits along every beam that burned it', () => {
  /** A battleship wreck (seed 5: a ~15 % piece among five), then three beams
   *  on that piece: a heavy beam across its centre, a mining laser across
   *  its far corner (`f` of the way to its farthest vertex), and the heavy
   *  beam along that vertex through the centre, wearing it out. */
  function threeBeams(f: number) {
    const m = make();
    const { sys, spawned, live, setTick } = m;
    sys.forcedSeed = 5;
    sys.noteHit('cap', 'gun', 60_000, 300, -700);
    sys.onDeath('cap', 'battleship', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 1e5);
    const root = sys.descriptors()[0]!;
    setTick(1000 + wreckCrackTicks() + 1);
    const H = wreckHullArea('battleship');
    const piece = spawned.reduce((a, b) => (Math.abs(b.mass - 0.15 * total(spawned)) < Math.abs(a.mass - 0.15 * total(spawned)) ? b : a));
    expect(piece.mass / total(spawned)).toBeGreaterThan(0.1);
    // Its farthest vertex v (body frame = world offset: the piece is unturned).
    let v = { x: 1, y: 0 };
    for (const part of piece.parts) for (const p of part) if (Math.hypot(p.x, p.y) > Math.hypot(v.x, v.y)) v = { x: p.x, y: p.y };
    const vl = Math.hypot(v.x, v.y);
    const u = { x: v.x / vl, y: v.y / vl };
    const n = { x: -u.y, y: u.x };
    expect(sys.onWreckHit(piece.id, piece.x, piece.y, n.x, n.y, 1, 'heavy_beam', 'lance')).toBe(true);
    expect(sys.onWreckHit(piece.id, piece.x + v.x * f, piece.y + v.y * f, n.x, n.y, 1, 'mining_laser', 'miner')).toBe(true);
    const before = spawned.length;
    expect(sys.onWreckHit(piece.id, piece.x, piece.y, u.x, u.y, 1e12, 'heavy_beam', 'lance')).toBe(true);
    expect(live.has(piece.id)).toBe(false);
    const child = sys.descriptors().find((d) => d.parentWreck === root.wreckId);
    const geom = child === undefined ? [] : wreckChildGeometry({
      root: inputsOf(root),
      steps: [{ pieceIndex: child.parentPiece!, killX: child.killX, killY: child.killY, cutKind: child.cutKind, cutAng: child.cutAng, cutW: child.cutW, extraCuts: child.extraCuts }],
    });
    return { ...m, child, geom, kids: spawned.slice(before), floor: DESTRUCTION_PROFILES.capital.resplit!.minAreaFrac * H };
  }
  const total = (s: WreckPieceSpawn[]): number => s.reduce((a, p) => a + p.mass, 0);

  it('3 beams on one piece: 3 cuts, every child the client rebuilds, each one under the re-split floor a salvage pod', () => {
    let sawPod = false;
    // The corner cut, from deep in the piece out toward its tip: somewhere
    // its corner child is under the floor (2 % of the hull).
    for (let f = 0.5; f <= 0.96; f += 0.04) {
      const { child, geom, kids, pods, floor } = threeBeams(f);
      expect(child, 'a child wreck').toBeDefined();
      expect(child!.extraCuts, 'two further lines besides the breaking beam').toHaveLength(2);
      const small = geom.filter((g) => g.area < floor);
      expect(pods).toHaveLength(small.length);
      expect(kids).toHaveLength(geom.length - small.length);
      expect(geom.length, 'three cuts: more children than one fracture (2-3)').toBeGreaterThanOrEqual(4);
      for (const k of kids) {
        const g = geom.find((x) => x.index === k.pieceIndex)!;
        expect(g.area).toBeGreaterThanOrEqual(floor);
        expect(k.parts).toEqual(g.parts);
        expect(k.wreckId).toBe(child!.wreckId);
      }
      if (small.length > 0) sawPod = true;
    }
    expect(sawPod, 'some corner cut leaves a child under the floor: a pod').toBe(true);
  });
});
