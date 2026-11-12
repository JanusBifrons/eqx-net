import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TickBudgetTelemetry,
  TICK_HITCH_THRESHOLD_MS,
  SAMPLE_EMIT_CADENCE,
} from './TickBudgetTelemetry.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';

vi.mock('../debug/ServerEventLog.js', () => ({
  serverLogEvent: vi.fn(),
  getRecentEvents: vi.fn(() => []),
  clearEvents: vi.fn(),
}));

const mockedLog = serverLogEvent as unknown as ReturnType<typeof vi.fn>;

describe('TickBudgetTelemetry', () => {
  function ctx(serverTick = 1, workerTickMs = 1) {
    return {
      serverTick,
      workerTickMs,
      playerCount: 1,
      swarmCount: 0,
      aiSize: 0,
      liveProjectileCount: 0,
    };
  }

  // Scripted clock (root CLAUDE.md "Gate on counts, compare timings"):
  // every duration below is injected, never measured, so no assertion
  // depends on how fast the host runs. The old real busy-wait let a stalled
  // CI worker push a "3 ms" tick past TICK_HITCH_THRESHOLD_MS, firing an
  // unexpected tick_hitch and failing the "no hitch" (no event) asserts.
  let clockMs = 0;
  function advance(ms: number): void {
    clockMs += ms;
  }

  beforeEach(() => {
    mockedLog.mockClear();
    clockMs = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('phaseTime accumulates per-phase elapsed time without emitting events', () => {
    const t = new TickBudgetTelemetry();
    t.beginTick(performance.now());
    advance(2);
    t.phaseTime('sabRead');
    advance(1);
    t.phaseTime('projectiles');
    const totalMs = t.endTick(ctx());
    expect(totalMs).toBe(3);
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('endTick returns totalMs measured from beginTick', () => {
    const t = new TickBudgetTelemetry();
    t.beginTick(performance.now());
    advance(3);
    const totalMs = t.endTick(ctx());
    expect(totalMs).toBe(3);
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('fires tick_hitch when totalMs exceeds the threshold', () => {
    const t = new TickBudgetTelemetry();
    t.beginTick(performance.now());
    advance(TICK_HITCH_THRESHOLD_MS + 2);
    t.phaseTime('sabRead');
    t.endTick(ctx(42));

    const hitchCalls = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_hitch');
    expect(hitchCalls).toHaveLength(1);
    const payload = hitchCalls[0]![1] as Record<string, unknown>;
    expect(payload['serverTick']).toBe(42);
    expect((payload['phases'] as Record<string, number>)['sabRead']).toBe(TICK_HITCH_THRESHOLD_MS + 2);
  });

  it('rate-limits tick_hitch events via the cooldown window', () => {
    const t = new TickBudgetTelemetry();
    // First hitch fires.
    t.beginTick(performance.now());
    advance(TICK_HITCH_THRESHOLD_MS + 2);
    t.endTick(ctx(1));
    let hitches = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_hitch');
    expect(hitches).toHaveLength(1);

    // Immediate second hitch (well under TICK_HITCH_MIN_INTERVAL_MS) is suppressed.
    t.beginTick(performance.now());
    advance(TICK_HITCH_THRESHOLD_MS + 2);
    t.endTick(ctx(2));
    hitches = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_hitch');
    expect(hitches).toHaveLength(1);
    expect((hitches[0]![1] as Record<string, unknown>)['serverTick']).toBe(1);
  });

  it('emits tick_budget once SAMPLE_EMIT_CADENCE samples accumulate', () => {
    const t = new TickBudgetTelemetry();
    for (let i = 0; i < SAMPLE_EMIT_CADENCE - 1; i++) {
      t.beginTick(performance.now());
      t.phaseTime('sabRead');
      t.endTick(ctx(i));
    }
    expect(mockedLog.mock.calls.filter(([tag]) => tag === 'tick_budget')).toHaveLength(0);

    // 60th sample crosses the cadence and emits.
    t.beginTick(performance.now());
    t.phaseTime('sabRead');
    t.endTick(ctx(SAMPLE_EMIT_CADENCE));
    const budgetCalls = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_budget');
    expect(budgetCalls).toHaveLength(1);
    expect((budgetCalls[0]![1] as Record<string, unknown>)['sampleCount']).toBe(SAMPLE_EMIT_CADENCE);
  });

  it('resets sums after the aggregated tick_budget emit', () => {
    const t = new TickBudgetTelemetry();
    for (let i = 0; i < SAMPLE_EMIT_CADENCE; i++) {
      t.beginTick(performance.now());
      advance(0.5);
      t.phaseTime('sabRead');
      t.endTick(ctx(i));
    }
    const firstBudget = mockedLog.mock.calls.find(([tag]) => tag === 'tick_budget')!;
    const firstAvg = firstBudget[1]['avgMs'] as Record<string, number>;
    expect(firstAvg['sabRead']).toBe(0.5);

    // Run another 60 ticks with much smaller phases; averages must reset between emits.
    for (let i = 0; i < SAMPLE_EMIT_CADENCE; i++) {
      t.beginTick(performance.now());
      t.phaseTime('sabRead');
      t.endTick(ctx(SAMPLE_EMIT_CADENCE + i));
    }
    const budgetCalls = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_budget');
    expect(budgetCalls).toHaveLength(2);
    const secondAvg = budgetCalls[1]![1]['avgMs'] as Record<string, number>;
    expect(secondAvg['sabRead']).toBe(0);
  });
});

describe('TickBudgetTelemetry lateness (game time vs wall time)', () => {
  const P = 1000 / 60;
  let clockMs = 0;
  beforeEach(() => {
    mockedLog.mockClear();
    clockMs = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function runWindow(t: TickBudgetTelemetry, workerTickAt: (i: number) => number, droppedAt: (i: number) => number): Record<string, unknown> {
    for (let i = 0; i < SAMPLE_EMIT_CADENCE; i++) {
      t.beginTick(performance.now());
      clockMs += P; // each update spans one wall tick: the window is 1 s
      t.endTick({
        serverTick: i, workerTickMs: 1, playerCount: 1, swarmCount: 0, aiSize: 0,
        liveProjectileCount: 0, workerTick: workerTickAt(i), workerDroppedTicks: droppedAt(i),
      });
    }
    const calls = mockedLog.mock.calls.filter(([tag]) => tag === 'tick_budget');
    return calls[calls.length - 1]![1] as Record<string, unknown>;
  }

  it('a worker keeping pace reports zero lateness', () => {
    const t = new TickBudgetTelemetry();
    const p = runWindow(t, (i) => 100 + i + 1, () => 0);
    expect(p['wallTicks']).toBe(60);
    expect(p['simTicks']).toBe(59); // anchored at the first update's tick
    expect(p['droppedTicks']).toBe(0);
    expect(t.lateness().latenessTicks).toBe(1);
  });

  it('a starved worker (half speed, ticks dropped) shows as lateness, not cost', () => {
    const t = new TickBudgetTelemetry();
    // 30 game ticks in 1 s of wall time, 25 of the missing ones dropped.
    const p = runWindow(t, (i) => 100 + Math.floor((i + 1) / 2), (i) => (i === SAMPLE_EMIT_CADENCE - 1 ? 25 : 0));
    expect(p['wallTicks']).toBe(60);
    expect(p['simTicks']).toBe(30);
    expect(p['latenessTicks']).toBe(30);
    expect(p['droppedTicks']).toBe(25);
    // Cheap ticks: cost alone (overBudgetCount) would never have seen this.
    expect(p['overBudgetCount']).toBe(0);
  });

  it('omits the lateness fields when the caller has no worker tick', () => {
    const t = new TickBudgetTelemetry();
    for (let i = 0; i < SAMPLE_EMIT_CADENCE; i++) {
      t.beginTick(performance.now());
      t.endTick({ serverTick: i, workerTickMs: 1, playerCount: 1, swarmCount: 0, aiSize: 0, liveProjectileCount: 0 });
    }
    const p = mockedLog.mock.calls.find(([tag]) => tag === 'tick_budget')![1] as Record<string, unknown>;
    expect(p['latenessTicks']).toBeUndefined();
  });
});
