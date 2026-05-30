/**
 * Structural regression lock for the ramming-probe alloc gate.
 *
 * History:
 * - 2026-05-28 (capture ilhqk6): block added unconditionally; ran every
 *   frame while within 1500u of any drone and built a ~12-field object
 *   literal — dominant client allocator (~55/s sustained in the capture).
 * - 2026-05-28 (commit b7b18d1): gated on `isFullDiagMode()` — closed
 *   the production hole.
 * - 2026-05-29 (plan: lazy-mochi, capture-driven by combat-heap-growth):
 *   the `isFullDiagMode()` gate STILL fires under Playwright/webdriver,
 *   which auto-enables diag. With the combat-heap-growth gate running
 *   on `feel-test-25` (25 drones, all within 1500u), the probe block
 *   was the dominant allocator in the CDP profile (updateMirror went
 *   from 4.6% on main to 15.1% on HEAD, a +172% share jump) and the
 *   primary contributor to the rafGap regression (1 → 15 events / 20s).
 *   Tightened to `isRammingProbeEnabled()` — opt-in via `?probe=ram`,
 *   NO webdriver auto-enable. The ramming-probe-armpit E2E sets the
 *   flag explicitly; no other E2E now pays the cost.
 *
 * This test is structural (greps the source) because the probe lives
 * deep inside a private `updateMirror` path that's expensive to harness.
 * Future PR that drops or loosens the gate fails here with a clear
 * message before any device smoke would surface the lag-regression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLYSEUS_CLIENT = join(__dirname, '..', '..', 'src', 'client', 'net', 'ColyseusClient.ts');

describe('ColyseusClient — ramming-probe alloc gate (captures ilhqk6 + lazy-mochi)', () => {
  it('the ramming_probe block is gated on isRammingProbeEnabled() (NOT isFullDiagMode — webdriver auto-on confounded the heap gate)', () => {
    const src = readFileSync(COLYSEUS_CLIENT, 'utf-8');
    const probeIdx = src.indexOf("logEvent('ramming_probe'");
    expect(probeIdx, 'ramming_probe logEvent call should exist (gated)').toBeGreaterThan(-1);

    // Walk backwards to find the nearest enclosing `isRammingProbeEnabled()`
    // call — accepts both plain `if (isRammingProbeEnabled())` and compound
    // gates like `if (isRammingProbeEnabled() && this.mirror.swarm)`. The
    // gate must cover THIS probe site, not a prior one.
    const beforeProbe = src.slice(0, probeIdx);
    const lastGateIdx = beforeProbe.lastIndexOf('isRammingProbeEnabled()');
    expect(
      lastGateIdx,
      'ramming_probe block must be gated on isRammingProbeEnabled() — opt-in via ?probe=ram only; capture ilhqk6 + plan lazy-mochi for why isFullDiagMode is too loose',
    ).toBeGreaterThan(-1);

    // Sanity: the gate must be within ~2000 chars before the call (i.e.
    // it's the enclosing block, not a far-away gate guarding something
    // else). The probe block is ~30 lines of object literal so ~1000-1500
    // chars between gate-open and logEvent call is the expected window.
    const distance = probeIdx - lastGateIdx;
    expect(distance, 'isRammingProbeEnabled() gate is too far from ramming_probe site — likely gating something else').toBeLessThan(2000);

    // Anti-regression: assert the OLD looser gate (isFullDiagMode) does
    // not enclose this block. Future PRs that swap back to the looser
    // gate would re-introduce the heap-gate confound.
    const lastFullDiagIdx = beforeProbe.lastIndexOf('isFullDiagMode()');
    if (lastFullDiagIdx > -1) {
      expect(
        lastFullDiagIdx,
        'a looser isFullDiagMode() gate appears closer to the ramming_probe site than isRammingProbeEnabled() — combat-heap-growth gate measurement will fall apart again',
      ).toBeLessThan(lastGateIdx);
    }
  });
});
