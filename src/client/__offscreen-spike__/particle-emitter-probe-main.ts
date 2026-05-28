/**
 * `@pixi/particle-emitter` worker-compat spike — main entry point.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md`, milestone 0.5.
 *
 * Mirrors the 2026-05-14 `pixi-viewport` spike precedent: before depending on
 * a new Pixi ecosystem library in the OffscreenCanvas worker, prove it does
 * not touch DOM-only APIs (`document`, `window`, `addEventListener` on the
 * canvas's `events.domElement`). `pixi-viewport`'s Drag plugin called
 * `addEventListener` on `events.domElement` which is `undefined` in a worker
 * — the spike caught it before any production code imported the library.
 *
 * This probe boots a worker, transfers an `OffscreenCanvas`, has the worker
 * import `@pixi/particle-emitter`, instantiate one Emitter, advance it for
 * ~5 s, and report (a) no thrown `ReferenceError`, (b) non-zero particle
 * count, (c) the library's static-analysis result we already verified before
 * landing this file:
 *
 *   `grep -E '(document\.|window\.|addEventListener|navigator\.|location\.)' \
 *     node_modules/@pixi/particle-emitter/lib/particle-emitter.es.js`
 *
 * returns zero matches.
 *
 * Human-side verification: open this page in a real browser (Chrome / Safari
 * 17+) and watch the on-page log for "OK: emitter ticked N particles". If
 * the log shows "FAIL: <ReferenceError>", swap to `pixi-particles-pmsm` or
 * roll a sprite-pool emitter per the plan's fallback.
 */

const logEl = document.getElementById('log') as HTMLPreElement;
const canvas = document.getElementById('host') as HTMLCanvasElement;

function log(line: string, klass: 'ok' | 'err' | 'info' = 'info'): void {
  const div = document.createElement('div');
  div.className = klass;
  div.textContent = `${new Date().toISOString().slice(11, 23)} ${line}`;
  logEl.prepend(div);
}

log('booting worker + transferring OffscreenCanvas');

const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker(new URL('./particle-emitter-probe.worker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (e) => {
  const m = e.data as { type: string; particles?: number; error?: string };
  if (m.type === 'READY') log('worker booted; emitter constructed', 'ok');
  else if (m.type === 'TICK') log(`OK: emitter ticked ${m.particles ?? 0} particles`, 'ok');
  else if (m.type === 'ERROR') log(`FAIL: ${m.error}`, 'err');
};

worker.onerror = (e) => log(`worker error: ${e.message}`, 'err');

worker.postMessage({ type: 'BOOT', canvas: offscreen, width: canvas.width, height: canvas.height }, [offscreen]);
