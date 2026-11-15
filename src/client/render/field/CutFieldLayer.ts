/**
 * Macro terrain v2 (room flag `cutField`): the cut-field chunks the client has
 * loaded, drawn as flat-coloured rocks (the owner-agreed slice-2 look; the
 * procedural rock shader from `exp/terrain-look` comes later, behind its own
 * OK). One static `Graphics` per chunk, built when the chunk arrives and never
 * touched per frame; Pixi culls nothing here yet (slice-4 measurements decide).
 */
import { Container, Graphics } from 'pixi.js';

const ROCK_FILL = 0x4f4840;
const ROCK_EDGE = 0x2b2622;

/** Chunk coords as one number (each fits ±32k). */
const chunkKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

export class CutFieldLayer {
  readonly container = new Container();
  private readonly chunks = new Map<number, Graphics>();

  constructor() {
    this.container.eventMode = 'none';
    this.container.label = 'cut-field';
  }

  get chunkCount(): number { return this.chunks.size; }

  /** See `IRenderer.setFieldChunk`. Game space in, Pixi space out (y flips). */
  setChunk(cx: number, cy: number, outlines: Float32Array | null): void {
    const key = chunkKey(cx, cy);
    this.chunks.get(key)?.destroy();
    this.chunks.delete(key);
    if (outlines === null) return;
    const g = new Graphics();
    let i = 0;
    while (i < outlines.length) {
      const n = outlines[i++]!;
      // A fresh array per rock: Pixi's Polygon keeps the reference.
      const pts: number[] = [];
      for (let k = 0; k < n; k++) { pts.push(outlines[i++]!, -outlines[i++]!); }
      g.poly(pts).fill(ROCK_FILL).stroke({ color: ROCK_EDGE, width: 6, alignment: 1 });
    }
    this.chunks.set(key, g);
    this.container.addChild(g);
  }

  clear(): void {
    for (const g of this.chunks.values()) g.destroy();
    this.chunks.clear();
  }
}
