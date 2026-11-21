/**
 * Name the code behind a phone-lane stall (docs/ops/phone-link.md "Play evidence").
 *
 * A lane build is minified, so a capture's `loaf` events name scripts as
 * "B" or "". Each `topScripts` entry carries the script URL and
 * `sourceCharPosition` (the offset of the entry function in that file); with
 * the build's source maps (vite `build.sourcemap`, `<lane>/dist/assets/*.js.map`)
 * that resolves to the original file, line and function name. Offline, no deps.
 *
 *   pnpm phone:names <capture dir | perf.ndjson> [--dist <dir>]
 *
 * `--dist` defaults to the lane's dist (`resolvePhoneDir()/dist`). The script
 * file names carry the build hash, so a capture only resolves against the build
 * it was played on; a later `pnpm phone up` replaces the maps.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePhoneDir } from './phone-lane-core.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/**
 * Decode a v3 source map's `mappings` into per-generated-line segment lists:
 * `[genCol, srcIdx, srcLine, srcCol, nameIdx?]` (all 0-based), sorted by genCol.
 * @param {string} mappings
 * @returns {number[][][]}
 */
export function decodeMappings(mappings) {
  const lines = [];
  let src = 0, sLine = 0, sCol = 0, name = 0;
  for (const lineStr of mappings.split(';')) {
    const segs = [];
    let gCol = 0;
    for (const segStr of lineStr.split(',')) {
      if (segStr === '') continue;
      const vals = [];
      let shift = 0, value = 0;
      for (const ch of segStr) {
        const d = B64_INDEX.get(ch);
        if (d === undefined) throw new Error(`bad VLQ char ${ch}`);
        value += (d & 31) << shift;
        if (d & 32) { shift += 5; continue; }
        vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
        shift = 0; value = 0;
      }
      gCol += vals[0];
      if (vals.length >= 4) {
        src += vals[1]; sLine += vals[2]; sCol += vals[3];
        const seg = [gCol, src, sLine, sCol];
        if (vals.length >= 5) { name += vals[4]; seg.push(name); }
        segs.push(seg);
      }
    }
    segs.sort((a, b) => a[0] - b[0]);
    lines.push(segs);
  }
  return lines;
}

/** 0-based line + column of a char offset in `text`. */
export function offsetToLineCol(text, offset) {
  let line = 0, lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++; lineStart = i + 1;
  }
  return { line, col: offset - lineStart };
}

/**
 * Resolve a generated position against a parsed map. The entry offset of a
 * minified function usually lands on `function` / `(` (no name); the name sits
 * on the next segment (`function t`) or the one before (`u=(e)=>`).
 * `genText`: the generated line, to tell the two apart.
 * @param {{ sources: string[], names?: string[], sourcesContent?: (string|null)[], _lines?: number[][][] }} map
 * @returns {{ source: string, line: number, col: number, name: string | null, code: string | null } | null}
 */
export function resolvePosition(map, line, col, genText = '') {
  const lines = (map._lines ??= decodeMappings(map.mappings));
  const segs = lines[line];
  if (!segs || segs.length === 0) return null;
  let i = -1;
  for (let k = 0; k < segs.length && segs[k][0] <= col; k++) i = k;
  if (i < 0) return null;
  const seg = segs[i];
  const names = map.names ?? [];
  let nameIdx = seg[4];
  if (nameIdx === undefined) {
    const next = segs[i + 1];
    const prev = segs[i - 1];
    const declared = /^(async\s+)?(function|class)\b/.test(genText.slice(col, col + 16));
    const nextName = next && next[4] !== undefined && next[0] - col <= 16 ? next[4] : undefined;
    const prevName = prev && prev[4] !== undefined && col - prev[0] <= 4 ? prev[4] : undefined;
    // `function t(` names itself after the keyword; `u=(e)=>` / `x:(e)=>` is named by the binding before.
    nameIdx = declared ? nextName : (prevName ?? nextName);
  }
  const content = map.sourcesContent?.[seg[1]] ?? null;
  const code = content ? (content.split('\n')[seg[2]] ?? '').trim().slice(0, 120) : null;
  return {
    source: map.sources[seg[1]] ?? '?',
    line: seg[2] + 1,
    col: seg[3] + 1,
    name: nameIdx === undefined ? null : (names[nameIdx] ?? null),
    code,
  };
}

/**
 * Builds a resolver over a dist folder: (script URL, char offset) -> source position.
 * Files are read once each.
 */
export function makeResolver(distDir) {
  const cache = new Map();
  const load = (url) => {
    let rel;
    try { rel = new URL(url).pathname; } catch { rel = url; }
    rel = decodeURIComponent(rel).replace(/^\/+/, '');
    if (cache.has(rel)) return cache.get(rel);
    const js = path.join(distDir, rel);
    const entry = existsSync(js) && existsSync(`${js}.map`)
      ? { js: readFileSync(js, 'utf8'), map: JSON.parse(readFileSync(`${js}.map`, 'utf8')), rel }
      : { missing: rel };
    cache.set(rel, entry);
    return entry;
  };
  return (url, charPos) => {
    if (!url || typeof charPos !== 'number' || charPos < 0) return { unresolved: 'no script position' };
    const e = load(url);
    if (e.missing) return { unresolved: `no ${e.missing}(.map) in ${distDir} (rebuilt since?)` };
    const { line, col } = offsetToLineCol(e.js, charPos);
    const r = resolvePosition(e.map, line, col, e.js.slice(charPos - col, charPos + 32));
    if (!r) return { unresolved: `no mapping at ${e.rel}:${line + 1}:${col + 1}` };
    // `sources` are relative to the map file.
    const source = path.posix.normalize(path.posix.join(path.posix.dirname(e.rel), r.source)).replace(/^(\.\.\/)+/, '');
    return { ...r, source };
  };
}

