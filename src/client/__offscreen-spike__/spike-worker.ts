/**
 * Phase 1 spike — worker (iteration 2).
 *
 * Iteration 1 (with pixi-viewport) returned NO-GO: pixi-viewport's Drag
 * plugin calls `addEventListener` on `events.domElement`, which is
 * undefined in worker context. Confirmed by the spike probe.
 *
 * Iteration 2: drop pixi-viewport entirely. Prove the bare
 * Pixi+OffscreenCanvas+Worker stack works, then attach a hand-rolled
 * Camera class for pan/zoom/decelerate. This is the Fallback 2 path
 * from the migration plan.
 *
 * Hit-testing for hex taps is also hand-rolled in the worker rather
 * than relying on Pixi's EventSystem (which has its own DOM
 * dependencies per pixijs/pixijs#9132). Each hex is a circle in world
 * space; we test pointerdown→pointerup distance + which hex's bounds
 * the tap landed in.
 *
 * Throwaway code — not bundled or shipped.
 */

import { Application, Container, Graphics, DOMAdapter, WebWorkerAdapter } from 'pixi.js';

DOMAdapter.set(WebWorkerAdapter);

interface BootMsg { type: 'BOOT'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
interface PointerMsg { type: 'POINTER_EVENT'; native: SerialisedPointer }
interface WheelMsg { type: 'WHEEL_EVENT'; native: SerialisedWheel }
interface ResizeMsg { type: 'RESIZE'; width: number; height: number; dpr: number }
type InMsg = BootMsg | PointerMsg | WheelMsg | ResizeMsg;

interface SerialisedPointer {
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isPrimary: boolean;
  pressure: number;
  width: number;
  height: number;
  twist: number;
  tiltX: number;
  tiltY: number;
  stamp: number;
}

interface SerialisedWheel {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  stamp: number;
}

// ---------- Hand-rolled Camera ----------
//
// Operates on a Pixi `Container` (the "world"). Pan = translate.
// Zoom = scale around a focal point. Momentum after release = velocity
// + per-frame decay.
//
// In the real migration this becomes `src/client/render/worker/Camera.ts`
// with proper tests + the pixi-viewport feature parity surface (pinch,
// clampZoom, clicked, moveCenter, follow).

interface HexHitTarget {
  index: number;
  worldX: number;
  worldY: number;
  worldR: number;
}

class Camera {
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private lastX = 0;
  private lastY = 0;
  private vx = 0;
  private vy = 0;
  private readonly decelFactor = 0.9;
  private readonly tapThresholdPx = 6;
  private readonly tapThresholdMs = 250;
  private dragStartStamp = 0;
  private wasTap = false;

  constructor(
    private readonly world: Container,
    private readonly hitTargets: HexHitTarget[],
    private readonly onTap: (index: number) => void,
    private readonly minScale: number = 0.5,
    private readonly maxScale: number = 4,
  ) {}

  onPointerDown(screenX: number, screenY: number, stamp: number): void {
    this.isDragging = true;
    this.dragStartX = screenX;
    this.dragStartY = screenY;
    this.lastX = screenX;
    this.lastY = screenY;
    this.vx = 0;
    this.vy = 0;
    this.dragStartStamp = stamp;
    this.wasTap = false;
  }

  onPointerMove(screenX: number, screenY: number): void {
    if (!this.isDragging) return;
    const dx = screenX - this.lastX;
    const dy = screenY - this.lastY;
    this.world.x += dx;
    this.world.y += dy;
    this.vx = dx;
    this.vy = dy;
    this.lastX = screenX;
    this.lastY = screenY;
  }

  onPointerUp(screenX: number, screenY: number, stamp: number): void {
    if (!this.isDragging) return;
    const ddx = screenX - this.dragStartX;
    const ddy = screenY - this.dragStartY;
    const dist = Math.hypot(ddx, ddy);
    const elapsed = stamp - this.dragStartStamp;

    if (dist < this.tapThresholdPx && elapsed < this.tapThresholdMs) {
      // It was a tap. Hit-test against the world hexes.
      this.wasTap = true;
      const worldX = (screenX - this.world.x) / this.world.scale.x;
      const worldY = (screenY - this.world.y) / this.world.scale.y;
      for (const h of this.hitTargets) {
        if (Math.hypot(worldX - h.worldX, worldY - h.worldY) <= h.worldR) {
          this.onTap(h.index);
          break;
        }
      }
      this.vx = 0;
      this.vy = 0;
    }

    this.isDragging = false;
  }

