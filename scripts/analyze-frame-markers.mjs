#!/usr/bin/env node
/**
 * F1 analyzer — attribute per-frame warp-spool cost from a diagnostic
 * capture. Companion to the F1 instrumentation in
 * `docs/HANDOFF-warp-spool-perf-followup.md`. NOT the same as
 * `analyze-cdp-profile.mjs` (that reads a V8 `.cpuprofile`); this reads
 * the NDJSON the diag route writes.
 *
 * Usage:
 *   node scripts/analyze-frame-markers.mjs <captureDir> \
 *     [--spool=<startTs>,<endTs>] [--boundary=<ts1,ts2,...>]
 *
 * Reads `<captureDir>/perf.ndjson` (the 5 F1 marker tags + `raf_gap`
 * land here — see `src/server/routes/diagRouter.ts` BUCKETS) and, if
 * present, `<captureDir>/raf.ndjson` (where `rafTick` lands). Each line
 * is one `{ source, ts, tag, data }` RoutedEntry (see diagRouter
 * `asEntry`). `ts` is the client `performance.now()` for client rows.
 *
 * For each of the 5 marker tags it prints mean / p50 / p95 / max of the
 * relevant ms field, computed SEPARATELY for two windows:
 *   (a) WITHIN the spool window      — steady fullscreen-filter cost
 *   (b) AT the transit boundary      — the room-swap handoff stalls
 * plus, per window, a residual:
 *   residual = mean(frame elapsedMs) − Σ(marker means)
 * i.e. the unattributed time (GPU paint / compositor / other) — what
 * the markers do NOT explain.
 *
 * Window defaults are CAPTURE-SPECIFIC (the handoff cites diag
 * `2026-05-15T22-08-40-272Z-s3b9l8`): spool client `ts` 16895–20492;
 * boundary raf_gaps at ts 20321, 20532, 20869, 25961. They are
 * overridable because they only apply to that one capture — pass
 * `--spool` / `--boundary` for any other.
 *
 * Pure + dependency-free. The aggregation helpers are exported so
 * `tests/unit/analyze-frame-markers.test.ts` can assert the math on
 * synthetic lines without touching the filesystem.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---- Capture-specific defaults (see docstring; override via CLI). ----
export const DEFAULT_SPOOL = { start: 16895, end: 20492 };
export const DEFAULT_BOUNDARY_TS = [20321, 20532, 20869, 25961];
/**
 * Half-width (ms) of the window placed around each boundary timestamp.
 * A `raf_gap` is logged AFTER the long frame, so the cost straddles the
 * stamped ts; ±150 ms comfortably brackets the 116–183 ms gaps the
 * handoff cites without bleeding into steady spool frames.
 */
export const BOUNDARY_HALF_WIDTH_MS = 150;

/**
 * Marker tag → the numeric field on `data` that is the per-frame cost
 * (ms) for that marker. `grid_update` is special-cased in
 * `gridTotalMs` (it splits into three sub-fields).
 */
export const MARKER_MS_FIELD = {
  renderer_update: 'totalMs',
  warp_tick: 'totalMs',
  mirror_rebuild: 'totalMs',
  mirror_clone: 'costMs',
};

/** The 5 marker tags, in report order. */
export const MARKER_TAGS = [
  'renderer_update',
  'warp_tick',
  'grid_update',
  'mirror_rebuild',
  'mirror_clone',
];

/** Total per-frame grid cost = spec + text-create + cleanup. */
export function gridTotalMs(data) {
  const spec = Number(data?.labelSpecMs ?? 0);
  const create = Number(data?.textCreateMs ?? 0);
  const cleanup = Number(data?.cleanupMs ?? 0);
  return spec + create + cleanup;
}

/**
 * Extract the per-frame cost (ms) for a given marker tag from its
 * `data` object. Returns `NaN` if the expected field is absent/non-
 * numeric so callers can drop malformed rows.
 */
export function markerMs(tag, data) {
  if (tag === 'grid_update') return gridTotalMs(data);
  const field = MARKER_MS_FIELD[tag];
  if (!field) return NaN;
  const v = Number(data?.[field]);
  return Number.isFinite(v) ? v : NaN;
}

/** Parse NDJSON text into RoutedEntry objects, skipping blank/bad lines. */
export function parseNdjson(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // tolerate a truncated trailing line
    }
    if (obj && typeof obj === 'object' && typeof obj.tag === 'string' && typeof obj.ts === 'number') {
      out.push(obj);
    }
  }
  return out;
}

