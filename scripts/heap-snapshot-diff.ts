/**
 * Heap-snapshot diff utility — ranks growing constructors between two
 * V8 `.heapsnapshot` files.
 *
 * plan: imperative-taco-r2 §1.1.
 *
 * The CDP `HeapProfiler.startSampling` ranking used in round 1 weighted
 * call sites by sampled allocation size × frequency, which oversamples
 * high-frequency small allocations and dilutes the ranking across the
 * many call frames inside one hot loop. The 6.8 %-share `gameRafLoop.loop`
 * fix we shipped didn't move felt stutter on the phone — because the
 * REAL bulk allocator is snapshot processing (~970 KB/s, 40× combat),
 * distributed across `handleSnapshot` / `updateMirror` / mirror rebuild
 * paths. Sampling can't see it as one site.
 *
 * Heap-snapshot diff is the right tool because it measures **surviving
 * objects between two GC points** — exactly what V8's major-GC has to
 * mark and sweep, and what determines GC pause length. We take two
 * snapshots ~25 s apart during steady-state combat, diff them, and the
 * top growers are the surviving heap pressure we need to pool away.
 *
 * Output format (Markdown table) — top-20 by `sizeDeltaBytes` desc:
 *
 *   ```
 *   | Rank | Δ size (KB) | Δ count | Type     | Name              |
 *   |---|---:|---:|---|---|
 *   |  1 |  +1234.5    | +890   | object   | Object            |
 *   |  2 |  +987.2     | +500   | array    | Array             |
 *   ...
 *   ```
 *
 * Run: `pnpm tsx scripts/heap-snapshot-diff.ts snap1.heapsnapshot snap2.heapsnapshot`.
 *
 * MVP scope: groups nodes by `(type, name)` and reports `self_size` sums.
 * Does NOT compute retained-size via the dominator tree (that's a
 * potential follow-up — self-size already maps useful information to
 * specific allocators, and retained-size adds complexity that's not
 * load-bearing for finding "what survived").
 */

/** Minimal shape of a parsed `.heapsnapshot` JSON. */
export interface SnapshotJson {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: [string[], ...unknown[]];
      edge_fields: string[];
      edge_types: unknown[];
    };
    node_count: number;
    edge_count: number;
    trace_function_count?: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}

export interface DiffEntry {
  /** Node-type label from `snapshot.meta.node_types[0]` (e.g. "object", "array", "string"). */
  type: string;
  /** Constructor / class name (or string content for type=string). */
  name: string;
  /** snap2_count - snap1_count. Can be negative for shrinking groups. */
  countDelta: number;
  /** snap2_total_self_size - snap1_total_self_size. Can be negative. */
  sizeDeltaBytes: number;
}

interface GroupSums {
  count: number;
  size: number;
}

/**
 * Compute size + count per `(type, name)` group from a single snapshot.
 * Returns a Map keyed by `${typeIdx}::${name}` for cheap lookup; values
 * carry the resolved string type for output.
 */
function aggregateSnapshot(snap: SnapshotJson): Map<string, { type: string; name: string; sums: GroupSums }> {
  const nodeFields = snap.snapshot.meta.node_fields;
  const stride = nodeFields.length;
  const typeFieldIdx = nodeFields.indexOf('type');
  const nameFieldIdx = nodeFields.indexOf('name');
  const sizeFieldIdx = nodeFields.indexOf('self_size');
  if (typeFieldIdx < 0 || nameFieldIdx < 0 || sizeFieldIdx < 0) {
    throw new Error('heap-snapshot-diff: node_fields missing one of type/name/self_size');
  }
  const typeNames = snap.snapshot.meta.node_types[0];
  const strings = snap.strings;
  const nodes = snap.nodes;

  const result = new Map<string, { type: string; name: string; sums: GroupSums }>();
  const total = nodes.length / stride;
  for (let i = 0; i < total; i++) {
    const base = i * stride;
    const typeIdx = nodes[base + typeFieldIdx]!;
    const nameIdx = nodes[base + nameFieldIdx]!;
    const size = nodes[base + sizeFieldIdx]!;
    const typeLabel = typeNames[typeIdx] ?? `<type:${typeIdx}>`;
    const nameLabel = strings[nameIdx] ?? `<str:${nameIdx}>`;
    const key = `${typeIdx}::${nameLabel}`;
    const existing = result.get(key);
    if (existing) {
      existing.sums.count++;
      existing.sums.size += size;
    } else {
      result.set(key, { type: typeLabel, name: nameLabel, sums: { count: 1, size } });
    }
  }
  return result;
}

