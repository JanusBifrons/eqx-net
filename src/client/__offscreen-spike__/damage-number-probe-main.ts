/**
 * Damage-number lifetime integration probe — main thread.
 *
 * Simulates the real gameplay flow: ColyseusClient pushes events into
 * `mirror.pendingDamageNumbers` (a persistent array reference); App.tsx
 * loop posts `gameClient.mirror` every frame. The renderer is expected
 * to drain the queue once per damage event — not re-spawn the same
 * event on every frame.
 *
 * Exposes `window.__damageProbe` so a Playwright spec can:
 *   1. Push a damage event into the persistent mirror.
 *   2. Post `currentMirror` multiple times (simulating the rAF loop).
 *   3. Read `renderer.getFeedback().damageNumberActiveCount`.
 *
 * THE BUG this exercises: `PixiRenderer.update()` clears
 * `mirror.pendingDamageNumbers.length = 0` after draining. In the
 * worker path that mutates a STRUCTURED-CLONE on the worker side; the
 * main-thread mirror's array is untouched. Without explicit drain in
 * `WorkerRendererClient.update()`, the same damage event is re-posted
 * every frame, and the worker re-spawns the damage number every
 * frame. Visual symptom: numbers never disappear.
 */
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import type { RenderMirror } from '@core/contracts/IRenderer';

const logEl = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('host') as HTMLDivElement;

function log(msg: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.textContent = `${stamp} ${msg}`;
  logEl.prepend(line);
}

/** Build a persistent mirror with stable array refs for the drain queues. */
function makePersistentMirror(): RenderMirror {
  return {
    ships: new Map(),
    localPlayerId: null,
    swarm: new Map(),
    wrecks: new Map(),
    lingeringShips: new Map(),
    projectiles: new Map(),
    boostingShips: new Set(),
    thrustingShips: new Set(),
    explodingShips: new Set(),
    pendingDamageNumbers: [],
    pendingHealthBarHits: [],
    liveBeams: new Map(),
  };
}

interface DamageProbeApi {
  /** Push a damage event into the persistent mirror's pending queue. */
  pushDamage: (x: number, y: number, damage: number) => void;
  /** Post the persistent mirror to the renderer (simulating one rAF tick). */
  postFrame: () => void;
  /** Read the cached `damageNumberActiveCount` from main-thread feedback. */
  getActiveCount: () => number;
  /** Inspect the persistent mirror's pending-damage queue length —
   *  diagnostic for the worker-drain regression. */
  getPendingQueueLength: () => number;
}

declare global {
  interface Window {
    __damageProbe?: DamageProbeApi;
  }
}

async function main(): Promise<void> {
  const renderer = new WorkerRendererClient();
  const mirror = makePersistentMirror();

  log('[boot] init(host)…');
  try {
    await renderer.init(host);
    log('[ready] worker booted');
  } catch (err) {
    log(`[error] init failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  window.__damageProbe = {
    pushDamage: (x: number, y: number, damage: number): void => {
      mirror.pendingDamageNumbers!.push({ x, y, damage });
    },
    postFrame: (): void => {
      renderer.update(mirror);
    },
    getActiveCount: (): number => renderer.getFeedback().damageNumberActiveCount,
    getPendingQueueLength: (): number => mirror.pendingDamageNumbers?.length ?? 0,
  };

  log('[probe] window.__damageProbe ready');
}

void main();
