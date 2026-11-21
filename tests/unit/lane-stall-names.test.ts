/**
 * `scripts/dev/lane-stall-names.mjs` (docs/ops/phone-link.md "Play evidence"):
 * a lane capture's minified LoAF scripts resolve to source names through the
 * build's source maps. Fixture: tests/fixtures/lane-stall (esbuild-minified
 * `src/game.ts` + its map, and a capture naming it by char position).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeMappings, makeResolver, nameStalls, readEvents, zoomBucket } from '../../scripts/dev/lane-stall-names.mjs';

const FIX = path.join(__dirname, '../fixtures/lane-stall');
const DIST = path.join(FIX, 'lane-dist');
const URL_ = 'https://x.trycloudflare.com/assets/index-Fx1.js';

describe('lane stall names', () => {
  it('decodes VLQ mappings (first segment of the fixture map)', () => {
    const map = JSON.parse(readFileSync(path.join(DIST, 'assets/index-Fx1.js.map'), 'utf8')) as { mappings: string };
    expect(decodeMappings(map.mappings)[0]![0]).toEqual([0, 0, 2, 0]);
  });

  it('maps a minified function offset back to its source name and line', () => {
    const resolve = makeResolver(DIST);
    expect(resolve(URL_, 9)).toMatchObject({ name: 'stepSwarm', source: 'src/game.ts', line: 5 });
    expect(resolve(URL_, 62)).toMatchObject({ name: 'renderFrame', line: 11, code: 'export function renderFrame(now: number): void {' });
    // An arrow's offset lands on `(`: the name is on the binding just before.
    expect(resolve(URL_, 128)).toMatchObject({ name: 'onResize', line: 17 });
  });

  it('says why a script cannot be named (no position, other build)', () => {
    const resolve = makeResolver(DIST);
    expect(resolve(URL_, -1)).toEqual({ unresolved: 'no script position' });
    expect(resolve(URL_, undefined)).toEqual({ unresolved: 'no script position' });
    expect(resolve('https://x/assets/index-OLD.js', 0).unresolved).toMatch(/index-OLD\.js.*rebuilt since/);
  });

  it('summarises a capture: functions by total time, stalls by mode and zoom', () => {
    const events = readEvents(readFileSync(path.join(FIX, 'perf.ndjson'), 'utf8'));
    const r = nameStalls(events, makeResolver(DIST));
    expect(r.functions[0]).toMatchObject({ name: 'renderFrame', totalMs: 120, count: 2, maxMs: 70 });
    expect(r.functions[1]).toMatchObject({ name: 'onResize', totalMs: 10, count: 1 });
    expect(Object.values(r.unresolved)).toEqual([1]);
    expect(r.stalls).toEqual(expect.arrayContaining([
      { tag: 'raf_stutter', mode: 'fly', count: 1, totalMs: 86 },
      { tag: 'raf_gap', mode: 'command', count: 1, totalMs: 120 },
      { tag: 'loaf', mode: 'fly', count: 1, totalMs: 86 },
    ]));
    expect(r.zoom).toEqual(expect.arrayContaining([{ viewHalf: '1024-2048', count: 2 }, { viewHalf: '4096-8192', count: 2 }]));
  });

  it('zoom buckets are powers of two', () => {
    expect(zoomBucket(1800)).toBe('1024-2048');
    expect(zoomBucket(0)).toBe('?');
  });
});
