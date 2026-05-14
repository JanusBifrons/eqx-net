/**
 * Wreck render integration probe — main thread.
 *
 * Mirrors the `damage-number-probe-main.ts` pattern: builds a persistent
 * mirror with a stable `wrecks` Map ref, posts it to a real
 * WorkerRendererClient each "frame", and exposes a `window.__wreckProbe`
 * API for Playwright to drive.
 *
 * THE LIFECYCLE THIS PROBE EXERCISES:
 *   - Add a wreck to `mirror.wrecks` → post frame → renderer creates
 *     a sprite → feedback.wreckSpriteCount becomes 1.
 *   - Remove the wreck from `mirror.wrecks` → post frame → renderer
 *     unmounts the sprite → feedback.wreckSpriteCount returns to 0.
 *
 * Phase A8 of `humble-strolling-coral.md`. Locking shipped behaviour.
 */
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import type { RenderMirror, WreckRenderState } from '@core/contracts/IRenderer';

const logEl = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('host') as HTMLDivElement;

function log(msg: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.textContent = `${stamp} ${msg}`;
  logEl.prepend(line);
}

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

interface WreckProbeApi {
  /** Add (or overwrite) a wreck in the persistent mirror. */
  pushWreck: (shipInstanceId: string, x: number, y: number) => void;
  /** Remove a wreck from the persistent mirror. */
  removeWreck: (shipInstanceId: string) => void;
  /** Post the mirror to the renderer (simulates one rAF tick). */
  postFrame: () => void;
  /** Read the cached `wreckSpriteCount` from main-thread feedback. */
  getWreckSpriteCount: () => number;
  /** Inspect the persistent mirror's wreck map size — diagnostic. */
  getMirrorWreckCount: () => number;
}

declare global {
  interface Window {
    __wreckProbe?: WreckProbeApi;
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

  window.__wreckProbe = {
    pushWreck: (shipInstanceId: string, x: number, y: number): void => {
      const wreck: WreckRenderState = {
        shipInstanceId,
        x,
        y,
        vx: 0,
        vy: 0,
        angle: 0,
        angvel: 0,
        kind: 'fighter',
        health: 50,
        maxHealth: 100,
      };
      mirror.wrecks!.set(shipInstanceId, wreck);
    },
    removeWreck: (shipInstanceId: string): void => {
      mirror.wrecks!.delete(shipInstanceId);
    },
    postFrame: (): void => {
      renderer.update(mirror);
    },
    getWreckSpriteCount: (): number => renderer.getFeedback().wreckSpriteCount,
    getMirrorWreckCount: (): number => mirror.wrecks?.size ?? 0,
  };

  log('[probe] window.__wreckProbe ready');
}

void main();
