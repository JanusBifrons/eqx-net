/**
 * Perf-scene probe (plan prancy-squishing-donut P2). Off unless the URL has
 * `?perfprobe=1`, so players and every other test pay nothing (and the
 * webdriver flag never switches it on — LESSONS: gate per-frame diag on a URL
 * param).
 *
 * `window.__eqxPerf.reset()` starts a measurement window; `read()` returns it:
 *  - main: the main thread's frame interval (rAF to rAF). On a phone this is
 *    what the player sees; on desktop the worker draws, so read `render` too.
 *  - render: the renderer's per-frame cost on whichever thread it runs.
 *  - long tasks (> 50 ms on the main thread) and heap. Network bytes are
 *    counted by the runner from DevTools network events (exact, any device).
 */
import type { IRenderer, RenderPerfReading } from '@core/contracts/IRenderer';
import { FrameTimeRing, type FrameTimeSummary } from '@core/perf/FrameTimeRing';

export interface PerfReading {
  elapsedMs: number;
  main: FrameTimeSummary;
  render: RenderPerfReading | null;
  longTasks: number;
  longTaskMs: number;
  heapMb: number | null;
  worker: boolean;
}

export function perfProbeEnabled(search: string): boolean {
  return new URLSearchParams(search).get('perfprobe') === '1';
}

let current: { renderer: IRenderer; useWorker: boolean } | null = null;

export function installPerfProbe(rendererIn: IRenderer, useWorkerIn: boolean): void {
  // A remounted game surface brings a new renderer: re-point, never re-wrap.
  if (current) { current.renderer = rendererIn; current.useWorker = useWorkerIn; void rendererIn.perfProbe?.('enable'); return; }
  const cur = (current = { renderer: rendererIn, useWorker: useWorkerIn });
  const ring = new FrameTimeRing();
  let t0 = performance.now();
  let last = 0;
  let longTasks = 0, longTaskMs = 0;

  // Fault injection for the runner's self-test (`?perfburn=N`): busy-wait N ms a frame.
  const burnMs = Number(new URLSearchParams(location.search).get('perfburn') ?? 0);
  const frame = (now: number): void => {
    if (burnMs > 0) { const end = performance.now() + burnMs; while (performance.now() < end) { /* burn */ } }
    if (last > 0) ring.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks++; longTaskMs += e.duration; }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* longtask unsupported (Safari): stays 0 */ }


  void cur.renderer.perfProbe?.('enable');

  (globalThis as { __eqxPerf?: unknown }).__eqxPerf = {
    async reset(): Promise<void> {
      ring.reset();
      last = 0;
      longTasks = 0; longTaskMs = 0;
      await cur.renderer.perfProbe?.('enable');
      await cur.renderer.perfProbe?.('reset');
      t0 = performance.now();
    },
    async read(): Promise<PerfReading> {
      const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        elapsedMs: Math.round(performance.now() - t0),
        main: ring.summary(),
        render: (await cur.renderer.perfProbe?.('read')) ?? null,
        longTasks,
        longTaskMs: Math.round(longTaskMs),
        heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        worker: cur.useWorker,
      };
    },
  };
}
