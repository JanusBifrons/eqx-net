import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AIRLOCK_CLOSED,
  AIRLOCK_OPEN_A,
  AIRLOCK_OPEN_B,
  addShipToOccupancy,
  clearOccupancy,
  gateOpenMask,
  newAirlockState,
  newOccupancy,
  stepAirlock,
  stepGate,
  type GateState,
} from './gateLogic.js';
import {
  AIRLOCK_END_Y,
  GATE_APPROACH_DEPTH,
  GATE_CLOSE_HOLD_MS,
  GATE_SPAN_THICKNESS,
  emitterAnchor,
  gateColliderBoxes,
  gateSpanWorld,
  gateSpans,
  gateWorldAxisBoxes,
  localToWorld,
  worldToLocal,
} from './gateGeometry.js';
import { STRUCTURE_KINDS } from '../../shared-types/structureKinds.js';

const TICK = 100;
const R = 14; // a fighter-sized ship

describe('gate geometry', () => {
  it('collider parts sit inside the footprint and leave a gap wider than any flyable ship', () => {
    for (const kind of ['shield_gate', 'shield_airlock'] as const) {
      const { w, h } = STRUCTURE_KINDS[kind].footprint;
      for (const b of gateColliderBoxes(kind)!) {
        expect(Math.abs(b.cx) + b.hw).toBeLessThanOrEqual(w / 2 + 1e-9);
        expect(Math.abs(b.cy) + b.hh).toBeLessThanOrEqual(h / 2 + 1e-9);
      }
      const span = gateSpans(kind)[0]!;
      expect(span.x1 - span.x0).toBeGreaterThan(2 * 55 + 20); // the 55 u robot hexagon fits
    }
    expect(gateColliderBoxes('shield_pylon')).toBeNull();
  });

  it('spans run post to post; the airlock has one at each end', () => {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    expect(gateSpanWorld('shield_gate', 100, 50, 0, 0, a, b)).toBe(true);
    expect(a).toEqual({ x: 100 - 88, y: 50 });
    expect(b).toEqual({ x: 100 + 88, y: 50 });
    expect(gateSpans('shield_airlock').map((s) => s.y)).toEqual([AIRLOCK_END_Y, -AIRLOCK_END_Y]);
    expect(gateSpanWorld('shield_gate', 0, 0, 0, 1, a, b)).toBe(false);
  });

  it('a quarter turn rotates spans and swaps world-axis box extents', () => {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    gateSpanWorld('shield_gate', 0, 0, Math.PI / 2, 0, a, b);
    expect(a.x).toBeCloseTo(0);
    expect(Math.abs(a.y)).toBeCloseTo(88);
    const boxes = gateWorldAxisBoxes('shield_gate', Math.PI / 2)!;
    expect(boxes[0]).toBeCloseTo(0);
    expect(Math.abs(boxes[1]!)).toBeCloseTo(124);
    expect(boxes[2]).toBe(36);
    expect(boxes[3]).toBe(36);
  });

  it('local/world transforms round-trip', () => {
    const w = { x: 0, y: 0 }, l = { x: 0, y: 0 };
    localToWorld(30, -40, 1.1, 12, 34, w);
    worldToLocal(30, -40, 1.1, w.x, w.y, l);
    expect(l.x).toBeCloseTo(12);
    expect(l.y).toBeCloseTo(34);
  });

  it('a fence wall anchors on the gate post nearest its far end; a pylon on its centre', () => {
    const out = { x: 0, y: 0 };
    emitterAnchor('shield_gate', 0, 0, 0, 1000, 0, out);
    expect(out).toEqual({ x: 124, y: 0 });
    emitterAnchor('shield_gate', 0, 0, 0, -1000, 0, out);
    expect(out).toEqual({ x: -124, y: 0 });
    emitterAnchor('shield_pylon', 5, 6, 0, 1000, 0, out);
    expect(out).toEqual({ x: 5, y: 6 });
  });
});

