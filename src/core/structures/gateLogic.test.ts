import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AIRLOCK_CLOSED,
  AIRLOCK_OPEN_A,
  AIRLOCK_OPEN_B,
  GATE_OPEN_A,
  GATE_OPEN_B,
  addShipToOccupancy,
  clearOccupancy,
  gateDoorsMoving,
  gateFullyOpenMask,
  gateOpenMask,
  newAirlockState,
  newGateState,
  newOccupancy,
  stepAirlock,
  stepGate,
  type GateState,
} from './gateLogic.js';
import { doorFullyOpen, doorPosAt } from './doorMotion.js';
import {
  AIRLOCK_END_Y,
  DOOR_POS_MAX,
  DOOR_POWER_LEVELS,
  DOOR_RESEGMENT_MIN_MS,
  DOOR_TRAVEL_TICKS,
  GATE_APPROACH_DEPTH,
  GATE_CLOSE_HOLD_MS,
  GATE_SPAN_THICKNESS,
  emitterAnchor,
  gateColliderBoxes,
  gateColliderPolygons,
  gateGapHalf,
  gateTypeOf,
  shipyardSlipFits,
  gateWorldAxisBoxes,
  localToWorld,
  worldToLocal,
} from './gateGeometry.js';
import { STRUCTURE_KINDS } from '../../shared-types/structureKinds.js';
import { GATE_DEPTH, GATE_POSTS, GATE_POST_W } from '../../shared-types/structureKinds/gatePosts.js';
import { RECIPES } from '../../shared-types/recipes.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { tuningFor } from '../../shared-types/shipScale/lookup.js';
import { SHIPYARD_KEEL_X } from '../articulation/rigs/heavyIndustry.js';
import { PAD_SPECS, padDoorwayHalf, padHalfExtent } from '../../shared-types/teleport.js';

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
      expect(2 * gateGapHalf(gateTypeOf(kind)!)).toBeGreaterThan(2 * 55 + 20); // the 55 u robot hexagon fits
    }
    expect(gateColliderBoxes('shield_pylon')).toBeNull();
  });

  it('a quarter turn swaps world-axis box extents', () => {
    const boxes = gateWorldAxisBoxes('shield_gate', Math.PI / 2)!;
    expect(boxes[0]).toBeCloseTo(0);
    expect(Math.abs(boxes[1]!)).toBeCloseTo(GATE_POSTS[1]![0]);
    expect(boxes[2]).toBe(GATE_DEPTH / 2); // the depth, now along world x
    expect(boxes[3]).toBe(GATE_POST_W / 2); // the tower width, now along world y
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
    expect(out).toEqual({ x: GATE_POSTS[1]![0], y: 0 });
    emitterAnchor('shield_gate', 0, 0, 0, -1000, 0, out);
    expect(out).toEqual({ x: -GATE_POSTS[1]![0], y: 0 });
    emitterAnchor('shield_pylon', 5, 6, 0, 1000, 0, out);
    expect(out).toEqual({ x: 5, y: 6 });
  });
});

/** Game ticks per 100 ms structure step (fixed 60 Hz). */
const TICKS_PER_STEP = (TICK * 60) / 1000;
const FULL = DOOR_POWER_LEVELS;

