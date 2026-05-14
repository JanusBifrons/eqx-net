/**
 * Renderer Web Worker — Phase 4 minimum-viable worker renderer.
 *
 * Draws ship sprites from `MirrorUpdate` snapshots, with the hand-rolled
 * `Camera` following the local player. This is the PROOF that the
 * OffscreenCanvas + Worker architecture works end-to-end against the
 * eqx-peri render mirror. Sub-managers (swarm, projectiles, beams,
 * halo radar, damage numbers, health bars, labels, mount visuals,
 * background grid, starfield, wrecks, lingering hulls) are NOT yet
 * ported — they remain as follow-up commits.
 *
 * The Safari fallback (`src/client/render/PixiRenderer.ts`) is the
 * full-feature renderer; the worker is enabled only when the capability
 * check (`supportsOffscreenRenderer()`) returns true AND the caller
 * opts in. Until the sub-manager port is complete, production should
 * keep using PixiRenderer; this worker is exercised via the spike /
 * probe pages so we can measure CDP-roundtrip improvement.
 *
 * Module-top: `DOMAdapter.set(WebWorkerAdapter)` is mandatory BEFORE
 * any other Pixi import is evaluated.
 *
 * No imports allowed: `react`, `react-dom`, `@mui/*`, `@emotion/*`,
 * `zustand`. Enforced by `eslint.config.js`. The protocol in
 * `protocol.ts` is the only sanctioned communication channel.
 */

import {
  Application,
  Container,
  Graphics,
  DOMAdapter,
  WebWorkerAdapter,
} from 'pixi.js';
import type {
  MainToWorkerMsg,
  WorkerToMainMsg,
} from './protocol';
import { Camera } from './Camera';
import { getShipKind, type ShipShape } from '../../../shared-types/shipKinds';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';

DOMAdapter.set(WebWorkerAdapter);

const BACKGROUND_COLOR = 0x05070f;
const HITBOX_COLOR = 0xff0066;
const HITBOX_RADIUS = 12;
const LOCAL_TINT = 0x00ff88;
const REMOTE_TINT = 0x66aaff;

function post(msg: WorkerToMainMsg): void {
  self.postMessage(msg);
}

/** Build a Pixi `Graphics` for a ship kind (mirrors PixiRenderer's
 *  `buildShipGfxFromShape`). Local-player ships are tinted green;
 *  remotes blue. Kind colour from the catalogue is used as the base. */
