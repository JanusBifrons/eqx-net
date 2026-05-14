/**
 * Phase 4 verification probe — boot the production WorkerRendererClient
 * against the real renderer.worker.ts, send a synthetic mirror with one
 * ship, verify FEEDBACK comes back.
 *
 * Loaded by `renderer-probe.html`. Driven by
 * `tests/e2e/renderer-worker-probe.spec.ts` for autonomous iteration.
 */
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import type { RenderMirror } from '@core/contracts/IRenderer';

const logEl = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('host') as HTMLDivElement;

function log(line: string, cls: 'pass' | 'fail' | 'info' = 'info'): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = `${stamp} ${line}\n`;
  logEl.prepend(span);
}

window.addEventListener('error', (e: ErrorEvent) => {
  log(`[uncaught] ${e.message}`, 'fail');
});

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  log(`[unhandled] ${String(e.reason)}`, 'fail');
});

async function main(): Promise<void> {
  log('[boot] constructing WorkerRendererClient');
  const renderer = new WorkerRendererClient();

  try {
    log('[boot] init(host)…');
    await renderer.init(host);
    log('[ready] worker booted via WorkerRendererClient', 'pass');
  } catch (err) {
    log(`[error] init failed: ${err instanceof Error ? err.message : String(err)}`, 'fail');
    return;
  }

  // Build a synthetic mirror with one ship.
  const mirror: RenderMirror = {
    ships: new Map([
      ['local-player', {
        x: 100,
        y: 50,
        angle: 0,
        kind: 'fighter',
        displayName: 'Probe Ship',
      }],
    ]),
    localPlayerId: 'local-player',
    serverTick: 1,
    swarm: new Map(),
    wrecks: new Map(),
    lingeringShips: new Map(),
    projectiles: new Map(),
    serverGhostX: 0,
    serverGhostY: 0,
    serverGhostVisible: false,
    boostingShips: new Set(),
    thrustingShips: new Set(),
    explodingShips: new Set(),
    pendingDamageNumbers: [],
    pendingHealthBarHits: [],
    liveBeams: new Map(),
  };

  log('[update] posting MIRROR_UPDATE with 1 ship');
  renderer.update(mirror);

  // Wait a tick for the worker to receive + process + post FEEDBACK back.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const fb = renderer.getFeedback();
  log(`[feedback] mountCounts.size=${fb.mountCounts.size}, haloArrowCount=${fb.haloArrowCount}`, 'pass');

  // Send a second frame with the ship moved — proves the worker can
  // process sequential updates without leaking.
  mirror.ships.get('local-player')!.x = 200;
  renderer.update(mirror);
  await new Promise((resolve) => setTimeout(resolve, 100));

  log('[done] probe complete', 'pass');
}

void main();
