/**
 * NPC line-of-fire gate (friendly fire slice 2): correctness against a full
 * scan, and the COUNT budget (root CLAUDE.md "gate on counts": never a
 * wall-clock bound).
 *
 * The cost scene is a synthetic fleet fight, deterministic on every host: two
 * 40-ship sides in discs 1,500 u apart, 4 capitals, 300 rocks over a 40 km
 * square. EVERY ship is a fire candidate EVERY tick (the worst case: real
 * drones fire on a cooldown), aiming at a random enemy.
 */
import { describe, expect, it } from 'vitest';
import { LineOfFireGate, type LineOfFireBody } from './LineOfFireGate.js';
import { rayHitsSphere } from '../../core/combat/Weapons.js';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { LINE_OF_FIRE_BUDGET } from '../../shared-types/perf/perfBudgets.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';

interface Body extends LineOfFireBody { side: number }

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(seed: number) {
  const r = rng(seed);
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const recs: Body[] = [];
  const add = (id: string, side: number, x: number, y: number, radius: number) => {
    const slot = recs.length;
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y;
    recs.push({ id, slot, side, radius });
  };
  for (let s = 0; s < 2; s++) {
    const cx = s === 0 ? -750 : 750;
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 600;
      add(`s${s}-${i}`, s, cx + Math.cos(a) * d, Math.sin(a) * d, i < 2 ? 400 : 40); // two capitals a side
    }
  }
  for (let i = 0; i < 300; i++) add(`rock-${i}`, -1, (r() - 0.5) * 40_000, (r() - 0.5) * 40_000, 30 + r() * 120);
  return { sab, recs, r };
}

const hit = (rec: Body, fx: number, fy: number, dx: number, dy: number, max: number, cx: number, cy: number, _ca = 0, hw = 0) =>
  rayHitsSphere(fx, fy, dx, dy, max, cx, cy, rec.radius + hw);

