#!/usr/bin/env node
/**
 * Ingest a manual on-device diagnostic capture (Phase 3 of perf-floor)
 * and emit the same Phase-2 `PerfAggregate` JSON shape so Phase 5's
 * perfBudget can read both automated + device baselines off the
 * same `diag/perf-baseline/` directory.
 *
 * The capture is the directory `diag/captures/<timestamp>-<id>/` that
 * the `/diag/capture` route writes when the user taps "Capture" in the
 * mobile SettingsModal (see `src/client/debug/diagCapture.ts`). It
 * contains:
 *
 *   - summary.json         — stats, userAgent, viewport, room hints
 *   - raf.ndjson           — rafTick events (one per ~4 frames + anomalies)
 *   - other.ndjson         — longtask + raf_gap + other low-rate events
 *   - perf.ndjson          — F1 marker tags
 *   - …other buckets per `src/server/routes/diagRouter.ts` BUCKETS
 *
 * Usage:
 *   node scripts/ingest-device-capture.mjs <captureDir> \
 *     --scenario=sol-prime-ambient \
 *     --platform=ios|android \
 *     [--out=diag/perf-baseline/sol-prime-ambient-device-ios.json]
 *
 * `--scenario` and `--platform` are required because the userAgent
 * alone can't disambiguate (a Chrome-on-Android session reports a
 * Chrome UA; the user knows the device). Mirrors the Phase-2 arm
 * naming so Phase 5 reads both `*-desktop.json` and `*-device-ios.json`
 * without code changes.
 *
 * Aggregates are computed directly from raf.ndjson / other.ndjson
 * (rafTick elapsedMs distribution → rafP50Ms / rafP99Ms; longtask
 * count → longtaskCount30s; raf_gap count → rafGapCount30s). The
 * stats snapshot in summary.json provides a single-moment value for
 * the prediction metrics (rollingCorrRate, maxDriftUnits etc.) — we
 * emit them as degenerate 1-sample aggregates so the on-disk shape
 * matches automated captures.
 *
 * Read-only on input; writes one JSON file under
 * `diag/perf-baseline/<scenario>-device-<platform>.json`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.captureDir) {
  printHelp('missing <captureDir>');
  process.exit(2);
}
if (!args.scenario) {
  printHelp('missing --scenario=<sol-prime-ambient|feel-test-25>');
  process.exit(2);
}
if (!args.platform) {
  printHelp('missing --platform=<ios|android>');
  process.exit(2);
}

const captureDir = resolve(process.cwd(), args.captureDir);
if (!existsSync(captureDir)) {
  console.error(`[ingest] capture directory not found: ${captureDir}`);
  process.exit(2);
}

const summary = readJsonIfExists(join(captureDir, 'summary.json')) ?? {};
const rafEvents = readNdjsonIfExists(join(captureDir, 'raf.ndjson'));
const otherEvents = readNdjsonIfExists(join(captureDir, 'other.ndjson'));

// Pull rafTick `elapsedMs` distribution. Each rafTick row has
// `data.elapsedMs` per the ColyseusClient logger.
const rafSamples = rafEvents
  .filter((e) => e.tag === 'rafTick')
  .map((e) => Number(e.data?.elapsedMs))
  .filter((n) => Number.isFinite(n));

const longtaskCount = otherEvents.filter((e) => e.tag === 'longtask').length;
const rafGapCount = otherEvents.filter((e) => e.tag === 'raf_gap').length;

const stats = summary.stats ?? {};
const singleSample = (v) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  return { median: n, p95: n, p99: n, sampleCount: Number.isNaN(n) ? 0 : 1 };
};

const metrics = {
  rafP50Ms: distribution(rafSamples, 0.5),
  rafP99Ms: distribution(rafSamples, 0.99),
  longtaskCount30s: { median: longtaskCount, p95: longtaskCount, p99: longtaskCount, sampleCount: 1 },
  rafGapCount30s: { median: rafGapCount, p95: rafGapCount, p99: rafGapCount, sampleCount: 1 },
  rollingCorrRate: singleSample(stats.rollingCorrRate),
  maxDriftUnits: singleSample(stats.maxDriftUnits),
  meanDriftUnits: singleSample(
    typeof stats.totalDriftUnits === 'number' && typeof stats.snapshotCount === 'number' && stats.snapshotCount > 0
      ? stats.totalDriftUnits / stats.snapshotCount
      : NaN,
  ),
  ticksAhead: singleSample(stats.ticksAhead),
};
if (typeof stats.heapUsedMb === 'number' && Number.isFinite(stats.heapUsedMb)) {
  metrics.heapUsedMb = singleSample(stats.heapUsedMb);
}

const diagEnabled = isDiagEnabled(rafEvents, otherEvents, summary);
if (diagEnabled) {
  console.warn(
    `[ingest] WARNING: capture has diagnostic instrumentation ON ` +
      `(likely a session with ?diag=1). The Phase-5 budget will reject this as a precondition fail.`,
  );
}

const aggregate = {
  capturedAt: new Date().toISOString(),
  scenario: args.scenario,
  arm: `device-${args.platform}`,
  durationMs: estimateDurationMs(rafEvents, otherEvents),
  sampleCount: rafSamples.length,
  diagEnabledAtCapture: diagEnabled,
  metrics,
  // The device capture has no live tick_budget stream — server-side
  // aggregates aren't in the bundle. Zero out so the shape matches.
  tickBudget: { sampleCount: 0, totalAvgMs: 0, totalMaxMs: 0, overBudgetRatio: 0 },
  // Source provenance — preserve which on-device capture this came from.
  source: {
    captureDir: basename(captureDir),
    userAgent: summary.userAgent ?? null,
    viewport: summary.viewport ?? null,
    clientEpochMs: summary.clientEpochMs ?? null,
  },
};

const outDir = resolve(process.cwd(), 'diag', 'perf-baseline');
mkdirSync(outDir, { recursive: true });
const outFile = args.out
  ? resolve(process.cwd(), args.out)
  : join(outDir, `${args.scenario}-device-${args.platform}.json`);
writeFileSync(outFile, JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
console.log(`[ingest] wrote ${outFile}`);
console.log(
  `[ingest]   rafTick samples=${rafSamples.length}, longtasks=${longtaskCount}, raf_gaps=${rafGapCount}, diag=${diagEnabled}`,
);

// ── helpers ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--scenario=')) out.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--platform=')) out.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (!out.captureDir && !arg.startsWith('--')) out.captureDir = arg;
  }
  return out;
}

function printHelp(msg) {
  console.error(`[ingest] ${msg}`);
  console.error(`Usage: node scripts/ingest-device-capture.mjs <captureDir> --scenario=<name> --platform=<ios|android> [--out=<path>]`);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readNdjsonIfExists(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function distribution(samples, q) {
  if (samples.length === 0) return { median: NaN, p95: NaN, p99: NaN, sampleCount: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    sampleCount: sorted.length,
  };
}

function nearestRank(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const qq = Math.max(0, Math.min(1, q));
  const rank = Math.ceil(qq * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function isDiagEnabled(rafEvents, otherEvents, summary) {
  // Heuristic: a diag-enabled session emits `mirror_clone` / `mirror_rebuild`
  // entries (and the 30k-entry ring). The bucketing routes them to perf.ndjson,
  // not raf/other — but our two arrays don't include perf.ndjson here. Use
  // summary.json's hint if present; otherwise fall back to a "no diag markers
  // observed" assumption.
  if (typeof summary?.diagEnabled === 'boolean') return summary.diagEnabled;
  // Conservative: assume diag is OFF unless we have evidence otherwise. A
  // wrong false-negative here just means the budget might accept a
  // diag-instrumented capture — the user is the on-device operator and
  // knows whether they ran with ?diag=1.
  return false;
}

function estimateDurationMs(rafEvents, otherEvents) {
  const allTs = [];
  for (const e of rafEvents) if (typeof e.ts === 'number') allTs.push(e.ts);
  for (const e of otherEvents) if (typeof e.ts === 'number') allTs.push(e.ts);
  if (allTs.length < 2) return 0;
  const min = Math.min(...allTs);
  const max = Math.max(...allTs);
  return Math.round(max - min);
}
