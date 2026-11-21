/**
 * Phone-lane frame phase timing (docs/ops/phone-link.md "Play evidence"): the
 * marks sum each phase's time into one preallocated array per frame, a stall
 * frame keeps its breakdown, and stall events carry it as `phases`. Off the
 * lane the marks read no clock and record nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LANE_PHASES,
  LANE_STALL_PHASE_MS,
  LanePhase,
  LanePhaseRecorder,
  applyLanePhases,
  installLanePhaseTiming,
  lanePhaseMark,
  lanePhaseRecorder,
  lanePhaseStart,
  markLaneLoopPhases,
  resetLanePhaseTimingForTest,
  rollLanePhases,
} from './lanePhaseTiming';

let clock = 0;
function fakeClock(): void {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
}

describe('lane phase timing', () => {
  afterEach(() => {
    resetLanePhaseTimingForTest();
    vi.restoreAllMocks();
  });

  it('phase ids index LANE_PHASES', () => {
    expect(LanePhase.inbound).toBe(0);
    expect(LANE_PHASES[LanePhase.pixiRender]).toBe('pixiRender');
    expect(new Set(Object.values(LanePhase)).size).toBe(LANE_PHASES.length);
  });

  it('off the lane: marks read no clock and record nothing', () => {
    const now = vi.spyOn(performance, 'now');
    expect(lanePhaseStart()).toBe(0);
    expect(lanePhaseMark(LanePhase.swarm, 5)).toBe(0);
    markLaneLoopPhases(1, 2, 3, 4);
    rollLanePhases(100);
    expect(now).not.toHaveBeenCalled();
    const d = { elapsedMs: 100 };
    expect(applyLanePhases(d)).toEqual({ elapsedMs: 100 });
    expect(lanePhaseRecorder()).toBeNull();
  });

  it('chained marks sum per phase within a frame; a stall frame keeps its breakdown', () => {
    fakeClock();
    const rec = installLanePhaseTiming();
    expect(installLanePhaseTiming()).toBe(rec); // idempotent
    // Loop phases from the RAF loop's own stamps.
    markLaneLoopPhases(1000, 1002, 1005, 1006); // inbound 2, physics 3, mirror 1
    let t = lanePhaseStart();
    clock += 4; t = lanePhaseMark(LanePhase.swarm, t);
    clock += 1.5; t = lanePhaseMark(LanePhase.connectors, t);
    clock += 6; lanePhaseMark(LanePhase.swarm, t); // a phase marked twice adds up
    clock += 0.01; // a phase under 0.05 ms is left out of the event
    lanePhaseMark(LanePhase.feedback, clock - 0.01);
    rollLanePhases(LANE_STALL_PHASE_MS + 10);
    expect(rec.cur.every((v) => v === 0)).toBe(true); // rolled: next frame starts at zero
    const d = applyLanePhases({ elapsedMs: 40 });
    expect(d).toEqual({
      elapsedMs: 40,
      phases: { inbound: 2, physics: 3, mirror: 1, swarm: 10, connectors: 1.5 },
      phasesAgeMs: 0,
    });
  });

  it('a frame under the stall floor does not replace the last stall breakdown', () => {
    fakeClock();
    installLanePhaseTiming();
    let t = lanePhaseStart();
    clock += 25; t = lanePhaseMark(LanePhase.pixiRender, t);
    rollLanePhases(45);
    clock += 3; lanePhaseMark(LanePhase.ships, t);
    rollLanePhases(LANE_STALL_PHASE_MS); // not over the floor
    clock += 100;
    expect(applyLanePhases({})).toEqual({ phases: { pixiRender: 25 }, phasesAgeMs: 103 });
  });

  it('no stall yet: the event is untouched', () => {
    fakeClock();
    installLanePhaseTiming();
    rollLanePhases(12);
    expect(applyLanePhases({ a: 1 })).toEqual({ a: 1 });
  });

  it('a chain begun before install (start 0) records nothing for that span', () => {
    fakeClock();
    const t0 = lanePhaseStart(); // off: 0
    const rec = installLanePhaseTiming();
    lanePhaseMark(LanePhase.swarm, t0);
    markLaneLoopPhases(0, 1002, 1005, 1006);
    expect(rec.cur.every((v) => v === 0)).toBe(true);
  });

  it('allocates nothing per frame: the same two buffers over many frames, sums exact', () => {
    fakeClock();
    const rec = installLanePhaseTiming();
    const cur = rec.cur;
    const stall = rec.stall;
    for (let f = 0; f < 5000; f++) {
      let t = lanePhaseStart();
      clock += 2; t = lanePhaseMark(LanePhase.swarm, t);
      clock += 1; lanePhaseMark(LanePhase.pixiRender, t);
      if (f === 4999) break; // leave the last frame unrolled to read its sums
      rollLanePhases(f % 100 === 0 ? 50 : 11);
    }
    expect(rec.cur).toBe(cur);
    expect(rec.stall).toBe(stall);
    expect(cur[LanePhase.swarm]).toBe(2);
    expect(cur[LanePhase.pixiRender]).toBe(1);
    expect(stall[LanePhase.swarm]).toBe(2);
    expect(cur.reduce((s, v) => s + v, 0)).toBe(3);
  });

  it('recorder class on its own: roll keeps the gap and the stall time', () => {
    const r = new LanePhaseRecorder();
    expect(r.stallPhases()).toBeNull();
    r.add(LanePhase.art, 7.26);
    r.roll(80, 5000);
    expect(r.stallGapMs).toBe(80);
    expect(r.stallAtMs).toBe(5000);
    expect(r.stallPhases()).toEqual({ art: 7.3 });
  });
});
