#!/usr/bin/env node
/**
 * Phase 0.3 falsifier (plan: perf-floor session 3) — print the
 * `intervalMs` distribution of three on-device captures side-by-side.
 * Disambiguates: jittered-network arrivals (proxy needed for repro)
 * vs CPU-bound decode (proxy is the wrong tool, CDP alone reproduces).
 *
 *   - If ers7xy clusters at 50ms with a tail to 200ms → NETWORK
 *   - If ers7xy clusters uniformly at 80-120ms with no <50ms entries → CPU
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CAPS = [
  ['9hj9sl', '2026-05-20T21-17-52-438Z-9hj9sl'],
  ['vg9hon', '2026-05-20T22-37-34-348Z-vg9hon'],
  ['ers7xy', '2026-05-20T22-47-58-606Z-ers7xy'],
];

function loadIntervals(dirName) {
  const path = join(ROOT, 'diag', 'captures', dirName, 'snapshots.ndjson');
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const xs = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      const iv = rec?.data?.intervalMs;
      if (typeof iv === 'number' && iv > 0) xs.push(iv);
    } catch {
      // skip
    }
  }
  return xs;
}

function pctile(xs, p) {
  if (xs.length === 0) return NaN;
  const i = Math.min(xs.length - 1, Math.floor(p * xs.length));
  return xs[i];
}

function histogram(xs, bins) {
  const counts = new Array(bins.length - 1).fill(0);
  for (const x of xs) {
    for (let b = 0; b < bins.length - 1; b++) {
      if (x >= bins[b] && x < bins[b + 1]) {
        counts[b]++;
        break;
      }
    }
  }
  return counts;
}

const BUCKETS = [0, 20, 35, 50, 75, 100, 125, 150, 200, 300, 1000];

console.log('=== snapshotIntervalMs distribution analysis ===\n');
for (const [label, dirName] of CAPS) {
  const xs = loadIntervals(dirName).sort((a, b) => a - b);
  if (xs.length === 0) {
    console.log(`${label}: NO DATA\n`);
    continue;
  }
  const p25 = pctile(xs, 0.25);
  const p50 = pctile(xs, 0.5);
  const p75 = pctile(xs, 0.75);
  const p95 = pctile(xs, 0.95);
  const p99 = pctile(xs, 0.99);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / xs.length;
  const stddev = Math.sqrt(variance);
  const min = xs[0];
  const max = xs[xs.length - 1];
  console.log(`--- ${label} (n=${xs.length}) ---`);
  console.log(
    `  min=${min.toFixed(1)}  p25=${p25.toFixed(1)}  p50=${p50.toFixed(1)}  p75=${p75.toFixed(1)}  p95=${p95.toFixed(1)}  p99=${p99.toFixed(1)}  max=${max.toFixed(1)}`,
  );
  console.log(`  mean=${mean.toFixed(1)}  stddev=${stddev.toFixed(1)}`);
  const hist = histogram(xs, BUCKETS);
  const maxCount = Math.max(...hist, 1);
  console.log(`  bucket histogram:`);
  for (let i = 0; i < hist.length; i++) {
    const lo = BUCKETS[i];
    const hi = BUCKETS[i + 1];
    const count = hist[i];
    const pct = ((count / xs.length) * 100).toFixed(1);
    const barLen = Math.round((count / maxCount) * 40);
    const bar = '#'.repeat(barLen);
    console.log(
      `    [${String(lo).padStart(4)},${String(hi).padStart(4)}) n=${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`,
    );
  }
  // Shape verdict
  const sub50 = xs.filter((x) => x < 50).length;
  const between50and75 = xs.filter((x) => x >= 50 && x < 75).length;
  const between75and125 = xs.filter((x) => x >= 75 && x < 125).length;
  const above125 = xs.filter((x) => x >= 125).length;
  console.log(
    `  shape: <50ms=${((sub50 / xs.length) * 100).toFixed(0)}%  50-75ms=${((between50and75 / xs.length) * 100).toFixed(0)}%  75-125ms=${((between75and125 / xs.length) * 100).toFixed(0)}%  ≥125ms=${((above125 / xs.length) * 100).toFixed(0)}%`,
  );
  console.log();
}

console.log('=== Interpretation guide ===');
console.log(
  '  NETWORK-JITTER shape: ers7xy median ~50ms with a long tail (p95-p99) >150ms',
);
console.log(
  '  CPU-BOUND-DECODE shape: ers7xy mostly above 75ms with few entries <50ms',
);
