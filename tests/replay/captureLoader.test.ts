/**
 * captureLoader regression locks — mid-stream tolerance.
 *
 * Plan: streaming auto-capture, Phase 5 (2026-05-21).
 *
 * The replay harness loader was originally built against manual
 * captures, which always have a complete `summary.json` (server
 * writes it on POST). Streaming captures, by design, may be
 * inspected mid-session — `summary.json` doesn't exist yet (deferred
 * idle-finalize). The loader MUST tolerate this so the user (or
 * future automation) can replay a streaming session before it ends.
 *
 * These tests build temporary directories with just enough structure
 * to exercise the loader's tolerance paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCapture } from './captureLoader';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'eqx-replay-loader-test-'));
});

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

async function makeFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(testDir, name);
  await mkdir(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(join(dir, filename), content, 'utf8');
  }
  return dir;
}

const WELCOME_LINE = JSON.stringify({
  source: 'client',
  ts: 100,
  tag: 'welcome',
  data: { playerId: 'test-player-1', serverTick: 5000, idReassigned: false },
});

const SNAPSHOT_LINE = (n: number, ts: number, serverTick: number): string =>
  JSON.stringify({
    source: 'client',
    ts,
    tag: 'snapshot',
    data: {
      n,
      serverTick,
      ackedTick: serverTick - 5,
      ticksAhead: 5,
      intervalMs: 50,
      rttMs: 60,
      driftUnits: 0,
      angleDriftRad: 0,
      maxDriftUnits: 0,
      lerping: false,
      serverX: 100,
      serverY: 100,
      beforeX: 100,
      beforeY: 100,
      afterX: 100,
      afterY: 100,
    },
  });

describe('captureLoader — streaming directory tolerance', () => {
  it('loads a mid-stream directory with NO summary.json', async () => {
    // Streaming directories don't have summary.json until finalize.
    // The loader must read the ndjson files directly and succeed.
    const dir = await makeFixture('mid-stream-no-summary', {
      'lifecycle.ndjson': WELCOME_LINE + '\n',
      'snapshots.ndjson': [
        SNAPSHOT_LINE(1, 100, 5000),
        SNAPSHOT_LINE(2, 150, 5003),
        SNAPSHOT_LINE(3, 200, 5006),
      ].join('\n') + '\n',
      'session.json': JSON.stringify({
        sessionId: 'mid-stream-no-summary',
        streaming: true,
        hasFinalized: false,
        lastAppliedSeq: 2,
        lastBatchAtMs: Date.now(),
        startedAtMs: Date.now() - 5000,
      }),
    });

    const cap = loadCapture(dir);
    expect(cap.welcome.playerId).toBe('test-player-1');
    expect(cap.welcome.serverTick).toBe(5000);
    expect(cap.counts.snapshot).toBe(3);
    expect(cap.events.length).toBeGreaterThanOrEqual(4); // 1 welcome + 3 snapshots
  });

  it('loads a directory with only welcome — no snapshots yet', async () => {
    // A streaming session at moment N=0 might have only welcome
    // landed. The loader should still succeed (it returns
    // events.length=1, but doesn't throw).
    const dir = await makeFixture('welcome-only', {
      'lifecycle.ndjson': WELCOME_LINE + '\n',
    });

    const cap = loadCapture(dir);
    expect(cap.welcome.playerId).toBe('test-player-1');
    expect(cap.counts.snapshot).toBe(0);
    expect(cap.counts.welcome).toBe(1);
  });

  it('throws cleanly when welcome is absent (replay cannot bootstrap)', async () => {
    // This SHOULD throw — the loader documents that welcome is
    // required. Mid-stream directories ALWAYS have welcome (it's
    // the first lifecycle event the client emits). A directory
    // without it isn't replayable.
    const dir = await makeFixture('no-welcome', {
      'snapshots.ndjson': SNAPSHOT_LINE(1, 100, 5000) + '\n',
      // intentionally no lifecycle.ndjson
    });

    expect(() => loadCapture(dir)).toThrow(/welcome/);
  });

  it('handles a streaming directory whose raf.ndjson includes Phase A enriched tags', async () => {
    // Phase A added input_intent, local_pose_predicted, local_pose_rendered.
    // Streaming captures will carry these the same way manual ones do.
    // Loader must categorise them correctly.
    const rafLines = [
      JSON.stringify({
        source: 'client',
        ts: 100,
        tag: 'rafTick',
        data: { elapsedMs: 16.7, targetTick: 5005, inputTick: 5005, deficitBefore: 0, stepsThisFrame: 1, capped: false, anchorServerTick: 5000, leadTicks: 5 },
      }),
      JSON.stringify({
        source: 'client',
        ts: 101,
        tag: 'input_intent',
        data: { tick: 5005, thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false, fireHeld: false, joystickX: null, joystickY: null },
      }),
      JSON.stringify({
        source: 'client',
        ts: 102,
        tag: 'local_pose_predicted',
        data: { tick: 5005, x: 100, y: 100, vx: 50, vy: 0, angle: 0, angvel: 0 },
      }),
      JSON.stringify({
        source: 'client',
        ts: 103,
        tag: 'local_pose_rendered',
        data: { inputTick: 5005, x: 100.5, y: 100, angle: 0, lerpOffsetX: 0.5, lerpOffsetY: 0, lerpAngleOffset: 0 },
      }),
    ].join('\n') + '\n';

    const dir = await makeFixture('phase-a-streaming', {
      'lifecycle.ndjson': WELCOME_LINE + '\n',
      'snapshots.ndjson': SNAPSHOT_LINE(1, 50, 5000) + '\n',
      'raf.ndjson': rafLines,
    });

    const cap = loadCapture(dir);
    expect(cap.counts.rafTick).toBe(1);
    expect(cap.counts.input_intent).toBe(1);
    expect(cap.counts.local_pose_predicted).toBe(1);
    expect(cap.counts.local_pose_rendered).toBe(1);
  });
});
