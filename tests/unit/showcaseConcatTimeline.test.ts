/**
 * The showcase encode timeline (review 2026-11-07, "still significant
 * jittering and jumpyness"). A hostile audit of the capture chain found the
 * game draws evenly paced frames, but the encode made them jump:
 *  - CDP screencast frames arrive OUT OF timestamp order (21 in the bystander
 *    take); the list was built in arrival order, so a newer frame got ~1 ms
 *    and an older one was held, then the video jumped forward;
 *  - capture timestamps are noisy (p5 13.6 ms, p95 20.8 ms) while the game
 *    paces at the display's 60 Hz, so resampling the noisy durations onto a
 *    60 fps grid repeated one frame and skipped the next ~5 times a second;
 *  - a frame that arrived after the screencast stopped kept an absolute epoch
 *    time, giving its predecessor a 1.79e9 s duration (no fade-out).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeConcatList } from '../../showcase/compositor';
import type { FrameIndex } from '../../showcase/recorder';

const SLOT = 1000 / 60;
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function timeline(frames: Array<{ file: string; t: number }>, durationMs: number): Array<{ file: string; d: number }> {
  dir = mkdtempSync(path.join(tmpdir(), 'concat-'));
  const index: FrameIndex = { frames, startT: 0, endT: durationMs };
  writeConcatList(dir, index, durationMs);
  const lines = readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8').split('\n');
  const out: Array<{ file: string; d: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^file '(.+)'$/.exec(lines[i]!);
    const dm = /^duration ([\d.]+)$/.exec(lines[i + 1] ?? '');
    if (m && dm) out.push({ file: m[1]!, d: Number(dm[1]) * 1000 });
  }
  return out;
}

describe('showcase encode timeline', () => {
  it('plays frames in timestamp order, never arrival order', () => {
    // f2 arrived before f1 but was captured after it.
    const t = timeline([
      { file: 'f0', t: 0 }, { file: 'f2', t: 2 * SLOT }, { file: 'f1', t: SLOT }, { file: 'f3', t: 3 * SLOT },
    ], 4 * SLOT);
    expect(t.map((x) => x.file)).toEqual(['f0', 'f1', 'f2', 'f3']);
  });

  it('gives an evenly paced capture with noisy timestamps one 60 Hz slot per frame', () => {
    // A frame every slot, timestamps jittered ±3.5 ms (the measured noise).
    const jit = [0, 3.5, -3, 2, -3.5, 1, 3, -2, 0, 3.5, -3.5, 2];
    const t = timeline(jit.map((j, i) => ({ file: `f${i}`, t: i * SLOT + j + 4 })), jit.length * SLOT + 4);
    for (const x of t) expect(x.d).toBeCloseTo(SLOT, 2);
  });

  it('holds a frame only for slots really missing (a dropped capture frame)', () => {
    const t = timeline([{ file: 'f0', t: 0 }, { file: 'f1', t: SLOT }, { file: 'f3', t: 3 * SLOT }, { file: 'f4', t: 4 * SLOT }], 5 * SLOT);
    expect(t.map((x) => Math.round(x.d / SLOT))).toEqual([1, 2, 1, 1]);
  });

  it('keeps every frame when the capture stamps them in pairs (4 ms, then 29 ms apart)', () => {
    // Review 2026-11-12 (capital-pilot): one frame per refresh, but on a loaded
    // host the screencast stamps them in pairs, each frame ±6 ms off its
    // refresh. Snapping to the nearest slot put each pair in one slot: one real
    // frame dropped, the next slot a held repeat (60 captured -> 48 encoded).
    const n = 24;
    const t = timeline(Array.from({ length: n }, (_, i) => ({ file: `f${i}`, t: i * SLOT + (i % 2 === 0 ? 6 : -6) + 10 })), n * SLOT + 10);
    expect(t.map((x) => x.file)).toEqual(Array.from({ length: n }, (_, i) => `f${i}`));
    for (const x of t.slice(0, -1)) expect(Math.round(x.d / SLOT)).toBe(1);
  });

  it('never lets a fast burst push frames more than one slot late', () => {
    // Three frames stamped in one slot: two fit (this slot and the next), the
    // third would sit two slots late, so it is dropped rather than drift.
    const t = timeline([{ file: 'f0', t: 0 }, { file: 'a', t: SLOT }, { file: 'b', t: SLOT + 1 }, { file: 'c', t: SLOT + 2 }, { file: 'f3', t: 3 * SLOT }], 4 * SLOT);
    expect(t.map((x) => x.file)).toEqual(['f0', 'a', 'b', 'f3']);
  });

  it('ignores frames stamped outside the take (a late frame with an epoch time)', () => {
    const t = timeline([{ file: 'f0', t: 0 }, { file: 'f1', t: SLOT }, { file: 'late', t: 1.79e12 }], 2 * SLOT);
    expect(t.map((x) => x.file)).toEqual(['f0', 'f1']);
    for (const x of t) expect(x.d).toBeLessThanOrEqual(200);
  });
});