/** Parse ndjson capture lines (bad lines skipped). */
export function readEvents(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial last line */ }
  }
  return out;
}

/**
 * Name every LoAF script and summarise the stalls in a capture's events.
 * @returns {{ functions: Array<{ where: string, name: string | null, code: string | null, totalMs: number, count: number, maxMs: number }>, unresolved: Record<string, number>, stalls: Array<{ tag: string, mode: string, count: number, totalMs: number }>, zoom: Array<{ viewHalf: string, count: number }> }}
 */
export function nameStalls(events, resolve) {
  const fns = new Map();
  const unresolved = {};
  const stalls = new Map();
  const zoom = new Map();
  for (const ev of events) {
    const d = ev?.data ?? {};
    if (ev.tag === 'loaf') {
      for (const s of d.topScripts ?? []) {
        const r = resolve(s.sourceURL || s.invoker, s.sourceCharPosition);
        if (r.unresolved) { unresolved[r.unresolved] = (unresolved[r.unresolved] ?? 0) + 1; continue; }
        const where = `${r.source}:${r.line}:${r.col}`;
        const f = fns.get(where) ?? { where, name: r.name, code: r.code, totalMs: 0, count: 0, maxMs: 0 };
        f.totalMs += s.duration ?? 0; f.count++; f.maxMs = Math.max(f.maxMs, s.duration ?? 0);
        fns.set(where, f);
      }
    }
    if (ev.tag === 'loaf' || ev.tag === 'raf_stutter' || ev.tag === 'raf_gap') {
      const mode = typeof d.mode === 'string' ? d.mode : '?';
      const key = `${ev.tag}|${mode}`;
      const st = stalls.get(key) ?? { tag: ev.tag, mode, count: 0, totalMs: 0 };
      st.count++; st.totalMs += d.elapsedMs ?? d.durationMs ?? 0;
      stalls.set(key, st);
      const vh = typeof d.viewHalf === 'number' ? zoomBucket(d.viewHalf) : '?';
      zoom.set(vh, (zoom.get(vh) ?? 0) + 1);
    }
  }
  const round = (x) => Math.round(x * 10) / 10;
  return {
    functions: [...fns.values()].map((f) => ({ ...f, totalMs: round(f.totalMs), maxMs: round(f.maxMs) })).sort((a, b) => b.totalMs - a.totalMs),
    unresolved,
    stalls: [...stalls.values()].map((s) => ({ ...s, totalMs: round(s.totalMs) })),
    zoom: [...zoom.entries()].map(([viewHalf, count]) => ({ viewHalf, count })).sort((a, b) => b.count - a.count),
  };
}

/** Zoom bucket label: powers of two of viewHalf (game units). */
export function zoomBucket(viewHalf) {
  if (!(viewHalf > 0)) return '?';
  const lo = 2 ** Math.floor(Math.log2(viewHalf));
  return `${lo}-${lo * 2}`;
}

function main(argv) {
  const args = argv.slice(2);
  const di = args.indexOf('--dist');
  const dist = di >= 0 ? args.splice(di, 2)[1] : path.join(resolvePhoneDir(), 'dist');
  const target = args[0];
  if (!target) { console.error('usage: pnpm phone:names <capture dir | perf.ndjson> [--dist <dir>]'); process.exit(2); }
  // Older captures filed `loaf` under other.ndjson.
  const files = statSync(target).isDirectory()
    ? ['perf.ndjson', 'other.ndjson'].map((f) => path.join(target, f)).filter((f) => existsSync(f))
    : [target];
  const file = files.join(' + ');
  const res = nameStalls(files.flatMap((f) => readEvents(readFileSync(f, 'utf8'))), makeResolver(dist));
  console.log(`LoAF scripts by total time (${file}, maps from ${dist}):`);
  for (const f of res.functions.slice(0, 25)) {
    console.log(`${String(f.totalMs).padStart(8)} ms  x${String(f.count).padEnd(4)} max ${String(f.maxMs).padStart(6)}  ${f.name ?? '(anonymous)'}  ${f.where}${f.code ? `\n${' '.repeat(20)}${f.code}` : ''}`);
  }
  for (const [why, n] of Object.entries(res.unresolved)) console.log(`unresolved x${n}: ${why}`);
  console.log('\nStalls by control mode:');
  for (const s of res.stalls) console.log(`  ${s.tag.padEnd(12)} ${s.mode.padEnd(8)} x${s.count}  ${s.totalMs} ms`);
  console.log('Stalls by zoom (viewHalf, game units):');
  for (const z of res.zoom) console.log(`  ${z.viewHalf.padEnd(12)} x${z.count}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv);
