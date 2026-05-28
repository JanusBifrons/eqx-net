/**
 * Structural regression lock for the 2026-05-28 ramming-probe alloc gate
 * (capture ilhqk6).
 *
 * The ramming probe in `ColyseusClient.updateMirror` was added by the
 * shield-test handoff for diagnosing visual-vs-physics divergence. It
 * runs every frame while within 1500 u of any drone and builds a ~12-
 * field object literal that feeds `logEvent('ramming_probe', ...)`.
 * Under heavy near-drone activity that became the dominant allocation
 * source on the client (3988 events / 73 s in capture ilhqk6 — ~55/sec
 * sustained), driving the heap from 35 → 83 MB and triggering GC
 * pauses that delayed snapshot receives 244-557 ms and produced the
 * 150 u correction snap the user reported as jumping.
 *
 * Per Invariant #14 the block must be gated so production never
 * allocates. The gate is `isFullDiagMode()` — same predicate that
 * gates other high-volume diagnostic-only logs in this file.
 *
 * This test is structural (greps the source) because the probe lives
 * deep inside a private `updateMirror` path that's expensive to harness.
 * It's small but specific: a future PR that drops the gate fails here
 * with a clear message before any device smoke would surface the
 * lag-regression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLYSEUS_CLIENT = join(__dirname, '..', '..', 'src', 'client', 'net', 'ColyseusClient.ts');

describe('ColyseusClient — ramming-probe alloc gate (capture ilhqk6)', () => {
  it('the ramming_probe block is gated on isFullDiagMode()', () => {
    const src = readFileSync(COLYSEUS_CLIENT, 'utf-8');
    const probeIdx = src.indexOf("logEvent('ramming_probe'");
    expect(probeIdx, 'ramming_probe logEvent call should exist (gated)').toBeGreaterThan(-1);

    // Walk backwards to find the nearest enclosing `isFullDiagMode()`
    // call — accepts both plain `if (isFullDiagMode())` and compound
    // gates like `if (isFullDiagMode() && this.mirror.swarm)`. The gate
    // must cover THIS probe site, not a prior one.
    const beforeProbe = src.slice(0, probeIdx);
    const lastGateIdx = beforeProbe.lastIndexOf('isFullDiagMode()');
    expect(lastGateIdx, 'ramming_probe block must be gated on isFullDiagMode() — see capture ilhqk6 for the lag regression this prevents').toBeGreaterThan(-1);

    // Sanity: the gate must be within ~1500 chars before the call (i.e.
    // it's the enclosing block, not a far-away gate guarding something
    // else). The probe block is ~30 lines of object literal so ~1000-1500
    // chars between gate-open and logEvent call is the expected window.
    const distance = probeIdx - lastGateIdx;
    expect(distance, 'isFullDiagMode() gate is too far from ramming_probe site — likely gating something else').toBeLessThan(2000);
  });
});
