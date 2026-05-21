/**
 * Self-test for the replay harness. Verifies:
 *  - A real capture loads + replays without crashing
 *  - The harness produces non-empty traces
 *  - ColyseusGameClient internals reach the post-bootstrap state
 *
 * NOTE: this test runs against captures recorded BEFORE Phase A's
 * augmented capture format shipped — so they lack `input_intent` /
 * `local_pose_rendered` / `local_pose_predicted` events. The harness
 * gracefully handles this: replayed trace will have zero inputs and
 * zero ground-truth pairs but will still produce rendered/predicted
 * poses from the rafTick events alone. The Phase E ground-truth
 * verification needs a FRESH capture taken on this commit's code.
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from './captureHarness';

const ERS7XY = 'diag/captures/2026-05-20T22-47-58-606Z-ers7xy';
const VG9HON = 'diag/captures/2026-05-20T22-37-34-348Z-vg9hon';

describe('replayCapture', () => {
  it('loads and replays the ers7xy on-device capture without crashing', async () => {
    const trace = await replayCapture(ERS7XY);

    // Basic liveness
    expect(trace.source.playerId).toBeTruthy();
    expect(trace.events.length).toBeGreaterThan(100);

    // Final stats should reflect that snapshots were processed.
    expect(trace.finalStats.snapshotCount).toBeGreaterThan(50);

    // rafTick events should have produced rendered-pose samples.
    expect(trace.renderedPoses.length).toBeGreaterThan(10);

    // predWorld bodies were spawned + advanced → predicted poses captured.
    expect(trace.predictedPoses.length).toBeGreaterThan(10);

    // Ground truth pairs require Phase A enrichment in the capture —
    // ers7xy predates it, so this is expected to be 0. Phase E will
    // re-record with the enriched format.
    // No assertion here; Phase E covers it.

    // Inputs / inputSent require Phase A enrichment too — pre-A captures
    // had `inputSent` (sampled) but not `input_intent`. Pre-A captures
    // therefore replay with empty inputs (mock keyboard stays idle).
  });

  it('loads and replays the vg9hon on-device capture without crashing', async () => {
    const trace = await replayCapture(VG9HON);
    expect(trace.source.playerId).toBeTruthy();
    expect(trace.finalStats.snapshotCount).toBeGreaterThan(50);
    expect(trace.renderedPoses.length).toBeGreaterThan(10);
  });
});
