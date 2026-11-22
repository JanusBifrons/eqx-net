/**
 * Structure break-up T8: a whole base dying stays inside budget, by COUNTS
 * (never wall-clock). Every real galaxy base (`galaxyBasePlan` →
 * `growBase`, the layouts `seedGalaxyBase` places) is broken through the
 * real `structureWreckSource` + `buildWreckPieces` path, structure by
 * structure, and the pieces are counted (bodies and collider vertices).
 *
 * The death path has no per-tick budget (only re-splits do,
 * `WRECK_RESPLITS_PER_TICK`), so the worst same-tick burst is measured and
 * printed, not capped: the structures inside the largest splash radius in
 * the catalogue, all dying to one blast.
 *
 * Measured numbers and the budget: docs/architecture/capital-destruction.md
 * "Structures" → "Whole-base counts (T8)".
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, MAX_LIVE_SUBCAP_WRECK_PIECES } from '../../core/destruction/wreckPieces.js';
import { structureBreaks, structureWreckSource } from '../../core/destruction/wreckSource.js';
import { fractureCapFor } from '../../shared-types/shipScale/destruction.js';
import { structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import { galaxyBasePlan } from '../../core/bases/galaxyBases.js';
import { growBase, type GrownBase } from '../../core/bases/growBase.js';
import type { BaseTier } from '../../core/bases/baseProfile.js';
import { WEAPONS } from '../../core/combat/WeaponCatalogue.js';
import { CAPITAL_TURRET_DEFS } from '../../core/combat/capitalTurretDefs.js';
import { CapitalWreckSubsystem } from './CapitalWreckSubsystem.js';

/** Most pieces one structure may break into (`structure` profile cap, 1–6). */
const PIECES_PER_STRUCTURE_MAX = 6;
/** The budget, from the measured worst whole base (citadel bloomgate/b0:
 *  724 pieces at the cap, 598 measured; 2026-11-22, see the doc): a whole
 *  base fits in 40 % of the sub-cap FIFO (800 of 2000), so two worst bases
 *  dying back to back still fit before any eviction. */
const BASE_PIECE_BUDGET = Math.floor(MAX_LIVE_SUBCAP_WRECK_PIECES * 0.4);
/** Collider vertices for one whole base (measured worst 9,189, citadel bloomgate/b0, since
 *  the radial cracks fan from an inner centre: chunkier wedges, longer jagged seams; 7,870
 *  before; ~20 % headroom). */
const BASE_VERTEX_BUDGET = 11_000;

/** Wreck bodies one blast may spawn in one tick (the death path has no
 *  per-tick budget): measured worst 38 at the cap (citadel) with the 320 u splash. */
const ONE_BLAST_BURST_BUDGET = 60;

interface BaseCount {
  key: string;
  tier: BaseTier;
  structures: number;
  breaking: number;
  /** Cap sum: the most pieces the base can break into. */
  capPieces: number;
  /** Real `buildWreckPieces` pieces (one fixed kill per structure). */
  pieces: number;
  verts: number;
  /** Worst one-blast burst: cap pieces of every breaking structure whose box
   *  lies within the largest splash radius of one point (a structure centre). */
  burst: number;
}

/** The largest splash radius any catalogue weapon has (projectile splash,
 *  missile splash), capital turrets included. */
function maxSplashRadius(): number {
  let r = 0;
  for (const d of [...WEAPONS.values(), ...CAPITAL_TURRET_DEFS]) {
    if (d.mode === 'projectile' && d.splash) r = Math.max(r, d.splash.radius);
    if (d.mode === 'missile') r = Math.max(r, d.splashRadius);
  }
  return r;
}

function countBase(key: string, tier: BaseTier, b: GrownBase, splash: number): BaseCount {
  const per: Array<{ x: number; y: number; hw: number; hh: number; pieces: number }> = [];
  let capPieces = 0, pieces = 0, verts = 0;
  b.placements.forEach((p, i) => {
    if (!structureBreaks(p.kind, true)) return;
    const src = structureWreckSource({ k: p.kind as StructureKindId });
    capPieces += fractureCapFor(src.profile.fracture!, src.area);
    const pose = { x: p.x, y: p.y, vx: 0, vy: 0, angle: ((p.rot ?? 0) * Math.PI) / 180, angvel: 0 };
    const w = buildWreckPieces({
      kindId: src, pose, killWorld: { x: p.x + src.radius, y: p.y }, attackerWorld: null,
      seed: 1 + i * 7919, killBlowDamage: 0.5, recentDamageRate: 0.3,
    });
    let v = 0;
    for (const piece of w.pieces) for (const part of piece.colliderParts) v += part.length;
    pieces += w.pieces.length;
    verts += v;
    const { hw, hh } = structureHalfExtents(p.kind, p.rot ?? 0);
    per.push({ x: p.x, y: p.y, hw, hh, pieces: fractureCapFor(src.profile.fracture!, src.area) });
  });
  let burst = 0;
  for (const c of per) {
    let n = 0;
    for (const o of per) {
      const dx = Math.max(0, Math.abs(o.x - c.x) - o.hw), dy = Math.max(0, Math.abs(o.y - c.y) - o.hh);
      if (dx * dx + dy * dy <= splash * splash) n += o.pieces;
    }
    burst = Math.max(burst, n);
  }
  return { key, tier, structures: b.placements.length, breaking: per.length, capPieces, pieces, verts, burst };
}

