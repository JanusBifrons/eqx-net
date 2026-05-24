/**
 * Damage-number event contract — schedule / spawn / cancel.
 *
 * Plan: mobile-perf-investigation (2026-05-24, Probe 4).
 *
 * Capture `n6uznw` showed the pre-fix instrumentation firing
 * `damage_number_predicted` five times at the same ts per hitscan shot
 * (one for each smooth-beam split). The repeated event at the same ts
 * made it impossible to tell from the capture whether spawns were
 * actually firing or being silently cancelled — which was load-bearing
 * for the user-reported "laser damage is applying inconsistently"
 * investigation.
 *
 * Post-fix shape:
 *   - One `damage_number_scheduled` per shot with `{ tag, totalDamage,
 *     count, intervalMs, firstSpawnImmediate }`.
 *   - One `damage_number_spawned` per actual emit (from the drain in
 *     `updateMirror`) with `{ tag, damage, lateMs }`.
 *   - One `damage_number_cancelled` per cancellation reach with `{ tag,
 *     cancelledScheduled }` IFF at least one scheduled spawn was evicted.
 *
 * This test exercises the pure schedule-side logic by reproducing the
 * inline code path from `ColyseusClient.sendFire` against a mocked
 * sink + log recorder. It does NOT spin up a full ColyseusClient
 * (which requires a wired room + predWorld + ledger); the integration
 * coverage lives in the E2E spec.
 *
 * The math under test:
 *   - SMOOTH_BEAM_SPLITS = 5
 *   - splitIntervalMs = cooldownTicks / 60 * 1000 / 5
 *   - Damage divides floor(damage / 5) per tick, remainder onto last
 *   - First tick emits immediately (no schedule entry)
 *   - Remaining 4 ticks land in `_scheduledDamageSpawns`
 */
import { describe, it, expect } from 'vitest';

const SMOOTH_BEAM_SPLITS = 5;

interface ScheduledSpawn { atMs: number; x: number; y: number; damage: number; tag: string }
interface SpawnedEntry { x: number; y: number; damage: number; tag: string }
interface LogEntry { tag: string; data: Record<string, unknown> }

/**
 * Pure re-implementation of the inline schedule logic from
 * `ColyseusClient.sendFire`'s `pushDamageNumber`. Returns the (immediate
 * pending entries, scheduled entries, log events) tuple.
 */
function scheduleHitscanDamage(opts: {
  x: number;
  y: number;
  damage: number;
  tag: string;
  splitIntervalMs: number;
  clockNowMs: number;
}): { pending: SpawnedEntry[]; scheduled: ScheduledSpawn[]; logs: LogEntry[] } {
  const pending: SpawnedEntry[] = [];
  const scheduled: ScheduledSpawn[] = [];
  const logs: LogEntry[] = [];

  const base = Math.floor(opts.damage / SMOOTH_BEAM_SPLITS);
  const remainder = opts.damage - base * SMOOTH_BEAM_SPLITS;
  let actualCount = 0;
  for (let i = 0; i < SMOOTH_BEAM_SPLITS; i++) {
    const tickDamage = i === SMOOTH_BEAM_SPLITS - 1 ? base + remainder : base;
    if (tickDamage <= 0) continue;
    actualCount++;
    if (i === 0) {
      pending.push({ x: opts.x, y: opts.y, damage: tickDamage, tag: opts.tag });
    } else {
      scheduled.push({
        atMs: opts.clockNowMs + i * opts.splitIntervalMs,
        x: opts.x,
        y: opts.y,
        damage: tickDamage,
        tag: opts.tag,
      });
    }
  }
  logs.push({
    tag: 'damage_number_scheduled',
    data: {
      tag: opts.tag,
      totalDamage: opts.damage,
      count: actualCount,
      intervalMs: parseFloat(opts.splitIntervalMs.toFixed(2)),
      firstSpawnImmediate: true,
    },
  });
  return { pending, scheduled, logs };
}

/**
 * Drain — mirrors the updateMirror() loop. Returns spawn events for
 * any entries with `atMs <= now`.
 */