function buildShipGfx(shape: ShipShape, tintOverride?: number): Graphics {
  const g = new Graphics();
  const scale = shape.scale;
  g.poly(shape.points.map(([x, y]) => ({ x: x * scale, y: y * scale })));
  g.fill({ color: tintOverride ?? shape.color });
  g.circle(0, 0, HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

// ---------- Worker state ----------

let app: Application | null = null;
let world: Container | null = null;
let camera: Camera | null = null;
let shipContainer: Container | null = null;
const sprites = new Map<string, Graphics>();
let localPlayerId: string | null = null;

self.onmessage = async (e: MessageEvent<MainToWorkerMsg>): Promise<void> => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'BOOT': {
        app = new Application();
        await app.init({
          canvas: msg.canvas as unknown as HTMLCanvasElement,
          width: msg.width,
          height: msg.height,
          background: BACKGROUND_COLOR,
          antialias: true,
          resolution: 1,
          autoDensity: false,
        });

        // (PixiRenderer disables `events.features.globalMove` here as a
        // perf hint. In worker context Pixi's EventSystem isn't set up
        // with a `features` map — there's no DOM event source — so the
        // call would throw. Skipped: worker can't generate native pointer
        // events anyway; all events arrive synthesised via postMessage
        // and are consumed by the Camera state machine, not Pixi events.)

        world = new Container();
        app.stage.addChild(world);
        shipContainer = new Container();
        world.addChild(shipContainer);

        camera = new Camera(world, {
          minScale: 0.4,
          maxScale: 3,
        });
        camera.setScreenSize(msg.width, msg.height);

        post({ type: 'READY' });
        break;
      }

      case 'MIRROR_UPDATE': {
        if (!shipContainer || !camera) return;
        applyMirror(msg.mirror);
        // Post-frame feedback. The minimal worker doesn't have
        // mount-count or halo-arrow-count yet; both default to zero.
        post({ type: 'FEEDBACK', feedback: { mountCounts: new Map(), haloArrowCount: 0 } });
        break;
      }

      case 'POINTER_EVENT': {
        if (!camera) return;
        const n = msg.native;
        switch (n.type) {
          case 'pointerdown':
            camera.onPointerDown(n.pointerId, n.offsetX, n.offsetY, n.stamp);
            break;
          case 'pointermove':
            camera.onPointerMove(n.pointerId, n.offsetX, n.offsetY);
            break;
          case 'pointerup':
            camera.onPointerUp(n.pointerId, n.offsetX, n.offsetY, n.stamp);
            break;
          case 'pointercancel':
          case 'pointerleave':
            camera.onPointerCancel(n.pointerId);
            break;
        }
        break;
      }

      case 'WHEEL_EVENT': {
        if (!camera) return;
        camera.onWheel(msg.native.deltaY, msg.native.offsetX, msg.native.offsetY);
        break;
      }

      case 'RESIZE': {
        if (!app || !camera) return;
        app.renderer.resize(msg.width, msg.height);
        camera.setScreenSize(msg.width, msg.height);
        break;
      }

      case 'SET_TICKER_FPS': {
        if (!app) return;
        if (msg.fps === null) {
          app.ticker.stop();
        } else {
          if (!app.ticker.started) app.ticker.start();
          app.ticker.maxFPS = msg.fps ?? 0;
        }
        break;
      }

      case 'SET_VISIBLE':
      case 'SET_CURRENT_SECTOR':
      case 'SET_TRANSIT_DOCKED':
        // Phase 4.4 — GalaxyMapLayer state messages. The minimum-viable
        // worker doesn't host the overlay yet; these are accepted and
        // discarded so the main thread can post them without error.
        break;

      case 'DISPOSE': {
        if (app) {
          try {
            app.ticker.stop();
            app.destroy(true);
          } catch {
            // Best effort — the worker is about to terminate anyway.
          }
          app = null;
        }
        sprites.clear();
        world = null;
        shipContainer = null;
        camera = null;
        self.close();
        break;
      }
    }
  } catch (err) {
    post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
  }
};

// ---------- Ship sprite management ----------

function applyMirror(mirror: RenderMirror): void {
  if (!shipContainer || !camera) return;

  localPlayerId = mirror.localPlayerId;
  const seen = new Set<string>();

  for (const [playerId, ship] of mirror.ships) {
    seen.add(playerId);
    let sprite = sprites.get(playerId);
    if (!sprite) {
      const kind = ship.kind ? getShipKind(ship.kind) : getShipKind('fighter');
      const tint = playerId === localPlayerId ? LOCAL_TINT : REMOTE_TINT;
      sprite = buildShipGfx(kind.shape, tint);
      sprites.set(playerId, sprite);
      shipContainer.addChild(sprite);
    }
    positionSprite(sprite, ship);
  }

  // Despawn missing
  for (const [playerId, sprite] of sprites) {
    if (!seen.has(playerId)) {
      shipContainer.removeChild(sprite);
      sprite.destroy();
      sprites.delete(playerId);
    }
  }

  // Camera follows the local player.
  if (localPlayerId) {
    const localShip = mirror.ships.get(localPlayerId);
    if (localShip) {
      // Y-flip: render uses -y so up is +y in world coords.
      camera.moveCenter(localShip.x, -localShip.y);
    }
  }
}

function positionSprite(sprite: Graphics, ship: ShipRenderState): void {
  sprite.x = ship.x;
  sprite.y = -ship.y; // Y-flip
  sprite.rotation = ship.angle;
}
