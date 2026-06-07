/**
 * Engine-exhaust visual probe — main thread.
 *
 * Boots the production `PixiRenderer` DIRECTLY on the main thread (NOT
 * `WorkerRendererClient`). Two reasons this matters for the engine-particle
 * work:
 *   1. The OffscreenCanvas-in-worker path composites to a transferred canvas
 *      that Playwright captures as BLACK. The main-thread renderer composites
 *      to a visible canvas, so `page.screenshot()` captures real pixels.
 *   2. The X-mirror bug lives in the renderer's `getEntityPose` closure
 *      (`PixiRenderer.init`). Constructing the real `PixiRenderer` exercises
 *      that exact code path — a hand-rolled pose source would bypass the bug.
 *
 * Drives a single ship in a persistent `RenderMirror` so a Playwright spec can
 * set a fixed DIAGONAL heading (exposes the mirror; an axis-aligned ship hides
 * it), set a velocity (exercises speed-scaling), toggle thrust/boost, and run
 * a real RAF loop so a plume accumulates before the screenshot.
 *
 * Reachable in dev at /__offscreen-spike__/engine-particles-probe.html.
 * Production builds never include this file (Vite's `rollupOptions.input`
 * only lists the main `index.html`).
 */
import { PixiRenderer } from '../render/PixiRenderer';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';

const PROBE_ID = 'probe';

/** Build a persistent mirror with one local ship. Stable refs so the probe
 *  mutates pose/velocity in place between frames. */
function makeMirror(): RenderMirror {
  const ship: ShipRenderState = { x: 0, y: 0, angle: Math.PI / 4, vx: 0, vy: 0, kind: 'fighter' };
  return {
    ships: new Map([[PROBE_ID, ship]]),
    localPlayerId: PROBE_ID,
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

interface EngineProbeApi {
  /** Set the ship's world pose + kind. Angle is GAME-space radians; default
   *  scenario uses a diagonal so the X-mirror is visible. Kind is best set
   *  once (the sprite silhouette is cached by id after first render). */
  setShip: (x: number, y: number, angle: number, kind?: string) => void;
  /** Set the ship's velocity (game-space). Drives speed-scaling once the
   *  emitter reads it, and makes the ship travel (camera follows) so the
   *  plume trails realistically. */
  setVelocity: (vx: number, vy: number) => void;
  setThrust: (on: boolean) => void;
  setBoost: (on: boolean) => void;
  /** Drive a real RAF loop for `ms`, advancing the ship by its velocity each
   *  frame and calling `renderer.update(mirror)` so a plume accumulates. */
  runFor: (ms: number) => Promise<void>;
  /** Wipe live particles + emitter registrations + reset the ship to origin
   *  with no thrust/boost — call between capture scenarios for a clean frame. */
  reset: () => void;
  /** DEBUG: local ship + engine particle WORLD positions (camera-independent
   *  ground truth for the exhaust-side investigation). */
  debug: () => { ship: { x: number; y: number; vx: number; vy: number }; particles: number[] } | null;
}

declare global {
  interface Window {
    __engineProbe?: EngineProbeApi;
  }
}

async function main(): Promise<void> {
  const host = document.getElementById('host') as HTMLDivElement;
  const renderer = new PixiRenderer();
  const mirror = makeMirror();

  await renderer.init(host);
  // Render an initial frame so the sprite + camera lock onto the ship.
  renderer.update(mirror);

  const ship = (): ShipRenderState | undefined => mirror.ships.get(PROBE_ID);

  window.__engineProbe = {
    setShip: (x, y, angle, kind): void => {
      const s = ship();
      if (!s) return;
      s.x = x;
      s.y = y;
      s.angle = angle;
      if (kind !== undefined) s.kind = kind;
    },
    setVelocity: (vx, vy): void => {
      const s = ship();
      if (!s) return;
      s.vx = vx;
      s.vy = vy;
    },
    setThrust: (on): void => {
      if (on) mirror.thrustingShips!.add(PROBE_ID);
      else mirror.thrustingShips!.delete(PROBE_ID);
    },
    setBoost: (on): void => {
      if (on) mirror.boostingShips!.add(PROBE_ID);
      else mirror.boostingShips!.delete(PROBE_ID);
    },
    runFor: (ms): Promise<void> =>
      new Promise<void>((resolve) => {
        const start = performance.now();
        let last = start;
        const frame = (): void => {
          const now = performance.now();
          const dt = (now - last) / 1000;
          last = now;
          const s = ship();
          if (s) {
            s.x += s.vx * dt;
            s.y += s.vy * dt;
          }
          renderer.update(mirror);
          if (now - start >= ms) {
            resolve();
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    reset: (): void => {
      renderer.resetEffectsForSectorHandoff();
      mirror.thrustingShips!.clear();
      mirror.boostingShips!.clear();
      const s = ship();
      if (s) {
        s.x = 0;
        s.y = 0;
        s.vx = 0;
        s.vy = 0;
      }
      renderer.update(mirror);
    },
    debug: () => renderer.__debugEngine(),
  };
}

window.addEventListener('error', (e: ErrorEvent) => {
  // Surface boot failures to the page so a spec sees a non-silent failure.
  const host = document.getElementById('host');
  if (host) host.setAttribute('data-probe-error', e.message);
});

void main();
