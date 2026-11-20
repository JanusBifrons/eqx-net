/**
 * Solid doors slice 9 (docs/plans/door-power.md) — the door segment on the
 * structure row. Two-sided contract (#15): the SERVER writer
 * (`writeDoorMotionRow`) and the CLIENT decoder (`decodeStructureState`) must
 * agree on every door's position at every tick, and the client rig scrub must
 * read the same door clock (`doorPosAt` / `doorClipTime`). Late join (#16): a
 * fresh client row decoded from ONE snapshot of the row has the doors exactly.
 */
import { describe, expect, it } from 'vitest';
import type { StructureState } from '../../src/server/rooms/schema/SectorState';
import {
  AIRLOCK_DOOR_A_CLIP, AIRLOCK_DOOR_B_CLIP, GATE_DOOR_CLIP, writeDoorMotionRow, type GateDoorSource,
} from '../../src/server/rooms/doorMotionRow';
import { decodeStructureState, emptyStructureRow } from '../../src/client/net/structureStateDecode';
import {
  DOOR_MOTION_OPEN, decodeDoorMotion, decodeRigClipIndex, encodeDoorMotion, type DoorMotionSeg, type StructureStateView,
} from '../../src/shared-types/structureStateWire';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_TRAVEL_TICKS } from '../../src/core/structures/gateGeometry';
import {
  GATE_OPEN_A, GATE_OPEN_B, gateOpenMask, newAirlockState, newGateState, newOccupancy, stepAirlock, stepGate,
  type AirlockState, type GateState,
} from '../../src/core/structures/gateLogic';
import { doorClipTime, doorPosAt } from '../../src/core/structures/doorMotion';
import { clipTime } from '../../src/core/articulation/evaluate';
import type { StructureRenderState } from '../../src/core/contracts/IRenderer';

const OWNERS = { ids: [''], names: [''] };
/** A bare row (the Colyseus schema class needs its decorator runtime; the
 *  writer only assigns plain fields). */
const newRow = (): StructureState => ({ connTo: { length: 0, at: () => undefined } }) as unknown as StructureState;
const view = (st: StructureState): StructureStateView => st as unknown as StructureStateView;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function source(gate?: GateState, airlock?: AirlockState): GateDoorSource {
  return {
    maskFor: () => gateOpenMask(gate, airlock),
    gateStateFor: () => gate,
    airlockStateFor: () => airlock,
  };
}

/** The client's door positions must equal the server's, now and later. */
function expectSameDoors(
  row: StructureRenderState, serverA: DoorMotionSeg, serverB: DoorMotionSeg | undefined, tick: number,
): void {
  for (const t of [tick, tick + 1, tick + 37, tick + DOOR_TRAVEL_TICKS * 3]) {
    expect(doorPosAt(row.doorA!, t)).toBe(doorPosAt(serverA, t));
    if (serverB !== undefined) expect(doorPosAt(row.doorB!, t)).toBe(doorPosAt(serverB, t));
  }
  // The rig scrub reads the same clock as the door (one door clock).
  const carried = serverB !== undefined && row.rigClip!.clipId === 'door-b' ? row.doorB! : row.doorA!;
  for (const t of [tick, tick + 50]) {
    expect(clipTime(row.rigClip!, t, DOOR_TRAVEL_TICKS)).toBeCloseTo(doorClipTime(doorPosAt(carried, t)), 9);
  }
}

describe('door motion wire helpers', () => {
  it('round-trips every field at its limits', () => {
    expect(DOOR_POS_MAX).toBeLessThanOrEqual(0x0fff);
    expect(DOOR_POWER_LEVELS).toBeLessThanOrEqual(0x0f);
    const f = { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 };
    const out: DoorMotionSeg = { p0: -1, t0: -1, dir: 1, level: -1 };
    for (const seg of [
      { p0: 0, t0: 0, dir: -1 as const, level: 0 },
      { p0: DOOR_POS_MAX, t0: 0xffffffff, dir: 1 as const, level: DOOR_POWER_LEVELS },
      { p0: 1234, t0: 98765, dir: 1 as const, level: 7 },
    ]) {
      encodeDoorMotion(seg, 1, f);
      expect(decodeRigClipIndex(f.rigClip)).toBe(1);
      expect(decodeDoorMotion(f.gateOpen, f.rigStart, f.rigHold, out)).toEqual(seg);
    }
    expect(encodeDoorMotion({ p0: 5, t0: 9, dir: 1, level: 3 }, 0, f).gateOpen).toBe(DOOR_MOTION_OPEN | 3);
  });

  it('refuses values that do not fit their bits', () => {
    const f = { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 };
    expect(() => encodeDoorMotion({ p0: 0x1000, t0: 0, dir: 1, level: 0 }, 0, f)).toThrow();
    expect(() => encodeDoorMotion({ p0: 0, t0: 0, dir: 1, level: 16 }, 0, f)).toThrow();
    expect(() => encodeDoorMotion({ p0: 0, t0: -1, dir: 1, level: 0 }, 0, f)).toThrow();
  });

  it('door clip indices are the ones the client reads', () => {
    expect(GATE_DOOR_CLIP).toBe(0);
    expect(AIRLOCK_DOOR_A_CLIP).toBe(0);
    expect(AIRLOCK_DOOR_B_CLIP).toBe(1); // doorOpenMaskOf (kind unknown) relies on this
  });
});

