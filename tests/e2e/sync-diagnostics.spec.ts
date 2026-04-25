/**
 * Self-contained sync diagnostic test.
 *
 * Runs three phases (idle → W-thrust → release), samples PredictionStats and
 * __eqxLogs throughout, fetches server-side events, then writes a structured
 * JSON report to a fixed path so Claude can read it without human involvement.
 *
 * Run with:
 *   pnpm e2e --project=chromium --reporter=list tests/e2e/sync-diagnostics.spec.ts
 *
 * Report written to:
 *   test-results/sync-diagnostics/report.json
 */
import { test, expect } from './fixtures/test-with-logs';
import type { LogEntry } from './fixtures/test-with-logs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PredictionStats } from '../../src/client/net/ColyseusClient';

const REPORT_DIR = join(process.cwd(), 'test-results', 'sync-diagnostics');
const REPORT_PATH = join(REPORT_DIR, 'report.json');

interface Sample {
  t: number;
  ackedTick: number;
  inputTick: number;
  ticksAhead: number;
  serverTick: number;
  rttMs: number;
  driftUnits: number;
  corrections: number;
  snaps: number;
  corrRate: number;
}

function statsToSample(stats: PredictionStats, t: number): Sample {
  const snaps = stats.snapshotCount;
  const corrections = stats.significantCorrectionCount;
  return {
    t,
    ackedTick: stats.lastAckedTick,
    inputTick: stats.lastAckedTick + stats.ticksAhead,
    ticksAhead: stats.ticksAhead,
    serverTick: stats.lastServerTick,
    rttMs: stats.rttMs,
    driftUnits: stats.driftUnits,
    corrections,
    snaps,
    corrRate: snaps > 0 ? corrections / snaps : 0,
  };
}

function splitLogs(logs: LogEntry[]): { snapshots: LogEntry[]; corrections: LogEntry[] } {
  return {
    snapshots: logs.filter((l) => l.tag === 'snapshot'),
    corrections: logs.filter((l) => l.tag === 'correction'),
  };
}