describe('whole-base structure break-up counts (structure break-up T8)', () => {
  const splash = maxSplashRadius();
  const bases: BaseCount[] = [];
  const sectors = new Map<string, { pieces: number; capPieces: number }>();
  for (const s of GALAXY_SECTORS) {
    for (const plan of galaxyBasePlan(s.key)) {
      const c = countBase(`${s.key}/${plan.baseId}`, plan.profile.tier, growBase(plan.profile, plan.seed, s.features), splash);
      bases.push(c);
      const t = sectors.get(s.key) ?? { pieces: 0, capPieces: 0 };
      t.pieces += c.pieces; t.capPieces += c.capPieces;
      sectors.set(s.key, t);
    }
  }

  it('prints the measured counts per tier (worst base of each); one blast stays under 60 bodies', () => {
    const rows = ['tier | bases | structures | breaking | pieces (cap) | collider verts | worst one-blast burst'];
    for (const tier of ['outpost', 'settlement', 'stronghold', 'citadel'] as const) {
      const of = bases.filter((b) => b.tier === tier);
      if (of.length === 0) continue;
      const worst = of.reduce((a, b) => (b.capPieces > a.capPieces ? b : a));
      const max = (f: (b: BaseCount) => number): number => Math.max(...of.map(f));
      rows.push(`${tier} | ${of.length} | ${max((b) => b.structures)} | ${max((b) => b.breaking)} | ${max((b) => b.pieces)} (${worst.capPieces}, ${worst.key}) | ${max((b) => b.verts)} | ${max((b) => b.burst)}`);
    }
    const sector = [...sectors.entries()].reduce((a, b) => (b[1].capPieces > a[1].capPieces ? b : a));
    rows.push(`worst sector (every base): ${sector[0]} pieces ${sector[1].pieces} (cap ${sector[1].capPieces}); splash radius ${splash}`);
    console.log(rows.join('\n'));
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b.burst, b.key).toBeLessThanOrEqual(ONE_BLAST_BURST_BUDGET);
  });

  it('every structure breaks into at most 6 pieces (pieces <= breaking structures x 6)', () => {
    for (const b of bases) {
      expect(b.capPieces, b.key).toBeLessThanOrEqual(b.breaking * PIECES_PER_STRUCTURE_MAX);
      expect(b.pieces, b.key).toBeLessThanOrEqual(b.capPieces);
    }
  });

  it('a whole base fits in 40 % of the sub-cap FIFO; a whole sector fits in the FIFO', () => {
    for (const b of bases) {
      expect(b.capPieces, b.key).toBeLessThanOrEqual(BASE_PIECE_BUDGET);
      expect(b.verts, b.key).toBeLessThanOrEqual(BASE_VERTEX_BUDGET);
    }
    for (const [key, t] of sectors) expect(t.capPieces, key).toBeLessThanOrEqual(MAX_LIVE_SUBCAP_WRECK_PIECES);
  });
});

describe('structure pieces live in the sub-cap FIFO and evict oldest quietly (structure break-up T8)', () => {
  function make() {
    const live = new Set<string>();
    const order: string[] = [];
    const removed: string[] = [];
    const sys = new CapitalWreckSubsystem({
      serverTick: () => 1000,
      wreckKindOf: () => null,
      positionOf: () => null,
      spawnPiece: (s) => { live.add(s.id); order.push(s.id); return true; },
      removePiece: (id) => { live.delete(id); removed.push(id); },
      isLive: (id) => live.has(id),
      pieceAngle: (id) => (live.has(id) ? 0 : null),
      kickPiece: () => {},
      impulsePiece: () => {},
      pieceCentreInto: () => false,
    });
    return { sys, live, order, removed };
  }

  it('a whole citadel dying over a small cap: the subcap list holds them, oldest go first, no throw', () => {
    const plan = GALAXY_SECTORS.flatMap((s) => galaxyBasePlan(s.key).map((p) => ({ p, f: s.features })))
      .find((x) => x.p.profile.tier === 'citadel') ?? GALAXY_SECTORS.flatMap((s) => galaxyBasePlan(s.key).map((p) => ({ p, f: s.features })))[0]!;
    const base = growBase(plan.p.profile, plan.p.seed, plan.f);
    const { sys, live, order, removed } = make();
    sys.forcedSeed = 3;
    const CAP = 40;
    sys.subcapCapOverride = CAP;
    let deaths = 0;
    base.placements.forEach((p, i) => {
      if (!structureBreaks(p.kind, true)) return;
      const src = structureWreckSource({ k: p.kind as StructureKindId });
      sys.onDeath(`s${i}`, src, { x: p.x, y: p.y, vx: 0, vy: 0, angle: 0, angvel: 0 }, src.maxHull);
      deaths++;
    });
    expect(deaths).toBeGreaterThan(CAP / PIECES_PER_STRUCTURE_MAX);
    expect(order.length).toBeGreaterThan(CAP);
    // Structure pieces are sub-cap class: they fill the sub-cap FIFO only.
    expect(sys.liveSubcapCount()).toBe(CAP);
    expect(sys.liveBattleCount()).toBe(CAP);
    expect(sys.liveCount()).toBe(CAP);
    expect(live.size).toBe(CAP);
    // Oldest first: the evicted are exactly the first spawned, in order;
    // the survivors are the newest CAP.
    expect(removed).toEqual(order.slice(0, order.length - CAP));
    expect([...live].sort()).toEqual(order.slice(order.length - CAP).sort());
  });
});
