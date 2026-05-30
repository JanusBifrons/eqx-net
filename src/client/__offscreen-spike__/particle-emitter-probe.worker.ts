/**
 * Worker side of the M0.5 `@pixi/particle-emitter` worker-compat probe.
 *
 * Mirrors `spike-worker.ts`'s `DOMAdapter.set(WebWorkerAdapter)` pattern.
 * Boots a tiny Pixi `Application` on the transferred `OffscreenCanvas`,
 * instantiates ONE `Emitter` from `@pixi/particle-emitter`, ticks it for
 * ~5 s and posts back the live particle count.
 *
 * Throwaway probe code — not bundled in production.
 */

import { Application, Container, Texture, DOMAdapter, WebWorkerAdapter } from 'pixi.js';
import { Emitter } from '@pixi/particle-emitter';

DOMAdapter.set(WebWorkerAdapter);

interface BootMsg {
  type: 'BOOT';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

// `@pixi/particle-emitter` v5.0.10 (latest) was typed for Pixi v7
// (`Container<DisplayObject>`). Pixi v8 renamed the child constraint to
// `ContainerChild`; the runtime is compatible but the types disagree.
// `as never` lets the spike construct the emitter; the real EmitterPool
// in `src/client/effects/pools/` will own a typed wrapper.
type EmitterParent = ConstructorParameters<typeof Emitter>[0];

self.onmessage = async (e: MessageEvent<BootMsg>): Promise<void> => {
  const msg = e.data;
  if (msg.type !== 'BOOT') return;
  try {
    const app = new Application();
    await app.init({
      canvas: msg.canvas as unknown as HTMLCanvasElement,
      width: msg.width,
      height: msg.height,
      background: 0x05070f,
    });

    const container = new Container();
    app.stage.addChild(container);

    const emitter = new Emitter(container as unknown as EmitterParent, {
      lifetime: { min: 0.5, max: 0.8 },
      frequency: 0.01,
      maxParticles: 200,
      emit: true,
      pos: { x: msg.width / 2, y: msg.height / 2 },
      behaviors: [
        { type: 'alpha', config: { alpha: { list: [{ value: 1, time: 0 }, { value: 0, time: 1 }] } } },
        { type: 'moveSpeed', config: { speed: { list: [{ value: 200, time: 0 }, { value: 100, time: 1 }] } } },
        { type: 'scale', config: { scale: { list: [{ value: 1, time: 0 }, { value: 0.3, time: 1 }] }, minMult: 1 } },
        { type: 'rotation', config: { minStart: 0, maxStart: 360, minSpeed: 0, maxSpeed: 0, accel: 0 } },
        { type: 'textureSingle', config: { texture: Texture.WHITE as never } },
      ],
    });

    self.postMessage({ type: 'READY' });

    let elapsed = 0;
    const tickInterval = 16;
    const totalMs = 5000;
    const id = setInterval(() => {
      try {
        emitter.update(tickInterval / 1000);
        elapsed += tickInterval;
        if (elapsed >= totalMs) {
          clearInterval(id);
          self.postMessage({ type: 'TICK', particles: emitter.particleCount });
        }
      } catch (err) {
        clearInterval(id);
        self.postMessage({ type: 'ERROR', error: String(err) });
      }
    }, tickInterval);
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: String(err) });
  }
};