describe('door row: server writer vs client decoder (#15, #16)', () => {
  it('a gate: every tick of a random run decodes to the server door', () => {
    const r = rng(7);
    const g = newGateState(0);
    const st = newRow();
    const live = emptyStructureRow();
    const occ = newOccupancy();
    let level = DOOR_POWER_LEVELS;
    for (let tick = 1; tick < 6000; tick++) {
      if (r() < 0.01) occ.admittedNear = !occ.admittedNear;
      if (r() < 0.004) level = [DOOR_POWER_LEVELS, 8, 3, 0][Math.floor(r() * 4)]!;
      stepGate(g, occ, (tick * 1000) / 60, tick, level);
      writeDoorMotionRow('g', 'gate', source(g), st);
      decodeStructureState(view(st), OWNERS, live, 'shield_gate');
      expectSameDoors(live, g.door.seg, undefined, tick);
      expect(live.gateOpen).toBe(g.door.seg.dir > 0 ? GATE_OPEN_A : undefined);
      if (tick % 97 === 0) {
        const late = emptyStructureRow(); // a late joiner: one row, nothing else
        decodeStructureState(view(st), OWNERS, late, 'shield_gate');
        expectSameDoors(late, g.door.seg, undefined, tick);
      }
    }
  });

  it('an airlock: both ends decode to the server doors every tick (interlock end shut)', () => {
    const r = rng(11);
    const a = newAirlockState();
    const st = newRow();
    const live = emptyStructureRow();
    const occ = newOccupancy();
    let level = DOOR_POWER_LEVELS;
    let sawB = false;
    for (let tick = 1; tick < 12000; tick++) {
      if (r() < 0.01) occ.waitA = !occ.waitA;
      if (r() < 0.01) occ.waitB = !occ.waitB;
      if (r() < 0.006) { occ.inside = !occ.inside; occ.insideClearA = occ.insideClearB = r() < 0.7; }
      if (r() < 0.003) level = [DOOR_POWER_LEVELS, 9, 2, 0][Math.floor(r() * 4)]!;
      stepAirlock(a, occ, (tick * 1000) / 60, tick, level);
      writeDoorMotionRow('a', 'airlock', source(undefined, a), st);
      decodeStructureState(view(st), OWNERS, live, 'shield_airlock');
      expectSameDoors(live, a.doorA.seg, a.doorB.seg, tick);
      if (live.rigClip!.clipId === 'door-b') sawB = true;
      const openA = a.doorA.seg.dir > 0, openB = a.doorB.seg.dir > 0;
      expect(openA && openB).toBe(false);
      if (tick % 89 === 0) {
        const late = emptyStructureRow();
        decodeStructureState(view(st), OWNERS, late, 'shield_airlock');
        expectSameDoors(late, a.doorA.seg, a.doorB.seg, tick);
      }
    }
    expect(sawB).toBe(true);
  });

  it('an airlock whose ends re-segment on the same tick carries the end heading open', () => {
    const a = newAirlockState();
    Object.assign(a.doorA.seg, { p0: 0, t0: 100, dir: 1, level: DOOR_POWER_LEVELS });
    Object.assign(a.doorB.seg, { p0: 0, t0: 100, dir: -1, level: 0 });
    const st = newRow();
    const row = emptyStructureRow();
    writeDoorMotionRow('a', 'airlock', source(undefined, a), st);
    decodeStructureState(view(st), OWNERS, row, 'shield_airlock');
    expect(row.rigClip!.clipId).toBe('door-a');
    expectSameDoors(row, a.doorA.seg, a.doorB.seg, 100);
  });

  it('a still door patches nothing', () => {
    const g = newGateState(0);
    const st = newRow();
    writeDoorMotionRow('g', 'gate', source(g), st);
    const snap = [st.rigClip, st.rigStart, st.rigHold, st.gateOpen];
    writeDoorMotionRow('g', 'gate', source(g), st);
    expect([st.rigClip, st.rigStart, st.rigHold, st.gateOpen]).toEqual(snap);
  });

  it('without door states exposed, the open decision decodes as a door at rest there', () => {
    const st = newRow();
    const row = emptyStructureRow();
    writeDoorMotionRow('a', 'airlock', { maskFor: () => GATE_OPEN_B }, st);
    decodeStructureState(view(st), OWNERS, row, 'shield_airlock');
    expect(row.gateOpen).toBe(GATE_OPEN_B);
    expect(doorPosAt(row.doorB!, 123)).toBe(DOOR_POS_MAX);
    expect(doorPosAt(row.doorA!, 123)).toBe(0);
    // Kind not known yet (no pose): the open bits still read.
    const early = emptyStructureRow();
    decodeStructureState(view(st), OWNERS, early);
    expect(early.gateOpen).toBe(GATE_OPEN_B);
  });
});
