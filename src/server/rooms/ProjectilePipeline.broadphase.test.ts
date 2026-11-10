/**
 * Projectile broadphase (ranges plan, risk 2 / slice 5).
 *
 * 1. PARITY: the broadphase sweep gives exactly the hits of the old
 *    every-shell × every-entity scan (`broadphase: false`) over randomized
 *    scenes — circles, capitals, structure boxes, gate parts, players,
 *    lingering hulls, allegiance + owner skips, shells fast enough to cross
 *    many cells in one step, and kills that evict / spawn entities mid-tick.
 * 2. COUNT GATE (not wall-clock): 500 shells among 1,000 entities stay under
 *    `PROJECTILE_NARROW_CHECKS_BUDGET` narrow-phase checks per tick.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ProjectilePipeline, type SwarmCandidateSource } from './ProjectilePipeline.js';
import { SwarmEntityRegistry, type SwarmKind } from '../net/SwarmEntityRegistry.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { projectileSweepCircle } from '../../core/combat/Weapons.js';
import { PROJECTILE_NARROW_CHECKS_BUDGET } from '../../shared-types/perf/perfBudgets.js';
import type { ShipState } from './schema/SectorState.js';

interface EntSpec {
  kind: 0 | 1 | 2;
  shipKind: string;
  x: number; y: number; angle: number;
  radius: number;
  box: null | { hw: number; hh: number; parts: boolean };
}
interface ProjSpec { owner: number; x: number; y: number; vx: number; vy: number; radius: number }
interface Scene {
  ents: EntSpec[];
  players: Array<{ x: number; y: number }>;
  lingering: Array<{ x: number; y: number }>;
  projs: ProjSpec[];
  /** Kills evict the target and drop a scrap piece where it was hit. */
  kills: boolean;
  /** Use the real registry (has `version`) vs a plain source (no version). */
  realRegistry: boolean;
}

const SHIP_KINDS = ['fighter', 'robot-square', 'battleship', 'heavy'];
const coord = fc.double({ min: -6000, max: 6000, noNaN: true });

const entArb: fc.Arbitrary<EntSpec> = fc.record({
  kind: fc.constantFrom(0 as const, 1 as const, 2 as const),
  shipKind: fc.constantFrom(...SHIP_KINDS),
  x: coord, y: coord,
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  radius: fc.double({ min: 5, max: 3000, noNaN: true }),
  box: fc.option(fc.record({
    hw: fc.double({ min: 5, max: 1500, noNaN: true }),
    hh: fc.double({ min: 5, max: 1500, noNaN: true }),
    parts: fc.boolean(),
  }), { nil: null }),
});
const speed = fc.oneof(
  fc.double({ min: -3000, max: 3000, noNaN: true }),
  // Fast: up to 10,000 u per step, crossing many 512 u cells.
  fc.double({ min: -600_000, max: 600_000, noNaN: true }),
);
const projArb: fc.Arbitrary<ProjSpec> = fc.record({
  owner: fc.integer({ min: -1, max: 40 }),
  x: coord, y: coord, vx: speed, vy: speed,
  radius: fc.double({ min: 1, max: 12, noNaN: true }),
});
const sceneArb: fc.Arbitrary<Scene> = fc.record({
  ents: fc.array(entArb, { maxLength: 40 }),
  players: fc.array(fc.record({ x: coord, y: coord }), { maxLength: 3 }),
  lingering: fc.array(fc.record({ x: coord, y: coord }), { maxLength: 2 }),
  projs: fc.array(projArb, { minLength: 1, maxLength: 40 }),
  kills: fc.boolean(),
  realRegistry: fc.boolean(),
});

const SCRAP_SLOT0 = 2000;

