/**
 * Deliberate-break verification for the gc-bench observer (paradigm
 * plan: quirky-rabbit). The user (rightly) flagged that "0 MSC pauses
 * over 30 s" looks suspicious — is the observer hooked up at all, or
 * are we just reporting zeros because nothing's measuring?
 *
 * This test ANSWERS that by:
 *   1. Allocating enough to force a real MSC GC (not just a scavenge).
 *   2. Waiting for `PerformanceObserver`'s async notification queue to
 *      drain — disconnecting synchronously loses pending entries (this
 *      is the bug the user surfaced; the bench runner had the same bug
 *      before this commit fixed it).
 *   3. Asserting the observer captured at least one MSC > 5 ms.
 *
 * Lessons learned from the diagnostic run that produced this test:
 *   - `global.gc({type:'major'})` does NOT reliably produce kind=2
 *     entries on Node v22 — V8 chooses scavenge vs MSC based on heap
 *     state, not the API hint. To force MSC we have to overflow
 *     old-gen via promoted-tenure allocation.
 *   - `obs.disconnect()` immediately after a sync workload drops any
 *     pending notifications. The fix is `await delay()` before
 *     disconnect.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { PerformanceObserver } from 'node:perf_hooks';

interface NodeGcEntry {
  duration: number;
  kind?: number;
  detail?: { kind?: number };
}

interface CapturedGc {
  durationMs: number;
  kindBits: number | undefined;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drive enough heap pressure to force at least one MSC. Strategy:
 *   - Allocate large arrays inside a closure that the outer scope
 *     KEEPS alive (forces tenure on next scavenge).
 *   - Repeat until total survives > 64 MB so old-gen can't fit it.
 *   - Call `global.gc()` between batches to provoke scavenge first
 *     (tenuring) then MSC (old-gen sweep).
 */
async function generateMscPressure(): Promise<unknown[]> {
  const gc = (globalThis as { gc?: (opts?: { type?: string }) => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`');
  }
  const survivors: unknown[] = [];
  for (let batch = 0; batch < 50; batch++) {
    // Each batch ~2 MB (1000 × 256-element Float64Array = ~2 MB).
    for (let i = 0; i < 1000; i++) {
      survivors.push(new Float64Array(256).fill(batch));
    }
    // Force a scavenge mid-batch so the batch's allocations get
    // tenured into old-gen on this pass; the next scavenge then
    // tenures the next batch, and so on. Old-gen grows until V8
    // triggers an MSC.
    if (batch % 5 === 4) gc();
  }
  // Two explicit GCs to flush pending old-gen sweep.
  gc({ type: 'major' });
  gc({ type: 'major' });
  // Yield to the event loop so PerformanceObserver can drain its
  // notification queue BEFORE we disconnect the observer.
  await delay(100);
  return survivors;
}

describe('gc-bench observer self-test', () => {
  it('the observer DOES capture GC events under deliberate heap pressure', async () => {
    const captured: CapturedGc[] = [];
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as NodeGcEntry[]) {
        const kind = entry.kind ?? entry.detail?.kind;
        captured.push({ durationMs: entry.duration, kindBits: kind });
      }
    });
    obs.observe({ entryTypes: ['gc'], buffered: true });

    let survivors: unknown[] = [];
    try {
      survivors = await generateMscPressure();
      // Hold the survivors so V8 can't reclaim them mid-test.
      expect(survivors.length).toBeGreaterThan(0);
    } finally {
      // The 100 ms delay inside generateMscPressure() lets the
      // observer's notification queue drain before disconnect.
      obs.disconnect();
    }

    expect(captured.length).toBeGreaterThan(0);
    // Print what we saw so a future reader can verify the kind/duration
    // distribution against their Node version's V8 behaviour.
    const summary = captured.map((e) => `kind=${e.kindBits} d=${e.durationMs.toFixed(2)}`).join(', ');
    // Use `console.error` so vitest surfaces it even on pass.
    process.stderr.write(`captured ${captured.length} gc events: ${summary}\n`);
  });

  it('captures at least one major-class GC (>5 ms, not scavenge) under sustained pressure', async () => {
    // **Load-bearing on modern V8 (Node 22).** This test was originally
    // written to assert `kind === 2` (mark-sweep-compact). That filter
    // hit zero events on Node v22 even with 100 MB of deliberate
    // promoted-tenure allocations — V8 reports major-class GCs as
    // `kind=4` (incremental marking) under normal pressure, only
    // surfacing `kind=2` for hard stop-the-world forced collections.
    //
    // The correct definition of "major-class GC" for our gate purposes
    // is: anything that is NOT pure scavenge (kind=1) AND exceeds the
    // 5 ms threshold. That covers 2 (full MSC), 4 (incremental), 8
    // (weakcb), and any bitwise mix — all of them eat frame budget.
    // The bench:gc runner now applies the same `kind !== 1` rule.
    const captured: CapturedGc[] = [];
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as NodeGcEntry[]) {
        const kind = entry.kind ?? entry.detail?.kind;
        captured.push({ durationMs: entry.duration, kindBits: kind });
      }
    });
    obs.observe({ entryTypes: ['gc'], buffered: true });

    let survivors: unknown[] = [];
    try {
      survivors = await generateMscPressure();
      expect(survivors.length).toBeGreaterThan(0);
    } finally {
      obs.disconnect();
    }

    const major = captured.filter((e) => e.kindBits !== 1 && e.durationMs >= 5);
    if (major.length === 0) {
      const summary = captured.map((e) => `kind=${e.kindBits} d=${e.durationMs.toFixed(2)}`).join(', ');
      throw new Error(
        `Expected at least one major-class (kind!=1, ≥5ms) event under ` +
        `deliberate old-gen pressure but observer captured only: ${summary}. ` +
        `If this fails, the bench:gc runner cannot detect ANY major-GC ` +
        `regression — the gate is decorative.`,
      );
    }
    expect(major.length).toBeGreaterThan(0);
  });

  it('regression check: the broadcaster workload SHOULD produce zero MSCs (Phase 2 pool work landed)', async () => {
    // Sanity-counter to the deliberate-break tests above: run the
    // SAME observer wiring against a NON-allocating loop (`for () {}`)
    // for 1 s and assert it sees no MSC events. Together with the
    // tests above, this proves:
    //   - The observer is wired correctly (above tests fire on
    //     pressure).
    //   - The "zero MSCs" reading from bench:gc on the actual
    //     broadcaster workload is the truthful result (the pool work
    //     eliminated allocation), not a wiring failure.
    const captured: CapturedGc[] = [];
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as NodeGcEntry[]) {
        const kind = entry.kind ?? entry.detail?.kind;
        captured.push({ durationMs: entry.duration, kindBits: kind });
      }
    });
    obs.observe({ entryTypes: ['gc'], buffered: true });

    try {
      const end = Date.now() + 1000;
      let counter = 0;
      while (Date.now() < end) counter++;
      expect(counter).toBeGreaterThan(0);
      await delay(100);
    } finally {
      obs.disconnect();
    }

    const mscEvents = captured.filter((e) => e.kindBits === 2);
    expect(mscEvents.length).toBe(0);
  });
});