describe('Shield Gate logic', () => {
  /** One structure step at `step` (tick = step * 6, nowMs = step * 100). */
  function stepAt(s: GateState, ly: number | null, admitted: boolean, step: number, level = FULL): boolean {
    const o = newOccupancy();
    if (ly !== null) addShipToOccupancy('gate', 0, ly, R, admitted, o);
    return stepGate(s, o, step * TICK, step * TICKS_PER_STEP, level);
  }
  const pos = (s: GateState, step: number) => doorPosAt(s.door.seg, step * TICKS_PER_STEP);

  it('opens for an admitted ship in the approach zone, then closes after the hold once it has gone', () => {
    const s = newGateState();
    stepAt(s, GATE_APPROACH_DEPTH + 50, true, 0);
    expect(s.open).toBe(false);
    stepAt(s, GATE_APPROACH_DEPTH - 10, true, 1);
    expect(s.open).toBe(true);
    let step = 2;
    for (; step < 200 && s.open; step++) stepAt(s, 5000, true, step);
    expect(s.open).toBe(false);
    for (let i = 0; i < 40; i++, step++) stepAt(s, 5000, true, step);
    expect(pos(s, step)).toBe(0); // and the door travelled shut
  });

  it('never opens for a ship it does not admit', () => {
    const s = newGateState();
    [200, 100, 0, -100].forEach((ly, i) => stepAt(s, ly, false, i));
    expect(s.open).toBe(false);
    expect(pos(s, 4)).toBe(0);
  });

  it('closes on a ship parked in the gap (the leaves shove it out; no hold)', () => {
    const s = newGateState();
    for (let i = 0; i < 40; i++) stepAt(s, 0, true, i); // admitted ship opens it fully
    expect(doorFullyOpen(s.door, 40 * TICKS_PER_STEP)).toBe(true);
    let step = 40;
    for (; step < 200 && s.open; step++) stepAt(s, 0, false, step); // now a stranger sits in the gap
    expect(s.open).toBe(false);
    expect(step - 40).toBeLessThanOrEqual(Math.ceil(GATE_CLOSE_HOLD_MS / TICK) + 1);
  });

  it('travels fully open in 3 s at full power; moving until then, fully open only on arrival', () => {
    const s = newGateState();
    stepAt(s, 0, true, 0);
    expect(s.door.seg).toMatchObject({ p0: 0, t0: 0, dir: 1, level: FULL });
    const t = DOOR_TRAVEL_TICKS;
    expect(DOOR_TRAVEL_TICKS).toBe(180);
    expect(gateDoorsMoving(s, undefined, t - 1)).toBe(true);
    expect(gateFullyOpenMask(s, undefined, t - 1)).toBe(0);
    expect(gateDoorsMoving(s, undefined, t)).toBe(false);
    expect(gateFullyOpenMask(s, undefined, t)).toBe(GATE_OPEN_A);
    // Keep stepping with the ship there: no re-segment, the clock is the segment.
    for (let i = 1; i <= 30; i++) expect(stepAt(s, 0, true, i)).toBe(false);
    expect(s.door.seg.t0).toBe(0);
  });

  it('runs at about half speed at power level 7-8', () => {
    for (const level of [7, 8]) {
      const s = newGateState();
      stepAt(s, 0, true, 0, level);
      const arrive = Math.ceil(DOOR_POS_MAX / level);
      expect(arrive / DOOR_TRAVEL_TICKS).toBeGreaterThan(1.8);
      expect(arrive / DOOR_TRAVEL_TICKS).toBeLessThan(2.2);
      expect(doorPosAt(s.door.seg, DOOR_TRAVEL_TICKS)).toBe(level * DOOR_TRAVEL_TICKS);
      expect(doorFullyOpen(s.door, arrive - 1)).toBe(false);
      expect(doorFullyOpen(s.door, arrive)).toBe(true);
    }
  });

  it('power level 0 freezes the door mid-travel where it is', () => {
    const s = newGateState();
    for (let i = 0; i <= 15; i++) stepAt(s, 0, true, i); // 1.5 s at full power
    const mid = pos(s, 15);
    expect(mid).toBe(15 * TICKS_PER_STEP * FULL);
    expect(stepAt(s, 0, true, 16, 0)).toBe(true); // re-segment at L 0
    const frozen = pos(s, 16);
    for (let i = 17; i < 80; i++) {
      stepAt(s, 0, true, i, 0);
      expect(pos(s, i)).toBe(frozen);
    }
    expect(gateDoorsMoving(s, undefined, 80 * TICKS_PER_STEP)).toBe(true); // still wants power
    expect(gateFullyOpenMask(s, undefined, 80 * TICKS_PER_STEP)).toBe(0);
  });

  it('starts the close hold on ARRIVAL fully open, not on the decision', () => {
    const s = newGateState();
    for (let i = 0; i <= 10; i++) stepAt(s, 0, true, i); // ship near for 1 s, then gone
    const arriveStep = DOOR_TRAVEL_TICKS / TICKS_PER_STEP; // 30
    const holdSteps = GATE_CLOSE_HOLD_MS / TICK; // 12
    let closedAt = -1;
    for (let i = 11; i < 100 && closedAt < 0; i++) {
      stepAt(s, null, true, i);
      if (!s.open) closedAt = i;
    }
    expect(closedAt).toBeGreaterThanOrEqual(arriveStep + holdSteps - 1); // decided at step 10 it would be 22
    expect(closedAt).toBeLessThanOrEqual(arriveStep + holdSteps + 1);
  });

  it('re-segments on a level change at most once per 500 ms; a new target at once', () => {
    const s = newGateState();
    stepAt(s, 0, true, 0);
    const changes: number[] = [];
    for (let i = 1; i < 25; i++) {
      if (stepAt(s, 0, true, i, i % 2 === 0 ? FULL : FULL - 1)) changes.push(i * TICK);
    }
    expect(changes.length).toBeGreaterThan(1);
    for (let k = 1; k < changes.length; k++) expect(changes[k]! - changes[k - 1]!).toBeGreaterThanOrEqual(DOOR_RESEGMENT_MIN_MS);
    expect(changes[0]! - 0).toBeGreaterThanOrEqual(DOOR_RESEGMENT_MIN_MS);
    // A new target re-segments immediately, throttle or not.
    const p = pos(s, 25);
    s.open = false;
    s.lastBusyMs = -1e9;
    stepAt(s, null, true, 25);
    expect(s.door.seg).toMatchObject({ p0: p, t0: 25 * TICKS_PER_STEP, dir: -1 });
    // A level change on an arrived door does nothing.
    const shut = newGateState();
    expect(stepAt(shut, null, true, 0, 3)).toBe(false);
  });
});

