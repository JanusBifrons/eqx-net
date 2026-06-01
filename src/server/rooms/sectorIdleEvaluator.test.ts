/**
 * Regression locks for `evaluateSectorIdle` — captures the
 * 2026-06-01 user smoke bug (capture `2026-06-01T16-07-35Z-0bboym`)
 * where idle suppression engaged during natural play lulls and
 * produced 250-1184 ms `recv_gap_long` events on the client.
 *
 * The first 3 tests describe the OLD bug class (motion-only signal):
 * a connected client sitting still with no projectiles in flight and
 * no swarm entities active would flip the sector to idle within
 * `IDLE_THRESHOLD_TICKS`. The fix (commit 98c8bc5) makes
 * `connectedClientCount > 0` an unconditional "non-idle" signal —
 * the perf savings of broadcast-suppressing a connected-but-AFK
 * sector aren't worth the user-perceived 250-1184 ms freezes.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSectorIdle, type IdleEvalCtx } from './sectorIdleEvaluator.js';
import { createIdleTracker } from '../net/snapshotScheduler.js';
import type { PoseRecord } from './SabPoseMirror.js';

function emptyShipPoseCache(): Map<string, PoseRecord> {
  return new Map<string, PoseRecord>();
}

function ctx(overrides: Partial<IdleEvalCtx> = {}): IdleEvalCtx {
  return {
    idleTracker: createIdleTracker(),
    serverTick: 100,
    shipPoseCache: emptyShipPoseCache(),
    liveProjectiles: { size: 0 },
    connectedClientCount: 0,
    swarmEntityCount: 0,
    forceBroadcastUntilTick: 0,
    idleMotionEpsilonSq: 0.05,
    idleThresholdTicks: 60,
    ...overrides,
  };
}

describe('evaluateSectorIdle — connected-client override (commit 98c8bc5)', () => {
  it('NEVER returns idle while a client is connected — even when player is stationary and no swarm/projectiles', () => {
    // The bug case: connected client, stationary, no projectiles, no
    // swarm entities. Pre-fix this returned true after 60 ticks of
    // inactivity → broadcast suppression engaged → user perceived
    // 250-1184 ms freezes (smoke capture `0bboym`).
    const tracker = createIdleTracker();
    // Simulate 200 ticks of "the player is sitting still" — well past
    // IDLE_THRESHOLD_TICKS=60. Pre-fix, the second tick onwards would
    // have returned true.
    let idleAt: number[] = [];
    for (let tick = 1; tick <= 200; tick++) {
      const c = ctx({
        idleTracker: tracker,
        serverTick: tick,
        connectedClientCount: 1, // CLIENT CONNECTED
        swarmEntityCount: 0,
        liveProjectiles: { size: 0 },
      });
      if (evaluateSectorIdle(c)) idleAt.push(tick);
    }
    expect(
      idleAt,
      `sector flagged idle on these ticks: ${idleAt.join(',')} — a connected client must NEVER trigger broadcast suppression`,
    ).toEqual([]);
  });

  it('STILL returns idle when no clients are connected and nothing is active (empty-sector path unchanged)', () => {
    // The headless / no-observer case is the legitimate use case for
    // suppression. Confirm the fix doesn't break it — galaxy sectors
    // tick even when empty, but should still be marked idle so the
    // outer broadcast loop short-circuits cleanly.
    const tracker = createIdleTracker();
    for (let tick = 1; tick <= 200; tick++) {
      evaluateSectorIdle(
        ctx({
          idleTracker: tracker,
          serverTick: tick,
          connectedClientCount: 0,
          swarmEntityCount: 0,
          liveProjectiles: { size: 0 },
        }),
      );
    }
    // After 200 ticks of no signals at all, sector should be idle.
    const final = evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 200,
        connectedClientCount: 0,
        swarmEntityCount: 0,
        liveProjectiles: { size: 0 },
      }),
    );
    expect(final).toBe(true);
  });

  it('respects join-grace window (forceBroadcastUntilTick) regardless of client count', () => {
    // Within the join-broadcast-grace window, sectorIdle MUST be false
    // (Phase G3 — freshly-joined client needs steady snapshot stream
    // before suppression can quiet the sector). This pre-dates the
    // client-count fix; ensure the new short-circuit doesn't break it.
    const tracker = createIdleTracker();
    const result = evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 50,
        connectedClientCount: 0, // no clients, but still in grace
        forceBroadcastUntilTick: 100,
        swarmEntityCount: 0,
      }),
    );
    expect(result).toBe(false);
  });

  it('the OLD bug surface: WITHOUT connectedClientCount signal, motion-only sector would flip to idle', () => {
    // This test documents the pre-fix BEHAVIOUR shape so a future
    // re-introduction of the bug is loud. We test the path by
    // simulating connectedClientCount=0 (so the new short-circuit
    // doesn't fire) but having a client-like scenario otherwise:
    // stationary ship, no projectiles, no swarm.
    const tracker = createIdleTracker();
    for (let tick = 1; tick <= 100; tick++) {
      evaluateSectorIdle(
        ctx({
          idleTracker: tracker,
          serverTick: tick,
          connectedClientCount: 0,
          swarmEntityCount: 0,
          liveProjectiles: { size: 0 },
        }),
      );
    }
    // 100 ticks later, with no signals = idle
    const final = evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 100,
        connectedClientCount: 0,
        swarmEntityCount: 0,
      }),
    );
    expect(final).toBe(true);
  });
});

describe('evaluateSectorIdle — fallback signals (no clients, headless tick)', () => {
  it('swarm entity present keeps sector active even without clients', () => {
    const tracker = createIdleTracker();
    evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 100,
        connectedClientCount: 0,
        swarmEntityCount: 5,
      }),
    );
    // serverTick advanced 60 ticks since the last event — but the
    // event was just noted on tick 100, so we check tick 100 + 30 ticks
    // (still within threshold).
    const result = evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 130,
        connectedClientCount: 0,
        swarmEntityCount: 0, // swarm now empty, but event was recent
      }),
    );
    expect(result).toBe(false);
  });

  it('live projectile keeps sector active in headless tick', () => {
    const tracker = createIdleTracker();
    evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 100,
        connectedClientCount: 0,
        swarmEntityCount: 0,
        liveProjectiles: { size: 3 },
      }),
    );
    const result = evaluateSectorIdle(
      ctx({
        idleTracker: tracker,
        serverTick: 130,
        connectedClientCount: 0,
        swarmEntityCount: 0,
        liveProjectiles: { size: 0 },
      }),
    );
    expect(result).toBe(false);
  });
});