function drainScheduledSpawns(
  scheduled: ScheduledSpawn[],
  nowMs: number,
): { spawned: SpawnedEntry[]; remaining: ScheduledSpawn[]; logs: LogEntry[] } {
  const spawned: SpawnedEntry[] = [];
  const remaining: ScheduledSpawn[] = [];
  const logs: LogEntry[] = [];
  for (const s of scheduled) {
    if (s.atMs <= nowMs) {
      spawned.push({ x: s.x, y: s.y, damage: s.damage, tag: s.tag });
      logs.push({
        tag: 'damage_number_spawned',
        data: {
          damage: s.damage,
          tag: s.tag,
          lateMs: parseFloat((nowMs - s.atMs).toFixed(2)),
        },
      });
    } else {
      remaining.push(s);
    }
  }
  return { spawned, remaining, logs };
}

/**
 * Cancel — mirrors the cancelByTag inline logic.
 */
function cancelByTag(
  scheduled: ScheduledSpawn[],
  tag: string,
): { remaining: ScheduledSpawn[]; logs: LogEntry[] } {
  let cancelledScheduled = 0;
  const remaining: ScheduledSpawn[] = [];
  for (const s of scheduled) {
    if (s.tag === tag) cancelledScheduled++;
    else remaining.push(s);
  }
  const logs: LogEntry[] = [];
  if (cancelledScheduled > 0) {
    logs.push({
      tag: 'damage_number_cancelled',
      data: { tag, cancelledScheduled },
    });
  }
  return { remaining, logs };
}

