/**
 * Real cadence of a take (bug 2026-11-10). The take QA said "60.1 fps, worst
 * gap 23-34 ms", but the encoded clips showed ~25 different frames a second
 * in a 2/3-slot judder (pack-battle: 395 repeats in 720 frames). The capture
 * was 60 different frames a second; the encode lost them: ffmpeg's concat
 * demuxer read each JPEG at the image demuxer's default 25 fps time base, so
 * each 1/60 s duration rounded to 0 or 1/25 s and `fps=60` kept one frame per
 * 40 ms. Measured on capital-guns-fighter: ffprobe of the old list gave pts
 * 0, 0, .04, .04, .08, .08, .12, .12, .12, ...
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { concatPts, cadenceProblem, distinctRuns, longestRepeat, perSecond, slotsKept } from './cadence.js';
import { writeConcatList } from './compositor.js';

const SLOT = 1000 / 60;
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

/** What the concat demuxer makes of a written list: per-file duration and declared framerate. */
function parseList(text: string): Array<{ d: number; framerate: number | null }> {
  const out: Array<{ d: number; framerate: number | null }> = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('file ')) out.push({ d: 0, framerate: null });
    const cur = out[out.length - 1];
    if (!cur) continue;
    const dm = /^duration ([\d.]+)$/.exec(line);
    if (dm) cur.d = Number(dm[1]);
    const fm = /^option framerate (\d+)$/.exec(line);
    if (fm) cur.framerate = Number(fm[1]);
  }
  return out;
}

/** ffmpeg's image demuxer reads a JPEG at 25 fps unless told otherwise. */
const IMAGE2_DEFAULT_FPS = 25;

describe('take cadence', () => {
  it('counts frames that differ from the one before', () => {
    expect(distinctRuns(['a', 'a', 'b', 'b', 'b', 'c', 'a'])).toBe(4);
    expect(distinctRuns([])).toBe(0);
    expect(longestRepeat(['a', 'a', 'b', 'b', 'b', 'c'])).toBe(3);
    expect(longestRepeat(['a', 'b'])).toBe(1);
    expect(perSecond(1320, 22_000)).toBe(60);
  });

  it('keeps one frame per output slot', () => {
    expect(slotsKept([0, 1 / 60, 2 / 60, 3 / 60], 60)).toBe(4);
    expect(slotsKept([0, 0, 0.04, 0.04, 0.08], 60)).toBe(3);
  });

  it('models the bug: 1/60 s durations at a 25 fps time base keep ~25 frames a second', () => {
    const d = Array.from({ length: 600 }, () => 1 / 60);
    expect(slotsKept(concatPts(d, IMAGE2_DEFAULT_FPS), 60) / 10).toBeLessThan(26);
    expect(slotsKept(concatPts(d, 60), 60) / 10).toBe(60);
  });

  it('flags a take whose different-frame rate is under the gate', () => {
    expect(cadenceProblem('encoded', 25.1, 55)).toMatch(/25.1 different frames\/s/);
    expect(cadenceProblem('encoded', 59.9, 55)).toBeNull();
  });
});

describe('encode list keeps every captured frame', () => {
  it('reads each frame at the output rate, so a 60 fps capture encodes as 60 different frames a second', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cadence-'));
    const n = 600;
    const frames = Array.from({ length: n }, (_, i) => ({ file: `frames/${i}.jpg`, t: i * SLOT + ((i * 7) % 5) - 2 }));
    writeConcatList(dir, { frames, startT: 0, endT: n * SLOT }, n * SLOT);
    const list = parseList(readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8'));
    const timed = list.slice(0, -1);
    // Every file is read at a declared framerate; none falls back to 25 fps.
    for (const f of list) expect(f.framerate).toBe(60);
    const pts = concatPts(timed.map((f) => f.d), timed[0]!.framerate ?? IMAGE2_DEFAULT_FPS);
    expect(slotsKept(pts, 60)).toBe(timed.length);
    expect(perSecond(slotsKept(pts, 60), n * SLOT)).toBeGreaterThanOrEqual(59);
  });
});
