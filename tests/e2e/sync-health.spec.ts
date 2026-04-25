/**
 * Sync-health regression suite.
 *
 * These tests assert that the correction rate stays below a bound under specific
 * input conditions. They are the canary for the two fixes described in
 * docs/LESSONS.md:
 *   Fix 1 — rAF fixed-timestep accumulator (stops client running at ~70 Hz vs server 60 Hz)
 *   Fix 2 — FIFO input queue in the physics worker (stops ackedTick jumping ahead of serverTick)
 *
 * Run with --reporter=list to see the console output inline.
 */
import { test, expect } from './fixtures/test-with-logs';

// ---------------------------------------------------------------------------
// Thrust correction rate
// ---------------------------------------------------------------------------
test('W-thrust: correction rate stays under 40% after 3 s continuous thrust', async ({
  eqxPage,
  getPredStats,
  clearEqxLogs,
  getEqxLogs,
}) => {
  // Let the connection stabilise.
  await eqxPage.waitForTimeout(1500);

  // Snapshot stats *before* the thrust window so we can compute a delta that
  // covers only the thrust period (mirrors how the idle test works).
  const statsBefore = await getPredStats();
  await clearEqxLogs();

  await eqxPage.keyboard.down('w');
  await eqxPage.waitForTimeout(3000);
  await eqxPage.keyboard.up('w');
  // Let the final snapshot(s) arrive after releasing the key.
  await eqxPage.waitForTimeout(500);

  const stats = await getPredStats();
  const logs = await getEqxLogs();

  const deltaSnaps = stats.snapshotCount - statsBefore.snapshotCount;
  const deltaCorrections = stats.significantCorrectionCount - statsBefore.significantCorrectionCount;
  const corrRate = deltaSnaps > 0 ? deltaCorrections / deltaSnaps : 1;

  const corrections = logs.filter((l) => l.tag === 'correction');
  const t0 = logs[0]?.ts ?? 0;

  console.log('\n=== W-thrust sync health ===');
  console.log(`Snapshots (window): ${deltaSnaps}`);
  console.log(`Corrections:        ${deltaCorrections}  (${(corrRate * 100).toFixed(1)}%  — limit 40%)`);
  console.log(`Max drift:          ${stats.maxDriftUnits.toFixed(4)} u`);
  console.log(`Ticks ahead:        ${stats.ticksAhead}`);
  console.log(`RTT:                ${stats.rttMs} ms`);
  console.log(`Correction events:  ${corrections.length}`);
  for (const c of corrections.slice(0, 10)) {
    console.log(
      `  t+${(c.ts - t0).toFixed(0).padStart(5)}ms  drift=${String(c.data['driftUnits']).padStart(10)}  tick=${c.data['serverTick']}`,
    );
  }
  console.log('============================\n');

  // Must receive at least 10 snapshots in the thrust+release window.
  expect(deltaSnaps).toBeGreaterThan(10);

  // Collision corrections are expected when the ship encounters an asteroid during
  // the thrust window (client predicts the collision ~18 ticks before the server
  // resolves it; the reconciler corrects once when the server snapshot arrives).
  // The 40% threshold distinguishes the fixed system (~20-28% from collision events)
  // from the pre-fix regression bugs:
  //   - setInterval at 70 Hz + overwrite-latest input model: ~93% corrections
  //   - rAF-fixed + overwrite-latest:                        ~59% corrections
  // If this regression to >40%, re-run sync-diagnostics.spec.ts to isolate.
  expect(corrRate).toBeLessThan(0.40);

  // ticksAhead should stay bounded (~18-20 for ~300 ms RTT). A runaway
  // input queue (regression to overwrite-latest model) would push this to 100+.
  expect(stats.ticksAhead).toBeLessThan(30);
});

// ---------------------------------------------------------------------------
// Idle correction rate (guard: regression back to variable-dt)
// ---------------------------------------------------------------------------
test('idle: correction rate stays near-zero with no inputs', async ({
  eqxPage,
  getPredStats,
}) => {
  // 3 s idle after connection stabilises.
  await eqxPage.waitForTimeout(500);
  const before = await getPredStats();
  await eqxPage.waitForTimeout(3000);
  const after = await getPredStats();

  const newSnaps = after.snapshotCount - before.snapshotCount;
  const newCorrections = after.significantCorrectionCount - before.significantCorrectionCount;
  const rate = newSnaps > 0 ? newCorrections / newSnaps : 0;

  console.log('\n=== Idle correction rate ===');
  console.log(`Snapshots (window): ${newSnaps}`);
  console.log(`Corrections:        ${newCorrections}  (${(rate * 100).toFixed(1)}%)`);
  console.log(`Max drift:          ${after.maxDriftUnits.toFixed(4)} u`);
  console.log('============================\n');

  expect(newSnaps).toBeGreaterThan(10);
  expect(rate).toBeLessThan(0.05);
});
