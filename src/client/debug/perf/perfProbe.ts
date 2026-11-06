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
import { perfSceneById } from '@shared-types/perf/perfScenes';

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

/**
 * Perf lab (phone or desktop, `?perfscene=<id>`): once the loading curtain
 * lifts, frame the scene's camera, measure for the scene's window, then post
 * the reading to the server (`POST /dev/perf/client`) so Claude reads it.
 * The person watching only judges how it looks. A small chip shows the
 * countdown (updated once a second) and a link back to the scene list.
 */
let labStarted = false;

export function runPerfLabScene(sceneId: string): void {
  if (labStarted) return; // a remounted game surface must not start a second window
  labStarted = true;
  const scene = perfSceneById(sceneId);
  if (!scene || !current) return;
  const cur = current;
  const chip = document.createElement('div');
  chip.setAttribute('data-testid', 'perf-lab-chip');
  chip.style.cssText = 'position:fixed;left:50%;top:max(8px,env(safe-area-inset-top));transform:translateX(-50%);z-index:3000;'
    + 'font:600 11px system-ui,sans-serif;color:#cfe;background:rgba(5,7,13,.75);border:1px solid #2a3a4a;border-radius:10px;padding:4px 10px;';
  chip.textContent = `${scene.title} · loading…`;
  document.body.appendChild(chip);

  const lifted = (): boolean => document.querySelector('[data-testid="warp-screen"][data-warp-visible="0"]') !== null;
  const start = async (): Promise<void> => {
    // Frame the scene for this screen: the catalogue zoom is for a 1920×1080
    // view, so scale by the SHORT side (portrait phones keep the action large).
    const fit = Math.min(window.innerWidth, window.innerHeight) / 1080;
    cur.renderer.setCameraScript([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: scene.camera.x, y: scene.camera.y, zoom: scene.camera.zoom * fit } }]);
    const perf = (globalThis as unknown as { __eqxPerf: { reset(): Promise<void>; read(): Promise<PerfReading> } }).__eqxPerf;
    await perf.reset();
    const endAt = performance.now() + scene.durationMs;
    const tick = setInterval(() => {
      chip.textContent = `${scene.title} · ${Math.max(0, Math.ceil((endAt - performance.now()) / 1000))} s`;
    }, 1000);
    await new Promise((r) => setTimeout(r, scene.durationMs));
    clearInterval(tick);
    const reading = await perf.read();
    const body = {
      scene: scene.id,
      device: {
        userAgent: navigator.userAgent, width: window.innerWidth, height: window.innerHeight,
        dpr: window.devicePixelRatio, touch: navigator.maxTouchPoints > 0, worker: cur.useWorker,
      },
      reading,
    };
    const ok = await fetch('/dev/perf/client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.ok).catch(() => false);
    chip.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = ok ? 'Done, numbers sent ✓ ' : 'Done (could not send numbers) ';
    const back = document.createElement('a');
    back.href = '/__perf-lab__/index.html';
    back.textContent = 'Next scene ›';
    back.style.cssText = 'color:#7cf;margin-left:6px;';
    chip.append(msg, back);
  };
  const wait = setInterval(() => { if (lifted()) { clearInterval(wait); void start(); } }, 500);
}
