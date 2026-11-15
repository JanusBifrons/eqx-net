/** The renderer's perf-scene probe types (`IRenderer.perfProbe`, `pnpm perf:scenes`). */
/** Perf scenes (plan prancy-squishing-donut P2): a probe request. */
export type PerfProbeOp = 'enable' | 'reset' | 'read' | 'counts';

/** Frame-time percentiles (ms) over the probe window. */
export interface PerfFrameSummary { frames: number; p50: number; p95: number; p99: number; max: number; hitches: number }

/** What the renderer reports for a perf scene, on whichever thread it runs. */
export interface RenderPerfReading {
  /** Per-frame renderer update cost (CPU, incl. effects), not the display interval. */
  render: PerfFrameSummary;
  sprites: number;
  /** Every node in the Pixi stage tree. */
  displayObjects: number;
  mirrorShips: number;
  mirrorSwarm: number;
  effectQuality: string;
  /** Count probe (`?perfcounts=1`, op 'counts'; plan machine-independent-perf
   *  WS3): host-independent counts over the window. Null until enabled. */
  counts?: RenderCountReading | null;
}

/** What the count gate reads. Counts, never timings: the same scene draws the
 *  same on a fast desktop and on a software-GL CI runner (the effects tier is
 *  pinned while counting). */
export interface RenderCountReading {
  /** WebGL draw calls per rendered frame (`frames` = frames counted). */
  drawCalls: { frames: number; p50: number; p95: number; max: number };
  /** Atlas page uploads over the window, and the texels they moved. */
  textureUploads: number;
  uploadTexels: number;
  /** Atlas pages live now, and the GPU bytes they hold. */
  atlasPages: number;
  gpuBytes: number;
}
