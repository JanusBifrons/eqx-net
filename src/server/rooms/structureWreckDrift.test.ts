/**
 * Structure break-up: a destroyed structure's pieces part and drift like a
 * SHIP WRECK OF ITS SIZE (owner: "pieces act EXACTLY like ship wrecks, break
 * scaled by size"). Driven through THE death path
 * (`CapitalWreckSubsystem.onDeath`, plus `tick()` for a capital's held kick)
 * with plain mocks, for every breaking structure kind and every wrecking
 * ship kind, the same killing blow by share of the hull at the same
 * relative point. Speeds are ABSOLUTE (u/s): a radius-330 structure parted
 * per radius like a sub-cap (~950 u/s), rammed its neighbours for 700-1,400
 * damage and chain-killed the base, where a capital ship parts at ~3-9 u/s.
 * A structure's reference is the ships of its size: between the two ships
 * whose radii bracket it, log-log (no ship is 110-1220 u). Both breaks: a
 * clean snap in two and a shatter into wedges.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { asWreckSource, structureBreaks, structureWreckSource, type WreckSource } from '../../core/destruction/wreckSource.js';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds.js';
import { SHIP_KINDS_LIST, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { fracturePlan } from '../../core/destruction/fractureHull.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';

/** The first seed whose death is (or is not) a clean snap: the draw is the
 *  seed's alone, so any hull of cap ≥ 2 answers for every kind. */
function seedWhere(snap: boolean): number {
  const square = [[-50, -50], [50, -50], [50, 50], [-50, 50]] as const;
  const snapChance = DESTRUCTION_PROFILES.structure.fracture!.snapChance;
  for (let seed = 1; ; seed++) {
    if (fracturePlan({ hull: square, seed, killPoint: { x: 0, y: 0 }, maxPieces: 6, snapChance }).snap === snap) return seed;
  }
}

interface Death { spawned: WreckPieceSpawn[]; speed: number[]; radius: number }

/** A death through the real path; each piece's speed (u/s) once it has
 *  parted (a capital's held kick included). */
function deathOf(source: ShipKindId | WreckSource, seed: number | null = null): Death {
  const spawned: WreckPieceSpawn[] = [];
  const kick = new Map<string, [number, number]>();
  let now = 1000;
  const sys = new CapitalWreckSubsystem({
    serverTick: () => now,
    wreckKindOf: () => source,
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); return true; },
    removePiece: () => {},
    isLive: () => true,
    pieceAngle: () => 0,
    kickPiece: (id, dvx, dvy) => { kick.set(id, [dvx, dvy]); },
    impulsePiece: () => {},
    pieceCentreInto: () => false,
  });
  sys.forcedSeed = seed;
  const src = asWreckSource(source);
  sys.noteHit('t', 'attacker', 0.2 * src.maxHull, 0.4 * src.radius, 0.1 * src.radius, -1, 0);
  sys.onDeath('t', source, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, src.maxHull);
  now += 600;
  sys.tick();
  const speed = spawned.map((p) => {
    const k = kick.get(p.id) ?? [0, 0];
    return Math.hypot(p.vx + k[0], p.vy + k[1]);
  });
  return { spawned, speed, radius: src.radius };
}

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Distance (u) a piece at `v` covers in 2 s after parting (exponential damping). */
const in2s = (v: number, damping: number): number => (v / damping) * (1 - Math.exp(-2 * damping));

/** Median piece speed and 2 s distance of a death. */
function partingOf(d: Death): { v: number; d2: number } {
  const v = median(d.speed);
  return { v, d2: in2s(v, d.spawned[0]!.linearDamping) };
}

/** How long (s) a piece coasts before it drops under its settle speed and
 *  sleeps (exponential damping; collisions aside), in radii-free terms. */
function coastSeconds(d: Death): number[] {
  return d.spawned.map((p, i) => {
    const v = d.speed[i]!;
    const settle = p.settleSpeed ?? 0;
    return settle > 0 && v > settle ? Math.log(v / settle) / p.linearDamping : 0;
  }).sort((a, b) => a - b);
}

