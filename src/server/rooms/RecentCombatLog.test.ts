import { describe, it, expect } from 'vitest';
import { RecentCombatLog, RECENT_COMBAT_WINDOW_MS } from './RecentCombatLog.js';

describe('RecentCombatLog', () => {
  it('returns null when nothing has been recorded', () => {
    expect(new RecentCombatLog().summary(1000)).toBeNull();
  });

  it('tallies ships and structures within the window + reports the latest ts', () => {
    const log = new RecentCombatLog();
    log.record('ship', 1000);
    log.record('ship', 1100);
    log.record('structure', 1200);
    const s = log.summary(1300);
    expect(s).not.toBeNull();
    expect(s!.shipsDestroyed).toBe(2);
    expect(s!.structuresDestroyed).toBe(1);
    expect(s!.lastEventMs).toBe(1200);
  });

  it('prunes events older than the window', () => {
    const log = new RecentCombatLog(1000); // 1 s window
    log.record('ship', 0);
    log.record('structure', 500);
    // At t=1500 the cutoff is 500: the t=0 ship is pruned, the t=500 structure stays.
    const s = log.summary(1500);
    expect(s!.shipsDestroyed).toBe(0);
    expect(s!.structuresDestroyed).toBe(1);
    expect(s!.lastEventMs).toBe(500);
  });

  it('returns null once ALL events age out', () => {
    const log = new RecentCombatLog(1000);
    log.record('ship', 0);
    expect(log.summary(2000)).toBeNull(); // cutoff 1000 > ts 0 → empty
  });

  it('record() prunes on insert so the buffer stays bounded to the window', () => {
    const log = new RecentCombatLog(100);
    for (let t = 0; t <= 1000; t += 10) log.record('ship', t);
    const s = log.summary(1000);
    // cutoff at the last record (t=1000) is 900 → ts in [900, 1000] survive = 11.
    expect(s!.shipsDestroyed).toBe(11);
  });

  it('defaults to a 5-minute window', () => {
    expect(RECENT_COMBAT_WINDOW_MS).toBe(5 * 60 * 1000);
    const log = new RecentCombatLog();
    log.record('ship', 0);
    expect(log.summary(RECENT_COMBAT_WINDOW_MS - 1)).not.toBeNull();
    expect(log.summary(RECENT_COMBAT_WINDOW_MS + 1)).toBeNull();
  });
});
