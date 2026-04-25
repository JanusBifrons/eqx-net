/**
 * Rotate-only jitter probe: hold D for 3 seconds, then dump the full
 * correction log and predStats. Prints to console — read the output, don't
 * just trust the assertions.
 */
import { test, expect } from './fixtures/test-with-logs';

test('rotate-only: hold D for 3 s and dump stats + correction log', async ({
  eqxPage,
  getPredStats,
  getEqxLogs,
  clearEqxLogs,
}) => {
  // Let the connection stabilise and clear the log buffer so we only capture
  // the rotate-only window.
  await eqxPage.waitForTimeout(1000);
  await clearEqxLogs();

  await eqxPage.keyboard.down('d');
  await eqxPage.waitForTimeout(3000);
  await eqxPage.keyboard.up('d');
  await eqxPage.waitForTimeout(500);

  const stats = await getPredStats();
  const logs = await getEqxLogs();

  const corrRate = stats.snapshotCount > 0
    ? (stats.significantCorrectionCount / stats.snapshotCount) * 100
    : 0;
  const angleCorrRate = stats.snapshotCount > 0
    ? (stats.significantAngleCorrectionCount / stats.snapshotCount) * 100
    : 0;

  console.log('\n=== Rotate-only (D held, 3 s) ===');
  console.log(`Snapshots:          ${stats.snapshotCount}`);
  console.log(`Pos corrections:    ${stats.significantCorrectionCount} (${corrRate.toFixed(1)}%)`);
  console.log(`Angle corrections:  ${stats.significantAngleCorrectionCount} (${angleCorrRate.toFixed(1)}%)`);
  console.log(`Max pos drift:      ${stats.maxDriftUnits.toFixed(4)} u`);
  console.log(`Mean pos drift:     ${(stats.totalDriftUnits / Math.max(1, stats.snapshotCount)).toFixed(4)} u`);
  console.log(`Last pos drift:     ${stats.driftUnits.toFixed(4)} u`);
  console.log(`Max angle drift:    ${stats.maxAngleDriftRad.toFixed(6)} rad  (${(stats.maxAngleDriftRad * 180 / Math.PI).toFixed(3)}°)`);
  console.log(`Mean angle drift:   ${(stats.totalAngleDriftRad / Math.max(1, stats.snapshotCount)).toFixed(6)} rad`);
  console.log(`Last angle drift:   ${stats.angleDriftRad.toFixed(6)} rad`);
  console.log(`Ticks ahead:        ${stats.ticksAhead}`);
  console.log(`RTT:                ${stats.rttMs} ms`);
  console.log(`Lerping now:        ${stats.lerping}`);
  console.log('----------------------------------');

  const t0 = logs[0]?.ts ?? 0;
  const corrections = logs.filter((l) => l.tag === 'correction');
  console.log(`Total log entries:  ${logs.length}`);
  console.log(`Correction events:  ${corrections.length}`);
  for (const c of corrections.slice(0, 10)) {
    console.log(
      `  t+${(c.ts - t0).toFixed(0).padStart(5)}ms  drift=${String(c.data['driftUnits']).padStart(10)}  angleDrift=${String(c.data['angleDriftRad']).padStart(10)} rad  serverTick=${c.data['serverTick']}`,
    );
  }

  const snapshots = logs.filter((l) => l.tag === 'snapshot');
  console.log(`\nSnapshot samples (first 5 and last 3 of ${snapshots.length}):`);
  for (const s of [...snapshots.slice(0, 5), ...snapshots.slice(-3)]) {
    console.log(
      `  t+${(s.ts - t0).toFixed(0).padStart(5)}ms  tick=${s.data['serverTick']}  acked=${s.data['ackedTick']}  ahead=${s.data['ticksAhead']}  drift=${s.data['driftUnits']}  angleDrift=${s.data['angleDriftRad']} rad  interval=${s.data['intervalMs']}ms`,
    );
  }
  console.log('==================================\n');

  // At least a minimal set of snapshots must have arrived.
  expect(stats.snapshotCount).toBeGreaterThan(10);
});