/** Sorted-copy quantile (linear interpolation). `q` in [0,1]. */
export function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** mean / p50 / p95 / max / count over a numeric sample. */
export function stats(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return { count: 0, mean: NaN, p50: NaN, p95: NaN, max: NaN };
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length,
    mean: sum / xs.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

/** True if `ts` is inside [spool.start, spool.end] (inclusive). */
export function inSpool(ts, spool) {
  return ts >= spool.start && ts <= spool.end;
}

/** True if `ts` is within `halfWidth` of ANY boundary timestamp. */
export function inBoundary(ts, boundaryTsList, halfWidth) {
  for (const b of boundaryTsList) {
    if (Math.abs(ts - b) <= halfWidth) return true;
  }
  return false;
}

/**
 * Core aggregation (pure — unit-tested). Given parsed entries + the two
 * window definitions, returns per-window per-marker stats and the
 * residual. `frameTags` is the set of tags whose `data.elapsedMs` is a
 * whole-frame wall-clock sample (rafTick + raf_gap).
 */
export function aggregate(entries, opts) {
  const {
    spool,
    boundaryTs,
    boundaryHalfWidth = BOUNDARY_HALF_WIDTH_MS,
    frameTags = ['rafTick', 'raf_gap'],
  } = opts;

  const makeWindow = () => {
    const byMarker = {};
    for (const tag of MARKER_TAGS) byMarker[tag] = [];
    return { byMarker, frameElapsed: [] };
  };
  const windows = { spool: makeWindow(), boundary: makeWindow() };
  const frameTagSet = new Set(frameTags);

  for (const e of entries) {
    const isSpool = inSpool(e.ts, spool);
    const isBoundary = inBoundary(e.ts, boundaryTs, boundaryHalfWidth);
    if (!isSpool && !isBoundary) continue;

    if (MARKER_TAGS.includes(e.tag)) {
      const ms = markerMs(e.tag, e.data);
      if (Number.isFinite(ms)) {
        if (isSpool) windows.spool.byMarker[e.tag].push(ms);
        if (isBoundary) windows.boundary.byMarker[e.tag].push(ms);
      }
    } else if (frameTagSet.has(e.tag)) {
      const el = Number(e.data?.elapsedMs);
      if (Number.isFinite(el)) {
        if (isSpool) windows.spool.frameElapsed.push(el);
        if (isBoundary) windows.boundary.frameElapsed.push(el);
      }
    }
  }

  const summarise = (w) => {
    const markers = {};
    let sumMeans = 0;
    for (const tag of MARKER_TAGS) {
      const st = stats(w.byMarker[tag]);
      markers[tag] = st;
      if (Number.isFinite(st.mean)) sumMeans += st.mean;
    }
    const frame = stats(w.frameElapsed);
    const residualMs = Number.isFinite(frame.mean) ? frame.mean - sumMeans : NaN;
    return { markers, frame, sumMarkerMeans: sumMeans, residualMs };
  };

  return { spool: summarise(windows.spool), boundary: summarise(windows.boundary) };
}

// ---------------------------------------------------------------------
// CLI (skipped when imported by the unit test).
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dir: null, spool: { ...DEFAULT_SPOOL }, boundaryTs: [...DEFAULT_BOUNDARY_TS] };
  for (const a of argv) {
    if (a.startsWith('--spool=')) {
      const [s, e] = a.slice('--spool='.length).split(',').map(Number);
      if (Number.isFinite(s) && Number.isFinite(e)) out.spool = { start: s, end: e };
    } else if (a.startsWith('--boundary=')) {
      const list = a.slice('--boundary='.length).split(',').map(Number).filter(Number.isFinite);
      if (list.length > 0) out.boundaryTs = list;
    } else if (!a.startsWith('--') && out.dir === null) {
      out.dir = a;
    }
  }
  return out;
}

function fmt(n, w = 8) {
  return (Number.isFinite(n) ? n.toFixed(3) : '   n/a').padStart(w);
}

function printWindow(label, w) {
  console.log(`\n=== ${label} ===`);
  console.log(
    `${'marker'.padEnd(16)} ${'n'.padStart(6)} ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}  (ms)`,
  );
  for (const tag of MARKER_TAGS) {
    const s = w.markers[tag];
    console.log(
      `${tag.padEnd(16)} ${String(s.count).padStart(6)} ${fmt(s.mean)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)}`,
    );
  }
  console.log(
    `${'FRAME elapsedMs'.padEnd(16)} ${String(w.frame.count).padStart(6)} ${fmt(w.frame.mean)} ${fmt(w.frame.p50)} ${fmt(w.frame.p95)} ${fmt(w.frame.max)}`,
  );
  console.log(
    `Σ(marker means) = ${fmt(w.sumMarkerMeans).trim()} ms   ` +
      `residual (frame − Σ, ⇒ GPU/other) = ${fmt(w.residualMs).trim()} ms`,
  );
}

function main() {
  const { dir, spool, boundaryTs } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error(
      'usage: analyze-frame-markers.mjs <captureDir> [--spool=<startTs>,<endTs>] [--boundary=<ts1,ts2,...>]',
    );
    process.exit(1);
  }

  const perfPath = join(dir, 'perf.ndjson');
  if (!existsSync(perfPath)) {
    console.error(`no perf.ndjson in ${dir} — is this a capture dir? (markers need ?diag=1 / WebDriver)`);
    process.exit(1);
  }
  const entries = parseNdjson(readFileSync(perfPath, 'utf8'));
  const rafPath = join(dir, 'raf.ndjson');
  if (existsSync(rafPath)) {
    entries.push(...parseNdjson(readFileSync(rafPath, 'utf8')));
  }

  const result = aggregate(entries, { spool, boundaryTs });

  console.log(`\nF1 frame-marker attribution — ${dir}`);
  console.log(`spool window: ts ${spool.start}–${spool.end}`);
  console.log(`boundary ts:  ${boundaryTs.join(', ')}  (±${BOUNDARY_HALF_WIDTH_MS} ms)`);
  console.log(`parsed ${entries.length} perf/raf rows`);
  printWindow('SPOOL WINDOW (steady fullscreen-filter cost)', result.spool);
  printWindow('TRANSIT BOUNDARY (room-swap handoff stalls)', result.boundary);
  console.log(
    '\nReading: a large residual ⇒ the cost is GPU/compositor (filter pass), ' +
      'NOT the instrumented CPU work; a marker dominating its window ⇒ that ' +
      'is the data-indicted cost to fix in F3.',
  );
}

// Only run the CLI when executed directly, not when imported by tests.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
