/**
 * Lingering-hull render integration probe — main thread (WS-12 / R2.32).
 *
 * The bug: a lingering (parked) hull rendered as a bare silhouette with NO
 * weapon barrels and NO shield aura, because `PixiRenderer.updateLingeringShips`
 * never built a `MountVisualManager` cluster for it and the shield-aura sync
 * never iterated `mirror.lingeringShips`. That bug lives across the
 * `WorkerRendererClient ↔ renderer.worker` structured-clone boundary (the
 * production touch default is the worker path, and `mirror.lingeringShips` is
 * cloned across postMessage every frame), so per Invariant #13 the lock MUST
 * cross that boundary — a bare `PixiRenderer` unit would not.
 *
 * This probe constructs a REAL `WorkerRendererClient`, seeds a lingering hull in
 * a persistent mirror, posts it across several frames, and exposes the actual
 * drawn-artefact signal — `getFeedback().mountCounts` (populated from the real
 * `MountVisualManager` cluster) — so a Playwright spec can assert the parked
 * hull's barrels render (mount count > 0). Modelled on `damage-number-probe`.
 */
import { WorkerRendererClient } from '../render/worker/WorkerRendererClient';
import type { RenderMirror } from '@core/contracts/IRenderer';

const logEl = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('host') as HTMLDivElement;

function log(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.prepend(line);
}

const LINGER_ID = 'linger-probe-1';

function makePersistentMirror(): RenderMirror {
  return {
    ships: new Map(),
    localPlayerId: null,
    swarm: new Map(),
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

interface LingerProbeApi {
  /** Seed (or refresh) a lingering hull. `interceptor` has two wing mounts. */
  seedLingering: (shieldDown: boolean) => void;
  /** Post the persistent mirror to the renderer (one rAF tick). */
  postFrame: () => void;
  /** The REAL drawn mount-cluster size for the lingering hull (0 = no barrels). */
  getMountCount: () => number;
  /** The REAL count of DRAWN shield-aura rings (0 = aura registered but never
   *  positioned — the P3.12 lingering-aura bug). */
  getShieldRingCount: () => number;
}

declare global {
  interface Window {
    __lingerProbe?: LingerProbeApi;
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

  window.__lingerProbe = {
    seedLingering: (shieldDown: boolean): void => {
      mirror.lingeringShips!.set(LINGER_ID, {
        x: 0, y: 0, vx: 0, vy: 0, angle: 0,
        kind: 'interceptor',
        shieldDown,
        ownerPlayerId: 'owner-1',
      });
    },
    postFrame: (): void => {
      renderer.update(mirror);
    },
    getMountCount: (): number => renderer.getFeedback().mountCounts.get(LINGER_ID) ?? 0,
    getShieldRingCount: (): number => renderer.getFeedback().shieldRingVisibleCount,
  };

  log('[probe] window.__lingerProbe ready');
}

void main();