  onPointerCancel(): void {
    this.isDragging = false;
    this.vx = 0;
    this.vy = 0;
  }

  onWheel(deltaY: number, screenX: number, screenY: number): void {
    const factor = deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.world.scale.x * factor));
    // Zoom around the pointer position.
    const worldX = (screenX - this.world.x) / this.world.scale.x;
    const worldY = (screenY - this.world.y) / this.world.scale.y;
    this.world.scale.set(newScale);
    this.world.x = screenX - worldX * newScale;
    this.world.y = screenY - worldY * newScale;
  }

  tick(): void {
    if (this.isDragging) return;
    if (Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1) {
      this.vx = 0;
      this.vy = 0;
      return;
    }
    this.world.x += this.vx;
    this.world.y += this.vy;
    this.vx *= this.decelFactor;
    this.vy *= this.decelFactor;
  }

  /** Test-only — reports the last "was the up-event a tap?" flag. */
  getWasTap(): boolean {
    return this.wasTap;
  }
}

// ---------- Worker state ----------

let app: Application | null = null;
let world: Container | null = null;
let camera: Camera | null = null;

self.onmessage = async (e: MessageEvent<InMsg>): Promise<void> => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'BOOT': {
        app = new Application();
        await app.init({
          canvas: msg.canvas as unknown as HTMLCanvasElement,
          width: msg.width,
          height: msg.height,
          background: 0x05070f,
          antialias: true,
          resolution: 1,
          autoDensity: false,
        });

        world = new Container();
        // World origin (0,0) sits at canvas-centre. Hex 2 is at world
        // (0,0) so a tap at canvas-centre hits hex 2 deterministically.
        world.x = msg.width / 2;
        world.y = msg.height / 2;
        app.stage.addChild(world);

        const r = 60;
        const layout: Array<{ x: number; y: number; label: number }> = [
          { x: -200, y: 0, label: 0 },
          { x: -100, y: 0, label: 1 },
          { x: 0, y: 0, label: 2 },
          { x: 100, y: 0, label: 3 },
          { x: 200, y: 0, label: 4 },
        ];

        const hitTargets: HexHitTarget[] = [];

        for (const { x, y, label } of layout) {
          const hex = new Graphics();
          hex.poly([
            r, 0,
            r / 2, r * 0.866,
            -r / 2, r * 0.866,
            -r, 0,
            -r / 2, -r * 0.866,
            r / 2, -r * 0.866,
          ]);
          hex.fill({ color: 0x00ff88, alpha: 0.25 });
          hex.stroke({ color: 0x00ff88, width: 2 });
          hex.x = x;
          hex.y = y;
          world.addChild(hex);

          hitTargets.push({ index: label, worldX: x, worldY: y, worldR: r });
        }

        camera = new Camera(world, hitTargets, (index) => {
          self.postMessage({ type: 'HEX_TAP', index });
        });

        // Pixi ticker drives the camera momentum decay.
        app.ticker.add(() => {
          camera?.tick();
        });

        self.postMessage({ type: 'READY' });
        break;
      }

      case 'POINTER_EVENT': {
        if (!camera) return;
        const n = msg.native;
        switch (n.type) {
          case 'pointerdown':
            camera.onPointerDown(n.offsetX, n.offsetY, n.stamp);
            break;
          case 'pointermove':
            camera.onPointerMove(n.offsetX, n.offsetY);
            break;
          case 'pointerup':
            camera.onPointerUp(n.offsetX, n.offsetY, n.stamp);
            break;
          case 'pointercancel':
          case 'pointerleave':
            camera.onPointerCancel();
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
        if (!app) return;
        app.renderer.resize(msg.width, msg.height);
        if (world) {
          world.x = msg.width / 2;
          world.y = msg.height / 2;
        }
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: String(err) });
  }
};
