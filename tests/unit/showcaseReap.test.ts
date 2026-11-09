/**
 * A killed showcase run leaves its browsers and servers running (memory,
 * 2026-11-07: ~1 GB per killed take; free memory fell to 42 MB). The next run
 * reaps what the last one tracked, and never a reused PID running some other
 * program, nor the processes of a run that is still going.
 *
 * 2026-11-08: the env override below was ignored (tools.ts read a misspelt
 * variable), so this test reaped the REAL `showcase-out/.showcase-pids.json`
 * and killed a live perf run's servers. The pid-file writes also crashed with
 * ENOENT on a fresh checkout (no `showcase-out/`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTracked, reapStale, trackPid } from '../../showcase/tools';

const dir = mkdtempSync(path.join(tmpdir(), 'reap-'));
// A directory that does not exist yet: the writes must create it.
const file = path.join(dir, 'fresh', 'showcase-out', 'pids.json');
process.env['EQX_SHOWCASE_PID_FILE'] = file;
afterAll(() => { delete process.env['EQX_SHOWCASE_PID_FILE']; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { rmSync(path.join(dir, 'fresh'), { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleeper = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  return child.pid!;
};

describe('showcase process reaping', () => {
  it('honours EQX_SHOWCASE_PID_FILE and creates its directory (fresh checkout)', () => {
    expect(existsSync(file)).toBe(false);
    expect(() => clearTracked()).not.toThrow();
    expect(existsSync(file)).toBe(true);
    rmSync(path.join(dir, 'fresh'), { recursive: true, force: true });
    expect(reapStale()).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('kills a tracked process a killed run left behind', async () => {
    const pid = await sleeper();
    trackPid(pid);
    expect(alive(pid)).toBe(true);
    expect(reapStale()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pid)).toBe(false);
    expect(reapStale()).toBe(0); // the list is cleared
  }, 20_000);

  it('never reaps the processes of a run that is still alive', async () => {
    const owner = await sleeper();
    const child = await sleeper();
    const image = path.basename(process.execPath).toLowerCase();
    clearTracked(); // creates the directory
    writeFileSync(file, JSON.stringify([{ pid: child, image, owner, ownerImage: image }]));
    try {
      expect(reapStale()).toBe(0);
      expect(alive(child)).toBe(true);
    } finally {
      process.kill(child);
      process.kill(owner);
    }
  }, 20_000);
});
