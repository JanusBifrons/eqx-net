/**
 * Off-pilot display-delay sizing (netcode gap smoothing S5-9): the mode
 * target, the gap peak, ring thinning, the pilot catch-up slew, the off-pilot
 * hold maximum and the outage-backlog tick-clock rule.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_DELAY_CEILING_MS, DISPLAY_DELAY_CATCHUP_MAX_RATE, DISPLAY_DELAY_MS, OFF_PILOT_DELAY_CEILING_MS,
  OFF_PILOT_GAP_DECAY_TAU_MS, OFF_PILOT_GAP_HOLD_MS, OFF_PILOT_GAP_MARGIN_MS, OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS,
  createGapPeakState, ringThinningSpacingMs, stepGapPeak, swarmDelayTargetWallMs,
} from './swarmDelaySizing.js';
import { createDisplayDelayHoldState, holdDisplayDelay, slewDisplayDelay } from './displayDelayHold.js';
import {
  OFF_PILOT_BACKLOG_LATE_MS, createSwarmDelayModeState, isOffPilotClockBacklog, noteSwarmStaleness, settleCatchUp,
  swarmHoldMaxWallMs, switchSwarmDelayMode,
} from './swarmDelayMode.js';

const FRAME_MS = 1000 / 60;
const GLIDE_MS = 250;

describe('swarmDelayTargetWallMs (S5-9)', () => {
  it('pilot ignores the gap peak: the S5-7 clamp exactly', () => {
    for (const input of [50, 120, 400]) {
      const clamp = Math.max(DISPLAY_DELAY_MS, Math.min(ADAPTIVE_DELAY_CEILING_MS, input));
      expect(swarmDelayTargetWallMs(input, 1, 'pilot', 2000)).toBe(clamp);
    }
  });

  it('off pilot: gap peak + margin, never under the pilot target, capped at the ceiling ÷ speed', () => {
    expect(swarmDelayTargetWallMs(120, 1, 'offPilot', 0)).toBe(120);
    expect(swarmDelayTargetWallMs(120, 1, 'offPilot', 10)).toBe(120);
    expect(swarmDelayTargetWallMs(120, 1, 'offPilot', 1500)).toBe(1500 + OFF_PILOT_GAP_MARGIN_MS);
    expect(swarmDelayTargetWallMs(120, 1, 'offPilot', 9000)).toBe(OFF_PILOT_DELAY_CEILING_MS);
    expect(swarmDelayTargetWallMs(120, 2, 'offPilot', 9000)).toBe(OFF_PILOT_DELAY_CEILING_MS / 2);
  });
});

describe('stepGapPeak (S5-9)', () => {
  it('takes a larger staleness at once, holds it, then decays', () => {
    const g = createGapPeakState();
    stepGapPeak(g, 1800, FRAME_MS);
    expect(g.peakMs).toBe(1800);
    for (let t = 0; t < OFF_PILOT_GAP_HOLD_MS; t += 100) stepGapPeak(g, 20, 100);
    expect(g.peakMs).toBe(1800);
    stepGapPeak(g, 20, OFF_PILOT_GAP_DECAY_TAU_MS);
    expect(g.peakMs).toBeCloseTo(1800 * Math.exp(-1), 6);
  });

  it('a repeat outage about the peak size re-arms the hold', () => {
    const g = createGapPeakState();
    stepGapPeak(g, 2000, FRAME_MS);
    for (let t = 0; t < OFF_PILOT_GAP_HOLD_MS - 1000; t += 100) stepGapPeak(g, 20, 100);
    stepGapPeak(g, 1990, FRAME_MS);
    expect(g.ageMs).toBe(0);
    expect(g.peakMs).toBe(2000);
  });

  it('noteSwarmStaleness skips a long (page-stall) frame and a missing stamp', () => {
    const m = createSwarmDelayModeState();
    noteSwarmStaleness(m, 5000, 1000, 1000);
    noteSwarmStaleness(m, 5000, Number.NaN, FRAME_MS);
    expect(m.gap.peakMs).toBe(0);
    noteSwarmStaleness(m, 5000, 4000, FRAME_MS);
    expect(m.gap.peakMs).toBe(1000);
  });
});

describe('ringThinningSpacingMs (S5-9)', () => {
  it('spaces samples so 24 of 28 slots cover 1.25× the delay; 0 for no delay', () => {
    expect(ringThinningSpacingMs(0, 28)).toBe(0);
    expect(ringThinningSpacingMs(2400, 28)).toBeCloseTo(125, 9);
  });
});

describe('pilot catch-up and the off-pilot hold maximum (S5-9)', () => {
  it('off pilot → pilot: catch-up shrinks at the fast rate and settles at the target', () => {
    const m = createSwarmDelayModeState();
    switchSwarmDelayMode(m, 'offPilot');
    expect(switchSwarmDelayMode(m, 'pilot')).toBe(true);
    expect(m.catchUp).toBe(true);
    const s = createDisplayDelayHoldState(2000);
    s.targetMs = 100;
    let prev = s.delayMs;
    let frames = 0;
    let nearAtMs = Number.NaN;
    while (m.catchUp && frames < 120) {
      slewDisplayDelay(s, FRAME_MS, 1, m.catchUp);
      expect(prev - s.delayMs).toBeLessThanOrEqual(DISPLAY_DELAY_CATCHUP_MAX_RATE * FRAME_MS + 1e-9);
      expect(s.delayMs).toBeLessThanOrEqual(prev);
      prev = s.delayMs;
      settleCatchUp(m, s);
      frames++;
      if (Number.isNaN(nearAtMs) && s.delayMs <= s.targetMs + 5) nearAtMs = frames * FRAME_MS;
    }
    expect(m.catchUp).toBe(false);
    // Within 5 ms of the target in ~0.5 s; the exponential tail then settles.
    expect(nearAtMs).toBeLessThan(600);
    expect(frames * FRAME_MS).toBeLessThan(1200);
    expect(s.delayMs).toBe(100);
  });

  it('without catch-up a shrink keeps the normal slew', () => {
    const fast = createDisplayDelayHoldState(2000);
    const slow = createDisplayDelayHoldState(2000);
    fast.targetMs = slow.targetMs = 100;
    slewDisplayDelay(fast, FRAME_MS, 1, true);
    slewDisplayDelay(slow, FRAME_MS, 1);
    expect(2000 - fast.delayMs).toBeGreaterThan(2000 - slow.delayMs);
    // Growing is never fast.
    const grow = createDisplayDelayHoldState(100);
    const growRef = createDisplayDelayHoldState(100);
    grow.targetMs = growRef.targetMs = 2000;
    slewDisplayDelay(grow, FRAME_MS, 1, true);
    slewDisplayDelay(growRef, FRAME_MS, 1);
    expect(grow.delayMs).toBe(growRef.delayMs);
  });

  it('the hold maximum: undefined in pure pilot; 4 s ÷ speed off pilot and through catch-up', () => {
    const m = createSwarmDelayModeState();
    expect(swarmHoldMaxWallMs(m, 1)).toBeUndefined();
    switchSwarmDelayMode(m, 'offPilot');
    expect(swarmHoldMaxWallMs(m, 2)).toBe(OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS / 2);
    switchSwarmDelayMode(m, 'pilot');
    expect(swarmHoldMaxWallMs(m, 1)).toBe(OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS);
  });

  it('holdDisplayDelay with a maximum holds a 2 s stall, re-syncs past it', () => {
    const s = createDisplayDelayHoldState(100);
    holdDisplayDelay(s, 10_000, 7_800, GLIDE_MS, 1, OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS);
    expect(s.holdActive).toBe(true);
    expect(s.delayMs).toBe(1950);
    const r = createDisplayDelayHoldState(100);
    holdDisplayDelay(r, 10_000, 5_000, GLIDE_MS, 1, OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS);
    expect(r.resyncCount).toBe(1);
    expect(r.delayMs).toBe(100);
  });
});

describe('isOffPilotClockBacklog (S5-9)', () => {
  it('only off pilot (or catching up), only between the backlog floor and the hold maximum', () => {
    const m = createSwarmDelayModeState();
    expect(isOffPilotClockBacklog(m, 1500, 1)).toBe(false);
    switchSwarmDelayMode(m, 'offPilot');
    expect(isOffPilotClockBacklog(m, OFF_PILOT_BACKLOG_LATE_MS, 1)).toBe(false);
    expect(isOffPilotClockBacklog(m, 1500, 1)).toBe(true);
    expect(isOffPilotClockBacklog(m, OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS + 1, 1)).toBe(false);
    switchSwarmDelayMode(m, 'pilot');
    expect(isOffPilotClockBacklog(m, 1500, 1)).toBe(true);
  });
});
