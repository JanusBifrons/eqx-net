/**
 * Event shells advance evenly every frame (hostile review of rail take 6,
 * 2026-11-15): early in flight the railgun slug's head stepped 6, 23, 5, 29,
 * 2, 29 px per frame (an effective 30 Hz) before settling to an uneven 11/19.
 *
 * Cause (here, in `ColyseusClient.updateMirror`): event shells are placed at
 * a display tick computed from `gameClock.now()` read mid-frame, AFTER the
 * frame's snapshot work (decode, apply, reconcile). That work lands on every
 * other frame or so (20-30 Hz snapshots) and costs a few ms, so the sampled
 * time jitters by that much around the frame's own time; at 6,450 u/s every
 * ms is ~6 u (~2.6 px at capital zoom). The local ship already uses the
 * frame's own timestamp (`frameNowMs`, the RAF time) for exactly this reason.
 * Shells now take the display tick at the frame time too.
 */
import { describe, expect, it } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';

interface Internals {
  updateMirror(frameNowMs?: number): void;
  mirror: { projectiles?: Map<string, { x: number; event?: boolean }> };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
}

const SPEED = 6_450; // u/s, the railgun
const FRAME_MS = 1000 / 60;

describe('event shells advance evenly every frame (frame time, not mid-frame clock)', () => {
  it('a slug steps one frame of travel per frame however long each frame\'s snapshot work took', () => {
    const clock = new MockClock(10_000);
    const c = new ColyseusGameClient(clock) as unknown as Internals;
    c._shellEvents = true;
    c.mirror.projectiles = new Map();
    c.clockAnchorServerTick = 1000;
    c.clockAnchorPerfNow = 10_000;
    const salvo: ShellSalvo = {
      type: 'shell_salvo', s: 1, o: 'swarm-3', w: 'railgun', t: 1000, n: 600,
      sh: [['slug-1', 0, 0, SPEED, 0]],
    };
    c._shellStore.applySalvo(salvo);
    const xs: number[] = [];
    for (let k = 20; k < 40; k++) {
      const frameNow = 10_000 + k * FRAME_MS;
      // This frame's snapshot work: heavy on alternate frames.
      clock.set(frameNow + (k % 2 === 0 ? 9 : 1));
      c.updateMirror(frameNow);
      const p = c.mirror.projectiles.get('slug-1');
      expect(p?.event, `frame ${k}: the slug is drawn`).toBe(true);
      xs.push(p!.x);
    }
    const step = SPEED / 60;
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!, `frame ${i}: step`).toBeCloseTo(step, 3);
    }
  });
});
