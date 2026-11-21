/**
 * Phone-lane stall context (docs/ops/phone-link.md "Play evidence"): in a lane
 * build every `raf_stutter` / `raf_gap` / `loaf` event carries the zoom
 * (`viewHalf`) and control mode at the moment it fired; off the lane the event
 * data is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IRenderer } from '@core/contracts/IRenderer';
import { applyLaneStallContext } from './laneFrameSummary';

const logEvent = vi.fn();
vi.mock('../ClientLogger', () => ({ logEvent: (...a: unknown[]) => logEvent(...a), isAutoCaptureEnabled: () => true }));

type Mod = typeof import('./laneFrameSummary');
type Det = typeof import('../../net/RafStallDetector');

async function load(lane: boolean): Promise<{ mod: Mod; det: Det }> {
  vi.resetModules();
  vi.stubEnv('VITE_PHONE_LANE', lane ? '1' : '');
  const mod = await import('./laneFrameSummary');
  const det = await import('../../net/RafStallDetector');
  return { mod, det };
}

const fakeRenderer = (viewHalf: number): IRenderer => ({ getFeedback: () => ({ viewHalf }) }) as unknown as IRenderer;

describe('lane stall context', () => {
  beforeEach(() => {
    logEvent.mockReset();
    vi.useFakeTimers(); // the 10 s summary interval
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('applyLaneStallContext rounds the zoom, nulls a missing one, and returns the same object', () => {

    const d = { elapsedMs: 86 };
    expect(applyLaneStallContext(d, 1834.6, 'command')).toBe(d);
    expect(d).toEqual({ elapsedMs: 86, viewHalf: 1835, mode: 'command' });
    expect(applyLaneStallContext({}, 0, null)).toEqual({ viewHalf: null, mode: null });
    expect(applyLaneStallContext({}, undefined, 'fly')).toEqual({ viewHalf: null, mode: 'fly' });
  });

  it('lane build: raf_stutter and raf_gap carry zoom + control mode', async () => {
    const { mod, det } = await load(true);
    let mode: 'fly' | 'command' | 'build' = 'fly';
    mod.installLanePerfSummary(fakeRenderer(2400.4), () => mode);
    const d = new det.RafStallDetector();
    d.detectGap(60, 10, 1000);
    mode = 'build';
    d.detectGap(140, 11, 2000);
    // Nothing marked a phase here: the stall frame's breakdown is empty (all untimed).
    expect(logEvent).toHaveBeenCalledWith('raf_stutter', { elapsedMs: 60, inputTickBefore: 10, viewHalf: 2400, mode: 'fly', phases: {}, phasesAgeMs: expect.any(Number) });
    expect(logEvent).toHaveBeenCalledWith('raf_gap', expect.objectContaining({ elapsedMs: 140, viewHalf: 2400, mode: 'build' }));
  });

  it('lane build: a stall event carries the phases marked during the stalled frame', async () => {
    const { mod, det } = await load(true);
    const phases = await import('./lanePhaseTiming');
    mod.installLanePerfSummary(fakeRenderer(1000), () => 'command');
    const rec = phases.lanePhaseRecorder();
    expect(rec).not.toBeNull();
    rec!.add(phases.LanePhase.swarm, 22.04);
    rec!.add(phases.LanePhase.pixiRender, 31);
    new det.RafStallDetector().detectGap(70, 12, 1000);
    expect(logEvent).toHaveBeenCalledWith('raf_stutter', expect.objectContaining({
      elapsedMs: 70, mode: 'command', phases: { swarm: 22, pixiRender: 31 },
    }));
    expect(rec!.cur[phases.LanePhase.swarm]).toBe(0); // rolled at the gap
  });

  it('normal build: stall events stay as they were (no zoom, no mode)', async () => {
    const { mod, det } = await load(false);
    mod.installLanePerfSummary(fakeRenderer(2400), () => 'fly');
    new det.RafStallDetector().detectGap(60, 10, 1000);
    expect(logEvent).toHaveBeenCalledWith('raf_stutter', { elapsedMs: 60, inputTickBefore: 10 });
    expect(mod.withLaneStallContext({ a: 1 })).toEqual({ a: 1 });
  });
});
