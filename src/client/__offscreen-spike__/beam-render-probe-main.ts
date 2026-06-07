/**
 * Live-beam render integration probe — MAIN-THREAD PixiRenderer.
 *
 * The laser-detach regression lock (Invariant #13, cause #1). Unlike the wreck /
 * damage probes (which use WorkerRendererClient to test the worker IPC), this
 * mounts the MAIN-THREAD `PixiRenderer` directly so the test can read the REAL
 * drawn beam sprite transform via `renderer.getLiveBeamTransform()` (the worker
 * hosts its pool off-window).
 *
 * WHY A PROBE (not the full game): the bug lives in `PixiRenderer.update()`'s
 * live-beam block — it gated `BeamSpritePool.setBeams` behind a per-frame dirty
 * flag, so coasting under BEAM_EPSILON (4 u/frame) froze the drawn beam while the
 * ship flew on. Driving `update()` SYNCHRONOUSLY here (one explicit call per
 * "frame") reproduces that deterministically and is immune to the headless
 * software-WebGL RAF-throttling that desyncs a full-game worker=0 E2E (the
 * render loop runs far slower than wall-clock physics under swiftshader, so the
 * drawn beam desyncs from the ship regardless of the fix — making that path
 * useless as a headless CI lock; see diag/laser-repro/ for the real-game visual
 * proof). Here every `postFrame()` is a synchronous `update(mirror)` and we read
 * the sprite's JS transform, which `setBeams` writes regardless of GPU paint.
 *
 * The probe drives a single interceptor (twin wing beams) at a hand-authored
 * sub-4-u/frame coast — the CONFIRMED triggering motion (diag/laser-repro/).
 */
import { PixiRenderer } from '../render/PixiRenderer';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';

const logEl = document.getElementById('log') as HTMLPreElement;
const host = document.getElementById('host') as HTMLDivElement;

function log(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.prepend(line);
}

const LOCAL = 'probe-player';

function makeMirror(): RenderMirror {
  return {
    ships: new Map(),
    localPlayerId: LOCAL,
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

interface BeamProbeApi {
  /** Move the local ship (mutates the persistent mirror in place). */
  setShip: (x: number, y: number, angle: number) => void;
  /** Turn the twin wing beams on/off (populates mirror.liveBeams). */
  setBeamActive: (active: boolean) => void;
  /** One synchronous render frame. */
  postFrame: () => void;
  /** The ACTUAL drawn beam[0] origin (game space) + count, or null. */
  getDrawnOrigin: () => { count: number; fromX: number; fromY: number } | null;
  /** The current ship pose (diagnostic). */
  getShip: () => { x: number; y: number; angle: number };
}

declare global {
  interface Window {
    __beamProbe?: BeamProbeApi;
  }
}

async function main(): Promise<void> {
  const renderer = new PixiRenderer();
  const mirror = makeMirror();
  const ship: ShipRenderState = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'interceptor' };
  mirror.ships.set(LOCAL, ship);

  log('[boot] init(host)…');
  try {
    await renderer.init(host);
    log('[ready] PixiRenderer booted (main thread)');
  } catch (err) {
    log(`[error] init failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  window.__beamProbe = {
    setShip: (x, y, angle): void => {
      ship.x = x;
      ship.y = y;
      ship.angle = angle;
    },
    setBeamActive: (active): void => {
      mirror.liveBeams!.clear();
      if (active) {
        // interceptor mount ids — see src/shared-types/shipKinds/heavyClass.ts
        mirror.liveBeams!.set('wing-l', { dist: 250 });
        mirror.liveBeams!.set('wing-r', { dist: 250 });
      }
    },
    postFrame: (): void => {
      renderer.update(mirror);
    },
    getDrawnOrigin: (): { count: number; fromX: number; fromY: number } | null =>
      renderer.getLiveBeamTransform(),
    getShip: (): { x: number; y: number; angle: number } => ({ x: ship.x, y: ship.y, angle: ship.angle }),
  };

  log('[probe] window.__beamProbe ready');
}

void main();
