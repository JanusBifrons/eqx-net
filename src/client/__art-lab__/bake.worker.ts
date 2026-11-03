/**
 * Art lab bake worker: runs Machined bakes off the main thread. Frames come
 * back as transferred buffers (no copy); the main thread packs them into the
 * atlas, which needs a canvas.
 */
import { runBake, type BakeJob } from './forge/bake.js';
import type { LightRig } from './forge/shade.js';

interface Req { seq: number; job: BakeJob; rig: LightRig }

self.onmessage = (e: MessageEvent<Req>): void => {
  const { seq, job, rig } = e.data;
  const t0 = performance.now();
  const b = runBake(job, rig);
  const ms = performance.now() - t0;
  (self as unknown as Worker).postMessage({ seq, baked: b, ms }, b.frames.map((f) => f.data.buffer));
};
