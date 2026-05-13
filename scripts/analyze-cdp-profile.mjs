#!/usr/bin/env node
// Reads a CDP Profiler.stop dump and prints the top self-time functions.
// Usage: node scripts/analyze-cdp-profile.mjs diag/drawer-lag-trace/cdp-perf.json
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: analyze-cdp-profile.mjs <cdp-perf.json>');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(path, 'utf8'));
const profile = dump.profile;
const { nodes, samples, timeDeltas, startTime } = profile;

// Build a nodeId → node map for O(1) lookup.
const byId = new Map(nodes.map((n) => [n.id, n]));

// Sum self-time per node (us). The CDP profile pairs `samples` (a list of
// nodeIds) with `timeDeltas` (microseconds between samples). Each sample's
// time-delta is attributed to the sample's leaf node.
const selfUs = new Map();
const totalUs = new Map();
let cumulative = 0;
for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const delta = timeDeltas[i] ?? 0;
  cumulative += delta;
  selfUs.set(leafId, (selfUs.get(leafId) ?? 0) + delta);
  // Walk the call stack to sum total time per node (function + descendants).
  let cur = byId.get(leafId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    totalUs.set(cur.id, (totalUs.get(cur.id) ?? 0) + delta);
    cur = cur.parent !== undefined ? byId.get(cur.parent) : null;
  }
}

// Print top N by self-time and by total-time.
const formatCaller = (n) => {
  const cf = n.callFrame ?? {};
  const fn = cf.functionName || '(anonymous)';
  const url = cf.url || '';
  const short = url.split('/').slice(-2).join('/');
  return `${fn}  ${short}:${cf.lineNumber}:${cf.columnNumber}`;
};

const sortedSelf = [...selfUs.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25);
const sortedTotal = [...totalUs.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25);

console.log(`\nTotal sampled time: ${(cumulative / 1000).toFixed(1)} ms`);
console.log(`\n=== TOP 25 BY SELF TIME (leaf-attributed) ===`);
for (const [id, us] of sortedSelf) {
  const n = byId.get(id);
  const pct = (us / cumulative) * 100;
  console.log(`${(us / 1000).toFixed(1).padStart(8)} ms  ${pct.toFixed(1).padStart(5)}%  ${formatCaller(n)}`);
}

console.log(`\n=== TOP 25 BY TOTAL TIME (self + descendants) ===`);
for (const [id, us] of sortedTotal) {
  const n = byId.get(id);
  const pct = (us / cumulative) * 100;
  console.log(`${(us / 1000).toFixed(1).padStart(8)} ms  ${pct.toFixed(1).padStart(5)}%  ${formatCaller(n)}`);
}