describe('damage_number_scheduled event — fires ONCE per shot (not per split)', () => {
  it('hitscan damage=20 produces exactly ONE schedule event with count=5', () => {
    const r = scheduleHitscanDamage({
      x: 100, y: 50, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    expect(r.logs.length).toBe(1);
    expect(r.logs[0].tag).toBe('damage_number_scheduled');
    expect(r.logs[0].data['count']).toBe(5);
    expect(r.logs[0].data['totalDamage']).toBe(20);
    expect(r.logs[0].data['firstSpawnImmediate']).toBe(true);
  });

  it('immediate pending = 1 entry, scheduled queue = 4 entries', () => {
    const r = scheduleHitscanDamage({
      x: 100, y: 50, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    expect(r.pending.length).toBe(1);
    expect(r.pending[0].damage).toBe(4);
    expect(r.scheduled.length).toBe(4);
  });

  it('sum of (pending + scheduled) damages equals the total', () => {
    const r = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const allDamage = r.pending.reduce((s, p) => s + p.damage, 0)
      + r.scheduled.reduce((s, p) => s + p.damage, 0);
    expect(allDamage).toBe(20);
  });

  it('remainder lands on the LAST scheduled tick', () => {
    // damage=23 → base=4, remainder=3 → ticks [4,4,4,4,7]
    const r = scheduleHitscanDamage({
      x: 0, y: 0, damage: 23, tag: 'shot-2',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    expect(r.pending[0].damage).toBe(4);
    expect(r.scheduled.map((s) => s.damage)).toEqual([4, 4, 4, 7]);
  });

  it('damage too small to split (damage < SMOOTH_BEAM_SPLITS=5) → still 1 schedule event, count reflects actual', () => {
    // damage=2 → base=0, remainder=2 → ticks [0,0,0,0,2] → 4 skipped (≤0), 1 emit
    const r = scheduleHitscanDamage({
      x: 0, y: 0, damage: 2, tag: 'shot-3',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    expect(r.logs[0].data['count']).toBe(1);
    // The lone tick is the LAST tick (index 4) so it goes to scheduled, not pending.
    expect(r.pending.length).toBe(0);
    expect(r.scheduled.length).toBe(1);
    expect(r.scheduled[0].damage).toBe(2);
  });
});

describe('damage_number_spawned event — fires per actual drain emit', () => {
  it('drain after splitIntervalMs spawns ONE entry with lateMs ≈ 0', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    // Advance to just after the first scheduled spawn (1000 + 33.33).
    const drain = drainScheduledSpawns(sched.scheduled, 1033.34);
    expect(drain.spawned.length).toBe(1);
    expect(drain.logs.length).toBe(1);
    expect(drain.logs[0].tag).toBe('damage_number_spawned');
    expect(drain.logs[0].data['damage']).toBe(4);
    expect(drain.logs[0].data['tag']).toBe('shot-1');
    expect(drain.logs[0].data['lateMs']).toBeLessThan(1);
    expect(drain.logs[0].data['lateMs']).toBeGreaterThanOrEqual(0);
  });

  it('full drain after window completes spawns all 4 remaining', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const drain = drainScheduledSpawns(sched.scheduled, 1200); // well past last
    expect(drain.spawned.length).toBe(4);
    expect(drain.remaining.length).toBe(0);
    const logTags = drain.logs.map((l) => l.tag);
    expect(logTags).toEqual([
      'damage_number_spawned',
      'damage_number_spawned',
      'damage_number_spawned',
      'damage_number_spawned',
    ]);
  });

  it('lateMs reports how late the drain ran (catches sluggish updateMirror cycles)', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    // Scheduled atMs values: 1033.33, 1066.66, 1099.99, 1133.32.
    // Drain runs at 1100 → first three are due (≤1100), the fourth is not.
    const drain = drainScheduledSpawns(sched.scheduled, 1100);
    expect(drain.logs.length).toBe(3);
    expect(drain.logs[0].data['lateMs']).toBeGreaterThan(30); // first spawn was 66.67ms late
    expect(drain.remaining.length).toBe(1); // last entry not yet due
  });
});

describe('damage_number_cancelled event — fires on cancellation reach', () => {
  it('cancel after schedule but before any drain → 4 cancelled', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const cancel = cancelByTag(sched.scheduled, 'shot-1');
    expect(cancel.remaining.length).toBe(0);
    expect(cancel.logs.length).toBe(1);
    expect(cancel.logs[0].tag).toBe('damage_number_cancelled');
    expect(cancel.logs[0].data['tag']).toBe('shot-1');
    expect(cancel.logs[0].data['cancelledScheduled']).toBe(4);
  });

  it('cancel partway through → fires event with the remaining count', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    // Drain first two (1033.33 and 1066.66), then cancel — 2 remaining.
    const drain = drainScheduledSpawns(sched.scheduled, 1080);
    expect(drain.spawned.length).toBe(2);
    const cancel = cancelByTag(drain.remaining, 'shot-1');
    expect(cancel.logs[0].data['cancelledScheduled']).toBe(2);
  });

  it('cancel for unknown tag → NO event (silent)', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const cancel = cancelByTag(sched.scheduled, 'shot-9999');
    expect(cancel.logs.length).toBe(0);
    expect(cancel.remaining.length).toBe(4);
  });

  it('cancel after full drain → NO event (everything already spawned)', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const drain = drainScheduledSpawns(sched.scheduled, 9999);
    const cancel = cancelByTag(drain.remaining, 'shot-1');
    expect(cancel.logs.length).toBe(0);
  });
});

describe('FULL FLOW: one shot → schedule + drain + verify the math closes', () => {
  it('schedule(damage=20) + full drain = 1 scheduled event + 5 emits total (1 pending + 4 spawned)', () => {
    const sched = scheduleHitscanDamage({
      x: 0, y: 0, damage: 20, tag: 'shot-1',
      splitIntervalMs: 33.33,
      clockNowMs: 1000,
    });
    const drain = drainScheduledSpawns(sched.scheduled, 9999);
    // Event counts.
    expect(sched.logs.filter((l) => l.tag === 'damage_number_scheduled').length).toBe(1);
    expect(drain.logs.filter((l) => l.tag === 'damage_number_spawned').length).toBe(4);
    // Emit counts (pending + spawned).
    const allEmits = [...sched.pending, ...drain.spawned];
    expect(allEmits.length).toBe(5);
    // Total damage emitted matches schedule's totalDamage field.
    expect(allEmits.reduce((s, e) => s + e.damage, 0)).toBe(20);
    expect(sched.logs[0].data['totalDamage']).toBe(20);
  });

  it('REGRESSION-WATCH: schedule event count is ALWAYS 1, regardless of damage value', () => {
    for (const damage of [1, 5, 20, 100, 999]) {
      const sched = scheduleHitscanDamage({
        x: 0, y: 0, damage, tag: `shot-${damage}`,
        splitIntervalMs: 33.33,
        clockNowMs: 1000,
      });
      expect(sched.logs.length, `damage=${damage}`).toBe(1);
      expect(sched.logs[0].tag).toBe('damage_number_scheduled');
    }
  });
});