test('sync-diagnostics: idle → W-thrust → release', async ({
  eqxPage,
  getPredStats,
  getEqxLogs,
  clearEqxLogs,
}, testInfo) => {
  const runAt = new Date().toISOString();
  const phaseStart = (base: number): number => Date.now() - base;

  // Phase 0 — stabilise (1.5 s, no input, let initial snapshots arrive)
  await eqxPage.waitForTimeout(1500);
  await clearEqxLogs();

  // Phase 1 — idle baseline (2 s, 8 samples × 250 ms)
  const idlePhase: Sample[] = [];
  const idleBase = Date.now();
  for (let i = 0; i < 8; i++) {
    await eqxPage.waitForTimeout(250);
    idlePhase.push(statsToSample(await getPredStats(), phaseStart(idleBase)));
  }
  const idleLogs = splitLogs(await getEqxLogs());
  await clearEqxLogs();

  // Phase 2 — W-thrust (3 s, 24 samples × 125 ms)
  await eqxPage.keyboard.down('w');
  const thrustPhase: Sample[] = [];
  const thrustBase = Date.now();
  for (let i = 0; i < 24; i++) {
    await eqxPage.waitForTimeout(125);
    thrustPhase.push(statsToSample(await getPredStats(), phaseStart(thrustBase)));
  }
  await eqxPage.keyboard.up('w');
  const thrustLogs = splitLogs(await getEqxLogs());
  await clearEqxLogs();

  // Phase 3 — release / decay (2 s, 8 samples × 250 ms)
  const releasePhase: Sample[] = [];
  const releaseBase = Date.now();
  for (let i = 0; i < 8; i++) {
    await eqxPage.waitForTimeout(250);
    releasePhase.push(statsToSample(await getPredStats(), phaseStart(releaseBase)));
  }
  const releaseLogs = splitLogs(await getEqxLogs());

  // Fetch server events
  let serverEvents: unknown = null;
  try {
    serverEvents = await eqxPage.evaluate(async () => {
      const r = await fetch('http://localhost:2567/dev/events?limit=200');
      return r.json() as unknown;
    });
  } catch (e) {
    serverEvents = { error: String(e) };
  }

  // Compute summary — answers the four diagnostic questions at a glance.
  const thrustFirst = thrustPhase[0];
  const thrustLast = thrustPhase[thrustPhase.length - 1]!;
  const firstCorrEntry = thrustLogs.corrections[0];
  const maxTicksAhead = Math.max(...thrustPhase.map((s) => s.ticksAhead));
  const idleSnapsInWindow = (idlePhase[idlePhase.length - 1]!.snaps) - (idlePhase[0]!.snaps);
  const idleCorrsInWindow = (idlePhase[idlePhase.length - 1]!.corrections) - (idlePhase[0]!.corrections);
  const thrustSnapsInWindow = thrustLast.snaps - (thrustFirst?.snaps ?? 0);
  const thrustCorrsInWindow = thrustLast.corrections - (thrustFirst?.corrections ?? 0);

  const summary = {
    // Correction rates
    idleCorrRate: idleSnapsInWindow > 0 ? idleCorrsInWindow / idleSnapsInWindow : 0,
    thrustCorrRate: thrustSnapsInWindow > 0 ? thrustCorrsInWindow / thrustSnapsInWindow : 0,
    // ackedTick progression — key indicator of whether SLOT_APPLIED_TICK_OFF works.
    // If these are equal (both ~0) the SAB applied-tick write is broken.
    ackedTickAtThrustStart: thrustFirst?.ackedTick ?? -1,
    ackedTickAtThrustEnd: thrustLast.ackedTick,
    ackedTickAdvanced: (thrustLast.ackedTick - (thrustFirst?.ackedTick ?? 0)) > 0,
    // ticksAhead — if > 10 the replay window is unusually large; > 128 causes buffer overflow
    maxTicksAhead,
    ticksAheadOverflow: maxTicksAhead > 128,
    // First correction detail
    firstCorrection_ackedTick: firstCorrEntry
      ? (firstCorrEntry.data['ackedTick'] as number | undefined) ?? null
      : null,
    firstCorrection_ticksAhead: firstCorrEntry
      ? (firstCorrEntry.data['ticksAhead'] as number | undefined) ?? null
      : null,
    firstCorrection_serverTick: firstCorrEntry
      ? (firstCorrEntry.data['serverTick'] as number | undefined) ?? null
      : null,
    firstCorrection_drift: firstCorrEntry
      ? (firstCorrEntry.data['driftUnits'] as number | undefined) ?? null
      : null,
    firstCorrection_serverX: firstCorrEntry
      ? (firstCorrEntry.data['serverX'] as number | undefined) ?? null
      : null,
    firstCorrection_beforeX: firstCorrEntry
      ? (firstCorrEntry.data['beforeX'] as number | undefined) ?? null
      : null,
    firstCorrection_afterX: firstCorrEntry
      ? (firstCorrEntry.data['afterX'] as number | undefined) ?? null
      : null,
    // Verdict hint
    verdict:
      maxTicksAhead > 128
        ? 'BUFFER_OVERFLOW: ackedTick stuck, replay window > 128, buffer entries overwritten'
        : maxTicksAhead > 10
        ? 'LARGE_WINDOW: ticksAhead unusually high, check SLOT_APPLIED_TICK_OFF'
        : thrustCorrsInWindow / Math.max(1, thrustSnapsInWindow) > 0.05
        ? 'DETERMINISM: ticksAhead normal but drift persists — server/client simulate differently'
        : 'HEALTHY: correction rate < 5% during thrust',
  };

  const report = {
    runAt,
    summary,
    idlePhase,
    thrustPhase,
    releasePhase,
    idleLogs,
    thrustLogs,
    releaseLogs,
    serverEvents,
  };

  // Write report to a fixed path Claude can Read.
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  await testInfo.attach('sync-diagnostic-report', { path: REPORT_PATH });

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║           SYNC DIAGNOSTIC SUMMARY            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║ Idle correction rate:    ${(summary.idleCorrRate * 100).toFixed(1).padStart(6)}%              ║`);
  console.log(`║ Thrust correction rate:  ${(summary.thrustCorrRate * 100).toFixed(1).padStart(6)}%              ║`);
  console.log(`║ ackedTick start→end:     ${String(summary.ackedTickAtThrustStart).padStart(5)}→${String(summary.ackedTickAtThrustEnd).padEnd(5)}          ║`);
  console.log(`║ ackedTick advanced:      ${summary.ackedTickAdvanced ? 'YES' : 'NO ← PROBLEM'}                   ║`);
  console.log(`║ max ticksAhead:          ${String(summary.maxTicksAhead).padStart(5)}  ${summary.ticksAheadOverflow ? '← OVERFLOW!' : ''}           ║`);
  console.log(`║ Verdict: ${summary.verdict.slice(0, 38).padEnd(38)} ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║ Report: ${REPORT_PATH.slice(-38).padEnd(38)} ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  // Minimal gate: must have received enough snapshots to be meaningful.
  expect(thrustLast.snaps, 'must have received > 5 snapshots during test').toBeGreaterThan(5);
});