describe('Shield Airlock logic', () => {
  const band = GATE_SPAN_THICKNESS / 2 + R;
  const inBandA = (y: number) => Math.abs(y - AIRLOCK_END_Y) <= band;
  const inBandB = (y: number) => Math.abs(y + AIRLOCK_END_Y) <= band;

  /** Fly one admitted ship along local y from `from` to `to`, `step` u per
   *  structure step. It may only ENTER an end's band while that door is fully
   *  open. Returns the target phase each step and the fully-open masks. */
  function traverse(from: number, to: number, step: number) {
    const s = newAirlockState();
    const o = newOccupancy();
    const phases: number[] = [];
    const opens: number[] = [];
    let ly = from;
    const dir = Math.sign(to - from);
    for (let i = 0; i < 4000 && (dir > 0 ? ly < to : ly > to); i++) {
      clearOccupancy(o);
      addShipToOccupancy('airlock', 0, ly, R, true, o);
      const tick = i * TICKS_PER_STEP;
      stepAirlock(s, o, i * TICK, tick, FULL);
      phases.push(s.phase);
      const mask = gateFullyOpenMask(undefined, s, tick);
      opens.push(mask);
      const next = ly + dir * step;
      const blocked = (inBandA(next) && !inBandA(ly) && !(mask & GATE_OPEN_A)) || (inBandB(next) && !inBandB(ly) && !(mask & GATE_OPEN_B));
      if (!blocked) ly = next;
    }
    return { phases, opens, ly };
  }

  it('cycles a ship A → B: A opens, A shuts behind it, then B opens', () => {
    const { phases, opens, ly } = traverse(AIRLOCK_END_Y + 250, -AIRLOCK_END_Y - 250, 20);
    expect(ly).toBeLessThanOrEqual(-AIRLOCK_END_Y - 250); // it got through
    const firstA = phases.indexOf(AIRLOCK_OPEN_A);
    const firstB = phases.indexOf(AIRLOCK_OPEN_B);
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThan(firstA);
    expect(phases.slice(firstA, firstB)).toContain(AIRLOCK_CLOSED);
    const openA = opens.indexOf(GATE_OPEN_A);
    const openB = opens.indexOf(GATE_OPEN_B);
    expect(openB).toBeGreaterThan(openA);
    expect(opens).not.toContain(3);
  });

  it('cycles a ship B → A the same way', () => {
    const { phases, ly } = traverse(-AIRLOCK_END_Y - 250, AIRLOCK_END_Y + 250, 20);
    expect(ly).toBeGreaterThanOrEqual(AIRLOCK_END_Y + 250);
    const firstB = phases.indexOf(AIRLOCK_OPEN_B);
    const firstA = phases.indexOf(AIRLOCK_OPEN_A);
    expect(firstB).toBeGreaterThanOrEqual(0);
    expect(firstA).toBeGreaterThan(firstB);
  });

  it('interlock: an end starts opening only once the other end reads position 0', () => {
    const s = newAirlockState();
    const o = newOccupancy();
    // A wanted: A opens fully.
    o.waitA = true;
    for (let i = 0; i <= 30; i++) stepAirlock(s, o, i * TICK, i * TICKS_PER_STEP, FULL);
    expect(doorFullyOpen(s.doorA, 30 * TICKS_PER_STEP)).toBe(true);
    // Force the target over to B: A shuts first, B holds at 0 until A reads 0.
    s.phase = AIRLOCK_OPEN_B;
    clearOccupancy(o);
    o.waitB = true;
    let bStartTick = -1;
    for (let i = 31; i < 120; i++) {
      const tick = i * TICKS_PER_STEP;
      s.phase = AIRLOCK_OPEN_B;
      stepAirlock(s, o, i * TICK, tick, FULL);
      if (bStartTick < 0 && s.doorB.seg.dir === 1) bStartTick = s.doorB.seg.t0;
    }
    expect(bStartTick).toBeGreaterThan(0);
    expect(doorPosAt(s.doorA.seg, bStartTick)).toBe(0);
    expect(doorPosAt(s.doorA.seg, bStartTick - 1)).toBeGreaterThan(0);
  });

  it('never has both doors off position 0 at any tick (random fleets and power)', () => {
    const ship = fc.record({
      lx: fc.integer({ min: -200, max: 200 }),
      ly: fc.integer({ min: -500, max: 500 }),
      admitted: fc.boolean(),
    });
    const frame = fc.record({ fleet: fc.array(ship, { maxLength: 4 }), level: fc.integer({ min: 0, max: FULL }), hold: fc.integer({ min: 1, max: 8 }) });
    fc.assert(
      fc.property(fc.array(frame, { minLength: 1, maxLength: 60 }), (frames) => {
        const s = newAirlockState();
        const o = newOccupancy();
        let step = 0;
        for (const f of frames) {
          clearOccupancy(o);
          for (const sh of f.fleet) addShipToOccupancy('airlock', sh.lx, sh.ly, R, sh.admitted, o);
          for (let h = 0; h < f.hold; h++, step++) {
            stepAirlock(s, o, step * TICK, step * TICKS_PER_STEP, f.level);
            expect(gateOpenMask(undefined, s)).not.toBe(3);
            for (let k = 0; k < TICKS_PER_STEP; k++) {
              const t = step * TICKS_PER_STEP + k;
              const both = doorPosAt(s.doorA.seg, t) > 0 && doorPosAt(s.doorB.seg, t) > 0;
              expect(both).toBe(false);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('Shipyard collider (loop 3M): the slipway is open from the keel out of the bow', () => {
  const { w, h } = STRUCTURE_KINDS.shipyard.footprint;
  const boxes = gateColliderBoxes('shipyard')!;
  const yardHulls = Object.values(RECIPES).flatMap((r) =>
    r.processors.includes('shipyard') ? r.outputs.flatMap((o) => ('hull' in o ? [o.hull] : [])) : []);
  /** Distance from (x, y) to the nearest solid part (0 inside one). */
  const clearance = (x: number, y: number): number => {
    let d = Infinity;
    for (const b of boxes) {
      const dx = Math.max(0, Math.abs(x - b.cx) - b.hw), dy = Math.max(0, Math.abs(y - b.cy) - b.hh);
      d = Math.min(d, Math.hypot(dx, dy));
    }
    return d;
  };

  it('its parts sit inside the footprint; the stern and both sides stay solid', () => {
    for (const b of boxes) {
      expect(Math.abs(b.cx) + b.hw).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(Math.abs(b.cy) + b.hh).toBeLessThanOrEqual(h / 2 + 1e-9);
    }
    expect(clearance(-w / 2 + 1, 0), 'stern headhouse').toBe(0);
    expect(clearance(0, h / 2 - 1), 'port side').toBe(0);
    expect(clearance(0, -h / 2 + 1), 'starboard side').toBe(0);
  });

  it('the yard-built sub-caps fit the slip; the Barge (a capital) does not', () => {
    for (const k of ['interceptor', 'gunship', 'heavy']) expect(yardHulls).toContain(k);
    for (const k of ['interceptor', 'gunship', 'heavy']) expect(shipyardSlipFits(k), k).toBe(true);
    expect(shipyardSlipFits('barge')).toBe(false);
  });

  it('every hull that fits, shield bubble and all, clears the frame from the keel to past the bow', () => {
    for (const kind of yardHulls.filter(shipyardSlipFits)) {
      const r = getShipKind(kind).radius + tuningFor(kind).shieldPad; // #18: from the kind's tuning
      for (let x = SHIPYARD_KEEL_X; x <= w / 2 + r; x += 5) {
        expect(clearance(x, 0), `${kind} at x=${x}`).toBeGreaterThan(r);
      }
    }
  });
});

describe('teleporter chamber colliders (redesign T1)', () => {
  const CHAMBERS = ['teleporter', 'teleporter_large', 'pocket_pad'] as const;
  /** Is world-offset point (x, y) inside one of the flat world-axis boxes? */
  const hit = (boxes: Float32Array, x: number, y: number): boolean => {
    for (let i = 0; i < boxes.length; i += 4) {
      if (Math.abs(x - boxes[i]!) <= boxes[i + 2]! && Math.abs(y - boxes[i + 1]!) <= boxes[i + 3]!) return true;
    }
    return false;
  };

  for (const kind of CHAMBERS) {
    const half = padHalfExtent(kind), r = PAD_SPECS[kind].padRadius, door = padDoorwayHalf(kind);
    const band = (r + half) / 2; // mid-thickness of the wall ring

    it(`${kind}: every part inside the footprint, none on the pad floor`, () => {
      for (const b of gateColliderBoxes(kind)!) {
        expect(Math.abs(b.cx) + b.hw).toBeLessThanOrEqual(half + 1e-9);
        expect(Math.abs(b.cy) + b.hh).toBeLessThanOrEqual(half + 1e-9);
        expect(Math.max(Math.abs(b.cx) - b.hw, Math.abs(b.cy) - b.hh)).toBeGreaterThanOrEqual(r - 1e-9);
      }
    });

    for (const [deg, angle] of [[0, 0], [90, Math.PI / 2], [180, Math.PI]] as const) {
      it(`${kind} at ${deg}°: walls are solid all round; both doorways are open`, () => {
        const boxes = gateWorldAxisBoxes(kind, angle)!;
        const c = Math.cos(angle), s = Math.sin(angle);
        const w = (lx: number, ly: number): [number, number] => [lx * c - ly * s, lx * s + ly * c];
        for (let t = -half + 1; t <= half - 1; t += 7) {
          // Side walls (local ±x): solid the whole way.
          expect(hit(boxes, ...w(band, t)), `+x wall at ${t}`).toBe(true);
          expect(hit(boxes, ...w(-band, t)), `-x wall at ${t}`).toBe(true);
          // Doorway ends (local ±y): open across the doorway, solid outside it.
          if (Math.abs(Math.abs(t) - door) < 0.5) continue; // exactly on the jamb
          const inDoor = Math.abs(t) < door;
          expect(hit(boxes, ...w(t, band)), `+y end at ${t}`).toBe(!inDoor);
          expect(hit(boxes, ...w(t, -band)), `-y end at ${t}`).toBe(!inDoor);
        }
        // A ship flies straight through along local y: nothing on the centre line.
        for (let t = -half - 50; t <= half + 50; t += 5) expect(hit(boxes, ...w(0, t))).toBe(false);
      });
    }
  }

  it("the Ancients' gate has no solid part at all (redesign A3: no posts, no walls)", () => {
    expect(gateColliderBoxes('alien_gate')).toEqual([]);
    expect(gateColliderPolygons('alien_gate')).toEqual([]);
  });
});