describe('Shield Gate logic', () => {
  function run(positions: number[], admitted: boolean, s: GateState, t0 = 0): boolean[] {
    const o = newOccupancy();
    const opens: boolean[] = [];
    positions.forEach((ly, i) => {
      clearOccupancy(o);
      addShipToOccupancy('gate', 0, ly, R, admitted, o);
      stepGate(s, o, t0 + i * TICK);
      opens.push(s.open);
    });
    return opens;
  }

  it('opens for an admitted ship in the approach zone, then closes after the hold once it has gone', () => {
    const s: GateState = { open: false, lastBusyMs: 0 };
    expect(run([GATE_APPROACH_DEPTH + 50], true, s)).toEqual([false]);
    expect(run([GATE_APPROACH_DEPTH - 10], true, s)).toEqual([true]);
    const far = Array(Math.ceil(GATE_CLOSE_HOLD_MS / TICK) + 2).fill(5000);
    const after = run(far, true, s, 1000);
    expect(after[0]).toBe(true);
    expect(after[after.length - 1]).toBe(false);
  });

  it('never opens for a ship it does not admit', () => {
    const s: GateState = { open: false, lastBusyMs: 0 };
    expect(run([200, 100, 0, -100], false, s).some(Boolean)).toBe(false);
  });

  it('never closes while any ship overlaps the span', () => {
    const s: GateState = { open: true, lastBusyMs: 0 };
    const stuck = run(Array(40).fill(0), false, s, 10_000); // a non-admitted ship parked in the span
    expect(stuck.every(Boolean)).toBe(true);
  });
});

describe('Shield Airlock logic', () => {
  /** Fly one admitted ship along local y from `from` to `to`, `step` u per tick.
   *  Returns the phase each tick and whether the ship ever touched a closed span. */
  function traverse(from: number, to: number, step: number) {
    const s = newAirlockState();
    const o = newOccupancy();
    const phases: number[] = [];
    let blocked = false;
    let ly = from;
    let t = 0;
    const dir = Math.sign(to - from);
    for (let i = 0; i < 2000 && (dir > 0 ? ly < to : ly > to); i++) {
      clearOccupancy(o);
      addShipToOccupancy('airlock', 0, ly, R, true, o);
      stepAirlock(s, o, t);
      phases.push(s.phase);
      // Would moving one more step put the ship into a CLOSED span band?
      const next = ly + dir * step;
      const band = GATE_SPAN_THICKNESS / 2 + R;
      const intoA = Math.abs(next - AIRLOCK_END_Y) <= band;
      const intoB = Math.abs(next + AIRLOCK_END_Y) <= band;
      if ((intoA && s.phase !== AIRLOCK_OPEN_A) || (intoB && s.phase !== AIRLOCK_OPEN_B)) {
        blocked = true; // the ship waits this tick (it would hit the shield)
      } else {
        ly = next;
      }
      t += TICK;
    }
    return { phases, blocked, ly };
  }

  it('cycles a ship A → B: A opens, A closes behind it, then B opens', () => {
    const { phases, ly } = traverse(AIRLOCK_END_Y + 250, -AIRLOCK_END_Y - 250, 20);
    expect(ly).toBeLessThanOrEqual(-AIRLOCK_END_Y - 250); // it got through
    const firstA = phases.indexOf(AIRLOCK_OPEN_A);
    const firstB = phases.indexOf(AIRLOCK_OPEN_B);
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThan(firstA);
    expect(phases.slice(firstA, firstB)).toContain(AIRLOCK_CLOSED); // A shut before B opened
  });

  it('cycles a ship B → A the same way', () => {
    const { phases, ly } = traverse(-AIRLOCK_END_Y - 250, AIRLOCK_END_Y + 250, 20);
    expect(ly).toBeGreaterThanOrEqual(AIRLOCK_END_Y + 250);
    const firstB = phases.indexOf(AIRLOCK_OPEN_B);
    const firstA = phases.indexOf(AIRLOCK_OPEN_A);
    expect(firstB).toBeGreaterThanOrEqual(0);
    expect(firstA).toBeGreaterThan(firstB);
  });

  it('never opens both ends and never closes an end on a ship (random fleets)', () => {
    const ship = fc.record({
      lx: fc.integer({ min: -200, max: 200 }),
      ly: fc.integer({ min: -500, max: 500 }),
      admitted: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(fc.array(ship, { maxLength: 4 }), { minLength: 1, maxLength: 60 }), (ticks) => {
        const s = newAirlockState();
        const o = newOccupancy();
        let t = 0;
        for (const fleet of ticks) {
          const before = s.phase;
          clearOccupancy(o);
          for (const sh of fleet) addShipToOccupancy('airlock', sh.lx, sh.ly, R, sh.admitted, o);
          stepAirlock(s, o, t);
          t += TICK;
          expect(gateOpenMask(undefined, s)).not.toBe(3);
          if (before === AIRLOCK_OPEN_A && o.bandA) expect(s.phase).toBe(AIRLOCK_OPEN_A);
          if (before === AIRLOCK_OPEN_B && o.bandB) expect(s.phase).toBe(AIRLOCK_OPEN_B);
        }
      }),
      { numRuns: 300 },
    );
  });
});
