import { buildContextBatches, type Graphics, type GpuGraphicsContext } from 'pixi.js';

/** Test-only: the vertex positions (x, y, x, y, ...) Pixi tessellates for a
 *  Graphics, exactly what it uploads to the GPU. A NaN here is drawn by phone
 *  GPUs at the Graphics' local origin: a long stray line. */
export function strokeVertices(g: Graphics): number[] {
  const gpu = { batches: [], geometryData: { vertices: [], uvs: [], indices: [] } } as unknown as GpuGraphicsContext;
  buildContextBatches(g.context, gpu);
  return gpu.geometryData!.vertices;
}