// Every wrecking ship kind, by radius (kinds of one radius: their median).
const shipRef = new Map<number, { v: number[]; d2: number[] }>();
for (const k of SHIP_KINDS_LIST) {
  if (shipTuning(k).destruction === 'none') continue;
  const p = partingOf(deathOf(k.id as ShipKindId, 7));
  const row = shipRef.get(k.radius) ?? { v: [], d2: [] };
  row.v.push(p.v);
  row.d2.push(p.d2);
  shipRef.set(k.radius, row);
}
const shipRadii = [...shipRef.keys()].sort((a, b) => a - b);

/** The ships of radius `r`: log-log between the two bracketing radii. */
function shipsOfSize(r: number): { v: number; d2: number; near: string } {
  const lo = [...shipRadii].reverse().find((x) => x <= r) ?? shipRadii[0]!;
  const hi = shipRadii.find((x) => x >= r) ?? shipRadii[shipRadii.length - 1]!;
  const a = shipRef.get(lo)!;
  const b = shipRef.get(hi)!;
  const t = hi === lo ? 0 : Math.log(r / lo) / Math.log(hi / lo);
  const lerp = (x: number, y: number): number => Math.exp(Math.log(x) + t * (Math.log(y) - Math.log(x)));
  return { v: lerp(median(a.v), median(b.v)), d2: lerp(median(a.d2), median(b.d2)), near: `ships r=${lo}..${hi}` };
}

describe('structure wreck pieces part like a ship wreck of their size', () => {
  const nexus = deathOf('robot-nexus');
  const nexusCoast = median(coastSeconds(nexus));

  it('the reference ships part (sanity): sub-caps fast, capitals slow', () => {
    expect(shipRadii.length).toBeGreaterThan(4);
    expect(median(nexus.speed)).toBeGreaterThan(100);
    expect(shipsOfSize(1220).v).toBeLessThan(10);
    expect(nexusCoast).toBeGreaterThan(3);
  });

  const breaks = [['shatter', seedWhere(false)], ['snap', seedWhere(true)]] as const;
  for (const kind of STRUCTURE_KINDS_LIST) {
    if (!structureBreaks(kind.id, true)) continue;
    for (const [mode, seed] of breaks) it(`${kind.id} (${mode}): pieces part as fast (u/s) and as far in 2 s as ships of its size, and coast as long`, () => {
      const d = deathOf(structureWreckSource({ k: kind.id }), seed);
      expect(d.spawned.length).toBeGreaterThanOrEqual(2);
      if (mode === 'snap') expect(d.spawned.length).toBe(2);
      const ref = shipsOfSize(d.radius);
      const p = partingOf(d);
      const ctx = `${kind.id} r=${d.radius.toFixed(0)} v=${p.v.toFixed(1)} d2=${p.d2.toFixed(1)} vs ${ref.near} v=${ref.v.toFixed(1)} d2=${ref.d2.toFixed(1)}`;
      // Every piece moves off, and the wreck parts like ships of its size.
      // A snap is two halves, like a ship's: 0.5-1.5×. A shatter's wedges
      // are lighter (1/6 of the hull), and a kick is an impulse against the
      // piece's mass, so they run up to ~1.7× a ship half's: 0.5-1.75×.
      const hi = mode === 'snap' ? 1.5 : 1.75;
      expect(Math.min(...d.speed), ctx).toBeGreaterThan(0.25 * ref.v);
      expect(p.v / ref.v, ctx).toBeGreaterThan(0.5);
      expect(p.v / ref.v, ctx).toBeLessThan(hi);
      expect(p.d2 / ref.d2, ctx).toBeGreaterThan(0.5);
      expect(p.d2 / ref.d2, ctx).toBeLessThan(hi);
      // ...and drifts for seconds before it settles, not ~1 s (its settle
      // speed scales with its parting speed).
      const coast = median(coastSeconds(d));
      expect(coast, ctx).toBeGreaterThan(0.75 * nexusCoast);
      expect(coast, ctx).toBeLessThan(1.5 * nexusCoast);
    });
  }
});