/**
 * Diff two heap snapshots. Returns growing/shrinking groups sorted by
 * `sizeDeltaBytes` descending (growers first; shrinkers at the bottom).
 * Groups whose count AND size deltas are both 0 are omitted (steady-state
 * allocators).
 */
export function diffSnapshots(snap1: SnapshotJson, snap2: SnapshotJson): DiffEntry[] {
  const agg1 = aggregateSnapshot(snap1);
  const agg2 = aggregateSnapshot(snap2);

  // Union of keys across both snapshots — groups that appeared OR disappeared
  // are still part of the diff.
  const allKeys = new Set<string>();
  for (const k of agg1.keys()) allKeys.add(k);
  for (const k of agg2.keys()) allKeys.add(k);

  const out: DiffEntry[] = [];
  for (const key of allKeys) {
    const e1 = agg1.get(key);
    const e2 = agg2.get(key);
    const c1 = e1?.sums.count ?? 0;
    const s1 = e1?.sums.size ?? 0;
    const c2 = e2?.sums.count ?? 0;
    const s2 = e2?.sums.size ?? 0;
    const countDelta = c2 - c1;
    const sizeDelta = s2 - s1;
    if (countDelta === 0 && sizeDelta === 0) continue;
    out.push({
      type: e2?.type ?? e1!.type,
      name: e2?.name ?? e1!.name,
      countDelta,
      sizeDeltaBytes: sizeDelta,
    });
  }
  out.sort((a, b) => b.sizeDeltaBytes - a.sizeDeltaBytes);
  return out;
}

/**
 * Format a top-N diff result as a Markdown table.
 */
export function formatDiffMarkdown(diff: readonly DiffEntry[], topN: number = 20): string {
  const ranked = diff.slice(0, topN);
  const lines: string[] = [];
  lines.push(`| Rank | Δ size (KB) | Δ count | Type | Name |`);
  lines.push(`|---:|---:|---:|---|---|`);
  ranked.forEach((entry, i) => {
    const sizeKb = (entry.sizeDeltaBytes / 1024).toFixed(2);
    const sizeSign = entry.sizeDeltaBytes >= 0 ? '+' : '';
    const countSign = entry.countDelta >= 0 ? '+' : '';
    // Truncate very long string-content names so the table stays readable.
    const nameTruncated = entry.name.length > 60 ? `${entry.name.slice(0, 57)}...` : entry.name;
    lines.push(`| ${i + 1} | ${sizeSign}${sizeKb} | ${countSign}${entry.countDelta} | ${entry.type} | ${nameTruncated} |`);
  });
  return lines.join('\n');
}

// ── CLI entry ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    // eslint-disable-next-line no-console
    console.error('Usage: pnpm tsx scripts/heap-snapshot-diff.ts <snap1.heapsnapshot> <snap2.heapsnapshot>');
    process.exit(1);
  }
  const { readFile } = await import('node:fs/promises');
  const [snap1Path, snap2Path] = args as [string, string];
  const [raw1, raw2] = await Promise.all([readFile(snap1Path, 'utf8'), readFile(snap2Path, 'utf8')]);
  const snap1: SnapshotJson = JSON.parse(raw1);
  const snap2: SnapshotJson = JSON.parse(raw2);
  const diff = diffSnapshots(snap1, snap2);
  // eslint-disable-next-line no-console
  console.log(`# Heap snapshot diff\n`);
  // eslint-disable-next-line no-console
  console.log(`Comparing ${snap1Path} → ${snap2Path}\n`);
  // eslint-disable-next-line no-console
  console.log(`Total groups with non-zero delta: ${diff.length}\n`);
  // eslint-disable-next-line no-console
  console.log(`## Top-20 growers (sorted by Δ size desc)\n`);
  // eslint-disable-next-line no-console
  console.log(formatDiffMarkdown(diff, 20));
}

// Only run main when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  void main();
}
