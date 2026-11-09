/**
 * Determinism guarantee for the 2026-05-09 client-side AI architectural fix.
 *
 * The fix has the client run the same `AiController` + `HostileDroneBehaviour`
 * the server runs. For drones to track their server-authoritative
 * counterparts between snapshot snaps, the two AI tick paths MUST be
 * deterministic — given identical (self, view) inputs they MUST produce
 * identical (fx, fy, torque) outputs to floating-point equality.
 *
 * If this test ever fails, the client-side AI prediction has lost
 * sync with the server and the drone-position-mismatch pathology
 * (visible clip-through, hitscan inaccuracy, ~22 u correction bursts
 * during combat) returns.
 *
 * The test runs two separate `AiController` instances through a synthetic
 * timeline of `tick()` calls, each tick passing the same player view,
 * the same drone pose, and the same tick number. Outputs must match
 * exactly across all ticks.
 */
import { describe, it, expect } from 'vitest';
import { AiController, type AiIntentSink } from '../../src/core/ai/AiController.js';
import { HostileDroneBehaviour } from '../../src/core/ai/HostileDroneBehaviour.js';
import type { AiEntity, AiPlayerView } from '../../src/core/contracts/IAiBehaviour.js';

interface RecordedIntent {
  slot: number;
  fx: number;
  fy: number;
  torque: number;
}

class CapturingSink implements AiIntentSink {
  readonly intents: RecordedIntent[] = [];
  postIntent(slot: number, fx: number, fy: number, torque: number): void {
    this.intents.push({ slot, fx, fy, torque });
  }
}

/** Drive a controller through `nTicks` ticks. Returns recorded intents. */
function runController(opts: {
  nTicks: number;
  startTick: number;
  drones: ReadonlyArray<{ id: string; slot: number; pose: AiEntity }>;
  player: AiPlayerView;
}): RecordedIntent[] {
  const sink = new CapturingSink();
  const ctrl = new AiController(sink);
  for (const d of opts.drones) {
    ctrl.register(d.id, d.slot, new HostileDroneBehaviour());
  }
  // Per-tick: player and drones move in a deterministic pattern. Both
  // controllers see the same data each tick.
  let player = opts.player;
  const droneStates = new Map<string, AiEntity>();
  for (const d of opts.drones) droneStates.set(d.id, d.pose);

  for (let i = 0; i < opts.nTicks; i++) {
    const tick = opts.startTick + i;
    // Player drifts +X at 5 u/sec.
    player = { ...player, x: player.x + 5 * (1 / 60) };
    ctrl.tick(tick, 1 / 60, [player], (id) => droneStates.get(id) ?? null);
    // Drone "self" stays fixed for the test — we're checking AI output
    // determinism, not whether physics integrates the impulses identically.
    // (Physics integration is tested separately in the dual-PhysicsWorld
    // dronePlayerCollisionDrift.test.ts harness.)
  }
  return sink.intents;
}

describe('client AI determinism — two controllers must produce identical output', () => {
  it('single drone, single player, 60 ticks: bit-identical intent sequence', () => {
    const drones = [
      {
        id: 'drone-1',
        slot: 1,
        pose: { id: 'drone-1', x: 100, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
      },
    ];
    const player: AiPlayerView = { id: 'player', x: 0, y: 0, vx: 0, vy: 0 };

    const a = runController({ nTicks: 60, startTick: 1000, drones, player });
    const b = runController({ nTicks: 60, startTick: 1000, drones, player });

    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.slot).toBe(b[i]!.slot);
      expect(a[i]!.fx).toBe(b[i]!.fx); // exact float equality
      expect(a[i]!.fy).toBe(b[i]!.fy);
      expect(a[i]!.torque).toBe(b[i]!.torque);
    }
  });

  it('many drones, varied poses: intent stream is bit-identical', () => {
    const drones = Array.from({ length: 16 }, (_, i) => ({
      id: `drone-${i}`,
      slot: i,
      pose: {
        id: `drone-${i}`,
        x: 100 + i * 30,
        y: -50 + (i % 5) * 20,
        vx: (i % 3) - 1,
        vy: (i % 2) === 0 ? 0.5 : -0.5,
        angle: i * 0.2,
        angvel: 0,
      } satisfies AiEntity,
    }));
    const player: AiPlayerView = { id: 'p', x: 200, y: 0, vx: 1, vy: 0 };

    const a = runController({ nTicks: 30, startTick: 5000, drones, player });
    const b = runController({ nTicks: 30, startTick: 5000, drones, player });

    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toEqual(b[i]); // deep equality on every recorded intent
    }
  });

  it('starts at different tick: results map cleanly (lastFireTick state offset only)', () => {
    // Same logical scenario, just numbered from different starting ticks.
    // Intents should be identical *up to lastFireTick differences* — the
    // P-controller for movement is purely geometric. We compare fx/fy/torque
    // only (not fire), and they must match.
    const drones = [
      {
        id: 'd',
        slot: 0,
        pose: { id: 'd', x: 80, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
      },
    ];
    const player: AiPlayerView = { id: 'p', x: 0, y: 0, vx: 0, vy: 0 };

    const a = runController({ nTicks: 30, startTick: 0, drones, player });
    const b = runController({ nTicks: 30, startTick: 99_999, drones, player });

    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      // Movement intent (fx, fy, torque) is purely geometric — no tick dep.
      expect(a[i]!.fx).toBe(b[i]!.fx);
      expect(a[i]!.fy).toBe(b[i]!.fy);
      expect(a[i]!.torque).toBe(b[i]!.torque);
    }
  });
});
