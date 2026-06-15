/**
 * T-ship collision VISUAL probe — main thread (playtest 2026-06-10 Issue 4).
 *
 * Boots the production `PixiRenderer` DIRECTLY on the main thread (NOT
 * `WorkerRendererClient`) so `page.screenshot()` captures real pixels (the
 * OffscreenCanvas-in-worker path screenshots BLACK — same reason the
 * engine-particles probe uses the main-thread renderer).
 *
 * Renders the two CROSSGUARD T-ships at the EXACT 1-PIXEL-GAP interlock poses
 * the `hull-collision-test` room uses for its negative control:
 *
 *   - ship A: (x=-40.5, y= 10.5, angle=0)    upright T  (crossbar UP, stem DOWN)
 *   - ship B: (x= 40.5, y=-10.5, angle=π)    inverted T (crossbar DOWN, stem UP)
 *
 * Derived from the clean-T collider extents (math-up, ×10): crossbar
 * x∈[-140,140] y∈[100,160]; stem x∈[-40,40] y∈[-120,100]. With Δx = 81
 * (stem-width 80 + 1) the two stems sit side-by-side with a 1 u gap, and with
 * Δy = 21 each crossbar is exactly 1 u clear of the opposing stem-end — so
 * ALL THREE contact faces are 1 u apart. The silhouettes interlock as tightly
 * as possible WITHOUT touching (the user's "exactly aligned" ask). The agent
 * reads the PNG to judge orientation + the tight alignment; the `overlap`
 * scenario (driven by the spec) nudges them together to prove they DO collide.
 *
 * Both ships live in `mirror.ships` (the ship render path renders the full
 * per-kind silhouette via `buildShipGfxFromShape`), which is byte-identical
 * to how a `crossguard` drone renders in `swarmSpriteUpdater` (same builder,
 * same `sprite.x / -y / rotation=-angle`), so orientation verification is
 * faithful while sidestepping the swarm pose-ring plumbing a real
 * `ColyseusClient` would drive.
 *
 * Reachable in dev at /__offscreen-spike__/tship-collision-probe.html.
 * Production builds never include this file (Vite's `rollupOptions.input`
 * only lists the main `index.html`).
 */
import { PixiRenderer } from '../render/PixiRenderer';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';

const A_ID = 'tship-a';
const B_ID = 'tship-b';

/** Build a persistent mirror with the two interlocking crossguards. Stable
 *  refs so the probe can re-pose them between frames if needed. */
function makeMirror(): RenderMirror {
  const a: ShipRenderState = { x: -40.5, y: 10.5, angle: 0, vx: 0, vy: 0, kind: 'crossguard' };
  const b: ShipRenderState = { x: 40.5, y: -10.5, angle: Math.PI, vx: 0, vy: 0, kind: 'crossguard' };
  return {
    ships: new Map([[A_ID, a], [B_ID, b]]),
    localPlayerId: A_ID,
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

interface TShipProbeApi {
  /** Re-pose ship A or B (game-space radians). */
  setShip: (which: 'a' | 'b', x: number, y: number, angle: number) => void;
  /** Render one frame. */
  postFrame: () => void;
  /** Render `frames` frames back-to-back (lets the camera settle on A). */
  runFrames: (frames: number) => Promise<void>;
}

declare global {
  interface Window {
    __tshipProbe?: TShipProbeApi;
  }
}

async function main(): Promise<void> {
  const host = document.getElementById('host') as HTMLDivElement;
  const renderer = new PixiRenderer();
  const mirror = makeMirror();

  await renderer.init(host);
  renderer.update(mirror);

  window.__tshipProbe = {
    setShip: (which, x, y, angle): void => {
      const s = mirror.ships.get(which === 'a' ? A_ID : B_ID);
      if (!s) return;
      s.x = x;
      s.y = y;
      s.angle = angle;
    },
    postFrame: (): void => {
      renderer.update(mirror);
    },
    runFrames: (frames): Promise<void> =>
      new Promise<void>((resolve) => {
        let n = 0;
        const frame = (): void => {
          renderer.update(mirror);
          if (++n >= frames) {
            resolve();
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  };
}

window.addEventListener('error', (e: ErrorEvent) => {
  const host = document.getElementById('host');
  if (host) host.setAttribute('data-probe-error', e.message);
});

void main();