describe('LineOfFireGate', () => {
  it('agrees with a full scan on every shot of the fleet fight', () => {
    const { sab, recs, r } = scene(7);
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => 0, rayHit: hit });
    let blocked = 0;
    for (let k = 0; k < 400; k++) {
      const sh = recs[Math.floor(r() * 80)]!;
      const enemySide = 1 - sh.side;
      const tg = recs[enemySide * 40 + Math.floor(r() * 40)]!;
      const sb = slotBase(sh.slot), tb = slotBase(tg.slot);
      const fx = sab[sb + SLOT_X_OFF]!, fy = sab[sb + SLOT_Y_OFF]!;
      const len = Math.hypot(sab[tb + SLOT_X_OFF]! - fx, sab[tb + SLOT_Y_OFF]! - fy);
      const dx = (sab[tb + SLOT_X_OFF]! - fx) / len, dy = (sab[tb + SLOT_Y_OFF]! - fy) / len;
      const friendly = (b: Body) => b.side === sh.side;
      let oracle = false;
      for (const b of recs) {
        if (b === sh || b === tg || !friendly(b)) continue;
        const bb = slotBase(b.slot);
        if (hit(b, fx, fy, dx, dy, len, sab[bb + SLOT_X_OFF]!, sab[bb + SLOT_Y_OFF]!) !== null) { oracle = true; break; }
      }
      const got = gate.blocked(fx, fy, dx, dy, len, sh.id, tg.id, friendly);
      expect(got).toBe(oracle);
      if (got) {
        blocked++;
        // Line-of-fire feedback: the reported blocker is a friendly body on
        // the line, at its own pose.
        const bl = recs.find((b) => b.id === gate.lastBlockerId)!;
        expect(bl, 'blocker reported').toBeDefined();
        expect(friendly(bl) && bl !== sh && bl !== tg).toBe(true);
        const bb = slotBase(bl.slot);
        expect(gate.lastBlockerX).toBe(sab[bb + SLOT_X_OFF]!);
        expect(gate.lastBlockerY).toBe(sab[bb + SLOT_Y_OFF]!);
        expect(hit(bl, fx, fy, dx, dy, len, gate.lastBlockerX, gate.lastBlockerY)).not.toBeNull();
      }
    }
    expect(blocked, 'the scene must actually block some shots').toBeGreaterThan(20);
    expect(blocked, 'and clear others').toBeLessThan(380);
  });

  it('a hostile or a rock in the way never blocks; the target itself never blocks', () => {
    const { sab, recs } = scene(1);
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => 0, rayHit: hit });
    const none = () => false;
    expect(gate.blocked(-3000, 0, 1, 0, 6000, 'x', 'y', none)).toBe(false);
    const tg = recs[40]!;
    const onlyTarget = (b: Body) => b === tg;
    const tb = slotBase(tg.slot);
    expect(gate.blocked(-3000, sab[tb + SLOT_Y_OFF]!, 1, 0, 6000, 'x', tg.id, onlyTarget)).toBe(false);
  });

  it('players\' ships (`ships`, outside the registry) block like registry bodies', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const put = (slot: number, x: number, y: number) => { const b = slotBase(slot); sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y; };
    const recs: Body[] = [{ id: 'target', slot: 0, side: 1, radius: 20 }];
    put(0, 0, 600);
    const ship: Body = { id: 'pilot-ship', slot: 5, side: 0, radius: 30 };
    put(5, 0, 300);
    let tick = 0;
    let shipThere = true;
    const gate = new LineOfFireGate<Body>({
      registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => tick, rayHit: hit,
      ships: (out) => { if (!shipThere) return 0; out[0] = ship; return 1; },
    });
    expect(gate.blocked(0, 0, 0, 1, 600, 'shooter', 'target', side0)).toBe(true);
    expect(gate.lastBlockerId).toBe('pilot-ship');
    // Read at each build: once the ship leaves, the next tick's grid has none.
    shipThere = false;
    tick++;
    expect(gate.blocked(0, 0, 0, 1, 600, 'shooter', 'target', side0)).toBe(false);
  });

  it('a moving shot also holds for a friend that will cross its line in flight', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(0);
    // A friend 200 u right of the line at 400 u out, flying left at 400 u/s.
    sab[b + SLOT_X_OFF] = 200; sab[b + SLOT_Y_OFF] = 400; sab[b + SLOT_VX_OFF] = -400;
    const recs: Body[] = [{ id: 'friend', slot: 0, side: 0, radius: 20 }];
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => 0, rayHit: hit });
    // Static check: clear. A bolt at 800 u/s reaches 400 u in 0.5 s, when the
    // friend is on the line: held.
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0)).toBe(false);
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0, 800)).toBe(true);
    // The shot inherits the shooter's velocity: a shooter flying with the
    // friend leaves the friend where it is relative to the shot.
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0, 800, -400, 0)).toBe(false);
    // A beam (no speed) is the static check.
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0, 0)).toBe(false);
  });

  it('a squadmate sliding onto the lead line AHEAD of a bolt holds it; one sliding away does not', () => {
    // Wingmen in a chase fly the shot's way: the bolt meets a friend ahead of
    // it later than along / speed. Friend 94 u right of the line, 500 u out,
    // flying with the shot at 800 u/s and drifting 150 u/s toward the line.
    // The bolt (1600 u/s) closes at 800 u/s: it reaches the friend after
    // 0.625 s, when the friend has drifted 94 u, onto the line.
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(0);
    sab[b + SLOT_X_OFF] = 94; sab[b + SLOT_Y_OFF] = 500;
    sab[b + SLOT_VX_OFF] = -150; sab[b + SLOT_VY_OFF] = 800;
    let tick = 0;
    const recs: Body[] = [{ id: 'wingman', slot: 0, side: 0, radius: 20 }];
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => tick, rayHit: hit });
    expect(gate.blocked(0, 0, 0, 1, 1200, 's', 't', side0), 'clear right now').toBe(false);
    expect(gate.blocked(0, 0, 0, 1, 1200, 's', 't', side0, 1600), 'crossing the lead line in flight: hold').toBe(true);
    // The same squadmate drifting AWAY from the line: a clear line, fire.
    sab[b + SLOT_VX_OFF] = 150; tick++;
    expect(gate.blocked(0, 0, 0, 1, 1200, 's', 't', side0, 1600), 'clear line: fire').toBe(false);
    // Out of the bolt's reach when it would cross: fire (0.3 s flight).
    sab[b + SLOT_VX_OFF] = -150; tick++;
    expect(gate.blocked(0, 0, 0, 1, 480, 's', 't', side0, 1600), 'crosses after the bolt is spent').toBe(false);
  });

  it('the line is as wide as the bolt: a squadmate whose edge is 2 u off it holds fire', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(0);
    // Hull radius 20, centre 22 u right of the line: its edge is 2 u off.
    sab[b + SLOT_X_OFF] = 22; sab[b + SLOT_Y_OFF] = 400;
    const recs: Body[] = [{ id: 'wingman', slot: 0, side: 0, radius: 20 }];
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => 0, rayHit: hit });
    const bolt = getWeapon('laser');
    if (bolt.mode !== 'projectile') throw new Error('laser is a bolt');
    expect(bolt.radius, 'the bolt is wider than the 2 u gap').toBeGreaterThan(2);
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0, bolt.speed), 'a thin ray slips past').toBe(false);
    expect(gate.blocked(0, 0, 0, 1, 800, 's', 't', side0, bolt.speed, 0, 0, bolt.radius), 'the bolt grazes it: hold').toBe(true);
  });

  it(`fleet fight: work per tick stays within budget (${JSON.stringify(LINE_OF_FIRE_BUDGET)})`, () => {
    const { sab, recs, r } = scene(42);
    let tick = 0;
    const gate = new LineOfFireGate<Body>({ registry: { all: () => recs, version: 1 }, sabF32: sab, tick: () => tick, rayHit: hit });
    const TICKS = 60;
    for (; tick < TICKS; tick++) {
      for (let s = 0; s < 80; s++) {
        const sh = recs[s]!;
        const tg = recs[(1 - sh.side) * 40 + Math.floor(r() * 40)]!;
        const sb = slotBase(sh.slot), tb = slotBase(tg.slot);
        const fx = sab[sb + SLOT_X_OFF]!, fy = sab[sb + SLOT_Y_OFF]!;
        const ex = sab[tb + SLOT_X_OFF]! - fx, ey = sab[tb + SLOT_Y_OFF]! - fy;
        const len = Math.hypot(ex, ey);
        gate.blocked(fx, fy, ex / len, ey / len, len, sh.id, tg.id, sh.side === 0 ? side0 : side1);
      }
    }
    const per = {
      checks: gate.checks / TICKS,
      candidates: gate.candidates / TICKS,
      narrow: gate.narrow / TICKS,
      builds: gate.builds / TICKS,
    };
    console.log(`[line-of-fire] fleet fight per tick: ${JSON.stringify(per)} (full scan would test ${80 * recs.length} bodies)`);
    expect(per.builds, 'one grid build per tick').toBe(1);
    expect(per.candidates).toBeLessThanOrEqual(LINE_OF_FIRE_BUDGET.candidatesPerTick);
    expect(per.narrow).toBeLessThanOrEqual(LINE_OF_FIRE_BUDGET.narrowPerTick);
  });
});

function side0(b: Body): boolean { return b.side === 0; }
function side1(b: Body): boolean { return b.side === 1; }
