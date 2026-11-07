/**
 * A killed showcase run leaves its browsers and servers running (memory,
 * 2026-11-07: ~1 GB per killed take; free memory fell to 42 MB). The next run
 * reaps what the last one tracked, and never a reused PID running some other
 * program.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reapStale, trackPid } from '../../showcase/tools';

const dir = mkdtempSync(path.join(tmpdir(), 'reap-'));
process.env['EQX_SHOWCASE_PID_FILE'] = path.join(dir, 'pids.json');
afterAll(() => { delete process.env['EQX_SHOWCASE_PID_FILE']; rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('showcase process reaping', () => {
  it('kills a tracked process a killed run left behind', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    trackPid(child.pid);
    expect(alive(child.pid!)).toBe(true);
    expect(reapStale()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(child.pid!)).toBe(false);
    expect(reapStale()).toBe(0); // the list is cleared
  }, 20_000);
});