/** Build one arm of a scene. Each arm owns its own SAB and registry. */
function buildArm(scene: Scene, broadphase: boolean) {
  const sab = new Float32Array(slotBase(SCRAP_SLOT0 + 200));
  const setPose = (slot: number, x: number, y: number, a: number): void => {
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y; sab[b + SLOT_ANGLE_OFF] = a;
  };
  const reg = new SwarmEntityRegistry();
  const register = (id: string, slot: number, e: EntSpec): void => {
    const rec = reg.register(id, slot, e.kind as SwarmKind, e.radius, e.x, e.y, e.angle);
    if (e.kind === 1) rec.shipKind = e.shipKind;
    if (e.box) {
      rec.halfW = e.box.hw; rec.halfH = e.box.hh;
      if (e.box.parts) rec.boxes = new Float32Array([-e.box.hw / 2, 0, e.box.hw / 2, e.box.hh, e.box.hw * 0.8, e.box.hh * 0.5, e.box.hw / 4, e.box.hh / 4]);
    }
    setPose(slot, e.x, e.y, e.angle);
  };
  scene.ents.forEach((e, i) => register(`e${i}`, i, e));
  const source: SwarmCandidateSource = scene.realRegistry ? reg : { all: () => reg.all() };

  const playerToSlot = new Map<string, number>();
  const poses = new Map<string, { x: number; y: number; angle: number }>();
  scene.players.forEach((p, i) => { playerToSlot.set(`p${i}`, 1000 + i); poses.set(`p${i}`, { x: p.x, y: p.y, angle: 0 }); });
  const lingering = new Map<string, number>();
  scene.lingering.forEach((l, i) => { lingering.set(`l${i}`, 1100 + i); setPose(1100 + i, l.x, l.y, 0); });

  const log: string[] = [];
  let scrap = 0;
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => 0,
    playerToSlot,
    getActiveShip: () => ({ alive: true }) as unknown as ShipState,
    shipPoseCache: poses,
    playerSweep: (_s, fx, fy, sx, sy, r, cx, cy) => projectileSweepCircle(fx, fy, sx, sy, r, cx, cy, 30),
    swarmRegistry: source,
    lingeringSlots: lingering,
    applyDamage: (target, shooter, _dmg, hx, hy) => {
      log.push(`${target}<-${shooter}@${hx},${hy}`);
      if (scene.kills && reg.get(target)) {
        reg.unregister(target);
        const s = SCRAP_SLOT0 + (scrap % 200);
        register(`scrap${scrap++}`, s, { kind: 0, shipKind: '', x: hx ?? 0, y: hy ?? 0, angle: 0, radius: 40, box: null });
      }
    },
    ownerAllegianceOf: (id) => {
      const rec = reg.get(id);
      if (!rec || rec.kind !== 1) return undefined;
      return rec.shipKind?.startsWith('robot') ? 'robots' : 'drones';
    },
    broadphase,
  });
  for (const p of scene.projs) {
    const owner = p.owner < 0 ? 'p0' : `e${p.owner}`;
    pipe.spawn(owner, p.x, p.y, p.vx, p.vy, 10, p.radius, 3, 'laser');
  }
  return { pipe, log };
}

describe('ProjectilePipeline broadphase — hit parity with the full scan', () => {
  it('same hits, same order, same points over randomized scenes', () => {
    fc.assert(fc.property(sceneArb, (scene) => {
      const fast = buildArm(scene, true);
      const full = buildArm(scene, false);
      for (let t = 0; t < 4; t++) { fast.pipe.advance(); full.pipe.advance(); }
      expect(fast.log).toEqual(full.log);
      expect(fast.pipe.size()).toBe(full.pipe.size());
    }), { numRuns: 400, seed: 0x5eed });
  });

  it('a shell crossing many cells in one step still hits the entity it passes', () => {
    const scene: Scene = {
      ents: [
        { kind: 0, shipKind: '', x: 4100, y: 15, angle: 0, radius: 20, box: null },
        { kind: 0, shipKind: '', x: 9000, y: 0, angle: 0, radius: 20, box: null },
      ],
      players: [], lingering: [],
      projs: [{ owner: -1, x: -5000, y: 0, vx: 600_000, vy: 0, radius: 4 }],
      kills: false, realRegistry: true,
    };
    const { pipe, log } = buildArm(scene, true);
    pipe.advance();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^e0<-p0@/);
  });
});

describe('ProjectilePipeline broadphase — narrow-phase COUNT gate', () => {
  /** 1,000 entities over a 40 km square, 500 shells at naval speed. */
  function denseScene(): Scene {
    let s = 12345;
    const rnd = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
    const ents: EntSpec[] = [];
    for (let i = 0; i < 1000; i++) {
      ents.push({ kind: (i % 3) as 0 | 1 | 2, shipKind: i % 50 === 0 ? 'battleship' : 'fighter',
        x: (rnd() - 0.5) * 40_000, y: (rnd() - 0.5) * 40_000, angle: 0,
        radius: i % 50 === 0 ? 1500 : 20 + rnd() * 40,
        box: i % 3 === 2 ? { hw: 60, hh: 40, parts: false } : null });
    }
    const projs: ProjSpec[] = [];
    for (let i = 0; i < 500; i++) {
      const a = rnd() * Math.PI * 2;
      projs.push({ owner: -1, x: (rnd() - 0.5) * 40_000, y: (rnd() - 0.5) * 40_000,
        vx: Math.cos(a) * 2600, vy: Math.sin(a) * 2600, radius: 6 });
    }
    return { ents, players: [], lingering: [], projs, kills: false, realRegistry: true };
  }

  it(`500 shells × 1,000 entities stays under ${PROJECTILE_NARROW_CHECKS_BUDGET} checks per tick`, () => {
    const scene = denseScene();
    const fast = buildArm(scene, true);
    const full = buildArm(scene, false);
    fast.pipe.advance();
    full.pipe.advance();
    // Print, for the PR / budget calibration.
    console.log(`[broadphase] narrow checks/tick: full scan ${full.pipe.narrowChecks}, broadphase ${fast.pipe.narrowChecks}`);
    expect(full.pipe.narrowChecks).toBeGreaterThan(400_000);
    expect(fast.pipe.narrowChecks).toBeLessThanOrEqual(PROJECTILE_NARROW_CHECKS_BUDGET);
    expect(fast.log).toEqual(full.log);
  });
});
