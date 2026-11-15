/**
 * Cut-field streaming (macro terrain plan v2; the de-risk slice the owner
 * asked for on 2026-11-15, behind the `cutField` room option).
 *
 * A cut field (src/core/terrain/fieldLayout.ts) has ~115k rocks; only the
 * chunks near ships are ever bodies. On a slow cadence this keeps every chunk
 * within `wakeChunks` of any ship loaded as fixed colliders through the
 * existing `SwarmSpawner` (registry records marked `fieldRock`, which stay off
 * the swarm wire: every client cuts the same rocks itself from the seed), and
 * quietly evicts chunks no ship has been near for `lingerMs`. The first cut of
 * the plan's wake / deep-sleep tier: untouched rocks need no record.
 *
 * Not on the room tick: the room runs `step` on its own game-clock timer
 * (`STEP_EVERY_MS`, like the convoy director's loop), so chunk cutting never
 * lands in `update()` (#14). Each call cuts at most `MAX_CHUNKS_PER_STEP`
 * chunks, so a fast ship spreads the work over several steps.
 */
import { CHUNK_SIZE, rocksInChunk, type ChunkOpts, type ChunkRock } from '../../core/terrain/fieldLayout.js';

export const STEP_EVERY_MS = 250;
export const MAX_CHUNKS_PER_STEP = 4;

export interface CutFieldHooks {
  /** Visit every ship that should keep rocks loaded (pilots and AI hulls). */
  visitShips(cb: (x: number, y: number) => void): void;
  /** Spawn one rock as a fixed collider; false when no slot is free. */
  spawnRock(id: string, rock: ChunkRock, cx: number, cy: number): boolean;
  /** Quietly remove one rock (no destroy event, no broadcast). */
  removeRock(id: string): void;
  nowMs(): number;
}

interface LoadedChunk { ids: string[]; lastNeededMs: number }

/** Chunk coords as one number (each fits ±32k). */
const pack = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
const unpackX = (k: number): number => Math.floor(k / 65536) - 32768;
const unpackY = (k: number): number => (k % 65536) - 32768;

export class CutFieldStreamer {
  private readonly loaded = new Map<number, LoadedChunk>();
  private readonly needed = new Set<number>();
  /** Counters for perf scenes and tests (counts, never timings). */
  readonly stats = { chunksLoaded: 0, rocksLoaded: 0, cutsThisStep: 0, refusedRocks: 0 };

  constructor(
    private readonly field: ChunkOpts,
    private readonly hooks: CutFieldHooks,
    /** Chunks kept loaded around a ship (Chebyshev radius). */
    private readonly wakeChunks = 2,
    private readonly lingerMs = 10_000,
  ) {}

  /** Run on the room's slow cadence. Generation-time work, bounded per call. */
  step(): void {
    const now = this.hooks.nowMs();
    this.needed.clear();
    const w = this.wakeChunks;
    this.hooks.visitShips((x, y) => {
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
      for (let dx = -w; dx <= w; dx++) for (let dy = -w; dy <= w; dy++) this.needed.add(pack(cx + dx, cy + dy));
    });
    // Load missing chunks, nearest-first is not needed at this budget.
    this.stats.cutsThisStep = 0;
    for (const key of this.needed) {
      const have = this.loaded.get(key);
      if (have) { have.lastNeededMs = now; continue; }
      if (this.stats.cutsThisStep >= MAX_CHUNKS_PER_STEP) continue;
      this.stats.cutsThisStep++;
      const cx = unpackX(key), cy = unpackY(key);
      const ids: string[] = [];
      for (const rock of rocksInChunk(this.field, cx, cy)) {
        const id = `field:${rock.key}`;
        if (this.hooks.spawnRock(id, rock, cx, cy)) ids.push(id);
        else this.stats.refusedRocks++;
      }
      this.loaded.set(key, { ids, lastNeededMs: now });
    }
    // Unload chunks nobody has needed for a while.
    for (const [key, chunk] of this.loaded) {
      if (this.needed.has(key) || now - chunk.lastNeededMs < this.lingerMs) continue;
      for (const id of chunk.ids) this.hooks.removeRock(id);
      this.loaded.delete(key);
    }
    let rocks = 0;
    for (const c of this.loaded.values()) rocks += c.ids.length;
    this.stats.chunksLoaded = this.loaded.size;
    this.stats.rocksLoaded = rocks;
  }
}
