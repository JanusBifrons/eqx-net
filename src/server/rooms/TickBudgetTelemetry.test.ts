import { describe, it, expect } from 'vitest';
import { TickBudgetTelemetry } from './TickBudgetTelemetry.js';

describe('TickBudgetTelemetry', () => {
  function makeRecorder() {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logEvent = (event: string, payload: Record<string, unknown>): void => {
      events.push({ event, payload });
    };
    return { events, logEvent };
  }

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

  it('mark() accumulates per-phase elapsed time', () => {
    const { events, logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    t.startTick();
    busyWait(2); // 2 ms in sabRead
    t.mark('sabRead');
    busyWait(1); // 1 ms in projectiles
    t.mark('projectiles');
    const m = t.finishMeasurement(ctx());
    expect(m.totalMs).toBeGreaterThanOrEqual(2.5);
    expect(m.busiestMs).toBeGreaterThanOrEqual(m.totalMs);
    expect(events).toHaveLength(0); // no hitch on a 3 ms tick, no aggregated emit yet
  });

  it('finishMeasurement returns busiestMs = max(totalMs, workerTickMs)', () => {
    const { logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    t.startTick();
    busyWait(1);
    const m1 = t.finishMeasurement(ctx(1, 50)); // worker dominates
    expect(m1.busiestMs).toBe(50);
    expect(m1.busiestMs).toBeGreaterThan(m1.totalMs);

    t.startTick();
    busyWait(1);
    const m2 = t.finishMeasurement(ctx(2, 0)); // server dominates
    expect(m2.busiestMs).toBe(m2.totalMs);
  });

  it('fires tick_hitch when totalMs exceeds threshold', () => {
    const { events, logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    t.startTick();
    busyWait(TickBudgetTelemetry.TICK_HITCH_THRESHOLD_MS + 2);
    t.mark('sabRead');
    t.finishMeasurement(ctx(42));
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('tick_hitch');
    expect(events[0]!.payload['serverTick']).toBe(42);
    expect((events[0]!.payload['phases'] as Record<string, number>)['sabRead']).toBeGreaterThan(0);
  });

  it('rate-limits tick_hitch events via TICK_HITCH_MIN_INTERVAL_MS', () => {
    const { events, logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    // First hitch fires.
    t.startTick();
    busyWait(TickBudgetTelemetry.TICK_HITCH_THRESHOLD_MS + 2);
    t.finishMeasurement(ctx(1));
    expect(events).toHaveLength(1);
    // Immediate second hitch (under the rate-limit window) is suppressed.
    t.startTick();
    busyWait(TickBudgetTelemetry.TICK_HITCH_THRESHOLD_MS + 2);
    t.finishMeasurement(ctx(2));
    expect(events).toHaveLength(1);
  });

  it('emits tick_budget only after SAMPLE_EMIT_CADENCE samples accumulate', () => {
    const { events, logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    for (let i = 0; i < TickBudgetTelemetry.SAMPLE_EMIT_CADENCE - 1; i++) {
      t.startTick();
      t.mark('sabRead');
      t.finishMeasurement(ctx(i));
      t.recordSample({ serverTick: i, playerCount: 1, swarmCount: 0, aiSize: 0 });
    }
    expect(events).toHaveLength(0);

    // 60th sample: emits.
    t.startTick();
    t.mark('sabRead');
    t.finishMeasurement(ctx(60));
    t.recordSample({ serverTick: 60, playerCount: 1, swarmCount: 0, aiSize: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('tick_budget');
    expect(events[0]!.payload['sampleCount']).toBe(TickBudgetTelemetry.SAMPLE_EMIT_CADENCE);
  });

  it('recordSample resets sums after emit', () => {
    const { events, logEvent } = makeRecorder();
    const t = new TickBudgetTelemetry(logEvent);
    for (let i = 0; i < TickBudgetTelemetry.SAMPLE_EMIT_CADENCE; i++) {
      t.startTick();
      busyWait(0.5);
      t.mark('sabRead');
      t.finishMeasurement(ctx(i));
      t.recordSample({ serverTick: i, playerCount: 1, swarmCount: 0, aiSize: 0 });
    }
    const first = events[0]!.payload['avgMs'] as Record<string, number>;
    expect(first['sabRead']).toBeGreaterThan(0);
    // Run another 60 ticks of much-smaller phases; averages should reset between emits.
    for (let i = 0; i < TickBudgetTelemetry.SAMPLE_EMIT_CADENCE; i++) {
      t.startTick();
      t.mark('sabRead');
      t.finishMeasurement(ctx(60 + i));
      t.recordSample({ serverTick: 60 + i, playerCount: 1, swarmCount: 0, aiSize: 0 });
    }
    expect(events).toHaveLength(2);
    const second = events[1]!.payload['avgMs'] as Record<string, number>;
    expect(second['sabRead']).toBeLessThan(first['sabRead']!);
  });
});

function busyWait(ms: number): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { /* spin */ }
}
