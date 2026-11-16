/**
 * Cut-field streaming (macro terrain plan v2, behind the `cutField` room
 * option). Shared by both sides (#15): the server loads the chunks near every
 * ship as fixed colliders; the client loads the chunks near its own ship to
 * draw them and to give predWorld the rocks close by.
 *
 * A cut field (src/core/terrain/fieldLayout.ts) has ~115k rocks; only the
 * chunks near ships are ever bodies. On a slow cadence this keeps every chunk
 * within `wakeChunks` of any ship loaded as fixed colliders through the
 * existing `SwarmSpawner` (registry records marked `fieldRock`, which stay off
 * the swarm wire: every client cuts the same rocks itself from the seed), and
 * quietly evicts chunks no ship has been near for `lingerMs`. The first cut of
 * the plan's wake / deep-sleep tier: untouched rocks need no record.
 *
 * Never on a tick or a frame: each side runs `step` on its own slow timer
 * (`STEP_EVERY_MS`), so chunk cutting never lands in `update()` or RAF (#14).
 * Each call cuts at most `maxCutsPerStep` chunks, so a fast ship spreads the
 * work over several steps.
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { convexParts } from '../geometry/shipHullDecomp.js';
import { CHUNK_SIZE, FIELD_COLLIDER_SIMPLIFY, rocksInChunk, slicedField, type ChunkOpts, type ChunkRock, type SlicedRock } from './fieldLayout.js';

/** The cut options for a field seed: one source for both sides (#15). */
export function cutFieldOpts(seed: string): ChunkOpts {
  return { seed, battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2 };
}

/** A field rock as a body: centred on its outline's vertex mean, the outline
 *  relative to that centre, its bounding radius, and the convex parts its
 *  collider is built from (plan C1: it follows the rock's dents). Both sides
 *  build the collider from this, so their rocks match (#15). Generation-time
 *  only. `parts` null ⇒ the outline's convex hull (an outline that crosses
 *  itself). */
export interface FieldRockBody { x: number; y: number; radius: number; verts: { x: number; y: number }[]; parts: { x: number; y: number }[][] | null }


export function fieldRockBody(rock: Pick<SlicedRock, 'verts'>): FieldRockBody {
  let mx = 0, my = 0;
  for (const v of rock.verts) { mx += v.x; my += v.y; }
  mx /= rock.verts.length; my /= rock.verts.length;
  let r2 = 0;
  const verts = rock.verts.map((v) => {
    const dx = v.x - mx, dy = v.y - my;
    r2 = Math.max(r2, dx * dx + dy * dy);
    return { x: dx, y: dy };
  });
  let area2 = 0;
  for (let k = 0; k < verts.length; k++) { const a = verts[k]!, c = verts[(k + 1) % verts.length]!; area2 += a.x * c.y - c.x * a.y; }
  const eqRadius = Math.sqrt(Math.abs(area2) / 2 / Math.PI);
  return { x: mx, y: my, radius: Math.sqrt(r2), verts, parts: convexParts(verts, FIELD_COLLIDER_SIMPLIFY * eqRadius) };
}

/** A battleship-sized field rock weighs this many battleships (owner: a rock
 *  is a solid mountain, a hull a thin shell). Mass goes with area, so a rock
 *  a tenth of a battleship's radius weighs one battleship. */
export const FIELD_ROCK_BATTLESHIP_MASSES = 100;

/** A field rock's mass: `FIELD_ROCK_BATTLESHIP_MASSES` battleships at a
 *  battleship's size, scaling with area. From the live kind (#18). */
export function fieldRockMass(radius: number): number {
  const bs = getShipKind('battleship');
  return FIELD_ROCK_BATTLESHIP_MASSES * shipBodyMass(bs) * (radius / bs.radius) ** 2;
}

/** A field rock's bounding circle: the x, y and radius `fieldRockBody` gives
 *  it (same arithmetic), without building the collider. */
export function fieldRockCircle(rock: SlicedRock): { x: number; y: number; radius: number } {
  let mx = 0, my = 0;
  for (const v of rock.verts) { mx += v.x; my += v.y; }
  mx /= rock.verts.length; my /= rock.verts.length;
  let r2 = 0;
  for (const v of rock.verts) { const dx = v.x - mx, dy = v.y - my; r2 = Math.max(r2, dx * dx + dy * dy); }
  return { x: mx, y: my, radius: Math.sqrt(r2) };
}

/** A field rock as cut from the layout: its key, bounding circle and world
 *  outline (`fieldRockBody` builds its collider parts from `verts`). */
export interface FieldRockCircle { key: number; x: number; y: number; radius: number; verts: SlicedRock['verts'] }

/**
 * Every rock of the field whose bounding circle reaches into the box, cut from
 * the layout whether or not its chunk is loaded (C5: placement refuses a
 * structure on a rock nobody is near). Cuts only the pieces near the box
 * (`slicedField`'s view), so a big rock owned by a far chunk that reaches in is
 * found too; then, per rock found, its owning chunk (`rocksInChunk`) for its
 * key. A discrete action's cost (about a millisecond), never per tick or frame.
 * Key -1: no member of its chunk matched (should not happen; still a rock).
 */
export function fieldRocksInBox(o: ChunkOpts, x0: number, y0: number, x1: number, y1: number): FieldRockCircle[] {
  const cut = slicedField({
    seed: o.seed, battleshipLength: o.battleshipLength, fighterLength: o.fighterLength,
    view: { x0, y0, x1, y1 }, ...(o.radius !== undefined ? { radius: o.radius } : {}),
  });
  const out: FieldRockCircle[] = [];
  let chunks: Map<string, ChunkRock[]> | null = null;
  for (const rock of cut) {
    const c = fieldRockCircle(rock);
    const dx = Math.max(x0 - c.x, 0, c.x - x1), dy = Math.max(y0 - c.y, 0, c.y - y1);
    if (dx * dx + dy * dy >= c.radius * c.radius) continue;
    const cx = Math.floor(rock.cx / CHUNK_SIZE), cy = Math.floor(rock.cy / CHUNK_SIZE), ck = `${cx},${cy}`;
    chunks ??= new Map();
    let members = chunks.get(ck);
    if (!members) { members = rocksInChunk(o, cx, cy); chunks.set(ck, members); }
    const m = members.find((r) => r.path === rock.path);
    out.push({ key: m ? m.key : -1, x: c.x, y: c.y, radius: c.radius, verts: rock.verts });
  }
  return out;
}

/** The id both sides give a field rock (server registry, client predWorld). */
export const fieldRockId = (key: number): string => `field:${key}`;

export const STEP_EVERY_MS = 250;
/** Field rocks a server tick may wake (ramming, plan v2 C2): a capital
 *  ploughing in touches many at once; the rest wake on later ticks. */
export const FIELD_WAKES_PER_TICK = 4;
/** An awake rock driven into a fixed one at least this fast (game u/s,
 *  closing speed along the contact normal) wakes it too; cut pieces resting
 *  against each other sit far below it. */
export const FIELD_CHAIN_WAKE_SPEED = 20;

/** Does a contact with `other` (mass `otherMass`, undefined when unknown)
 *  wake a fixed field rock of mass `rockMass`? Only a body at least as heavy
 *  as the rock wakes it: a fighter never moves a rock, a battleship shoves
 *  only rocks up to its own mass (a tenth of its radius), never one its own
 *  size; a body of unknown mass never wakes one. Another field rock must also
 *  be awake and driven in at least `FIELD_CHAIN_WAKE_SPEED`, so a shove
 *  spreads through the pile but resting neighbours never wake each other. */
export function fieldRockWakes(
  rockMass: number, other: { fieldRock?: boolean; fieldAwake?: boolean } | null | undefined, otherMass: number | undefined, closingSpeed: number,
): boolean {
  if (otherMass === undefined || otherMass < rockMass) return false;
  if (other?.fieldRock !== true) return true;
  return other.fieldAwake === true && closingSpeed >= FIELD_CHAIN_WAKE_SPEED;
}
/** Cuts run on the room's main thread: a chunk costs ~4 ms (p50), ~6 ms
 *  (p95) on the desktop, so 2 per step keeps a step near one tick's budget.
 *  Nearest first, and chunks load two out, so a cruising ship never outruns
 *  them. */
export const MAX_CHUNKS_PER_STEP = 2;

/** What the streamer needs of a cut rock: the server's `ChunkRock`, or the
 *  client's handle into a worker-packed chunk (`packedChunk.ts`). */
export interface StreamedRock { key: number }

export interface CutFieldHooks<R extends StreamedRock = ChunkRock> {
  /** Visit every ship that should keep rocks loaded (pilots and AI hulls). */
  visitShips(cb: (x: number, y: number) => void): void;
  /** Spawn one rock as a fixed collider; false when no slot is free. */
  spawnRock(id: string, rock: R, cx: number, cy: number): boolean;
  /** Quietly remove one rock (no destroy event, no broadcast). */
  removeRock(id: string): void;
  nowMs(): number;
  /** A whole chunk was cut (after its rocks were spawned). Client drawing. */
  chunkLoaded?(cx: number, cy: number, rocks: readonly R[]): void;
  /** A whole chunk was dropped (after its rocks were removed). */
  chunkUnloaded?(cx: number, cy: number): void;
  /** Where cut rocks come from. Omitted: `rocksInChunk` inline (server). The
   *  client cuts in a background worker: this returns the chunk once it is
   *  cut, else starts or awaits the cut and returns null (asked again next
   *  step). Same rocks either way (#15). */
  cutChunk?(cx: number, cy: number): readonly R[] | null;
}

interface LoadedChunk { ids: string[]; lastNeededMs: number }

/** Chunk coords as one number (each fits ±32k). */
const pack = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
const unpackX = (k: number): number => Math.floor(k / 65536) - 32768;
const unpackY = (k: number): number => (k % 65536) - 32768;

export class CutFieldStreamer<R extends StreamedRock = ChunkRock> {
  private readonly loaded = new Map<number, LoadedChunk>();
  private readonly needed = new Set<number>();
  /** Counters for perf scenes and tests (counts, never timings). */
  readonly stats = { chunksLoaded: 0, rocksLoaded: 0, cutsThisStep: 0, refusedRocks: 0 };

  constructor(
    private readonly field: ChunkOpts,
    private readonly hooks: CutFieldHooks<R>,
    /** Chunks kept loaded around a ship (Chebyshev radius). */
    private readonly wakeChunks = 2,
    private readonly lingerMs = 10_000,
    /** Chunk cuts per `step` (a cut is ~1–15 ms on a desktop). */
    private readonly maxCutsPerStep = MAX_CHUNKS_PER_STEP,
  ) {}

  /** Drop everything (client sector change). */
  clear(): void {
    for (const [key, chunk] of this.loaded) {
      for (const id of chunk.ids) this.hooks.removeRock(id);
      this.hooks.chunkUnloaded?.(unpackX(key), unpackY(key));
    }
    this.loaded.clear();
    this.stats.chunksLoaded = 0;
    this.stats.rocksLoaded = 0;
  }

  /** Run on the room's slow cadence. Generation-time work, bounded per call. */
  step(): void {
    const now = this.hooks.nowMs();
    this.needed.clear();
    const w = this.wakeChunks;
    this.hooks.visitShips((x, y) => {
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
      // Ring by ring, so the cut budget goes to the ship's own chunk first.
      for (let r = 0; r <= w; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) this.needed.add(pack(cx + dx, cy + dy));
        }
      }
    });
    // Load missing chunks, nearest ring first (the first ship's, then the next).
    this.stats.cutsThisStep = 0;
    for (const key of this.needed) {
      const have = this.loaded.get(key);
      if (have) { have.lastNeededMs = now; continue; }
      if (this.stats.cutsThisStep >= this.maxCutsPerStep) continue;
      const cx = unpackX(key), cy = unpackY(key);
      // No cut hook: the server, where R is ChunkRock.
      const rocks = this.hooks.cutChunk ? this.hooks.cutChunk(cx, cy) : (rocksInChunk(this.field, cx, cy) as readonly StreamedRock[] as readonly R[]);
      if (rocks === null) continue; // still being cut elsewhere
      this.stats.cutsThisStep++;
      const ids: string[] = [];
      for (const rock of rocks) {
        const id = fieldRockId(rock.key);
        if (this.hooks.spawnRock(id, rock, cx, cy)) ids.push(id);
        else this.stats.refusedRocks++;
      }
      this.loaded.set(key, { ids, lastNeededMs: now });
      this.hooks.chunkLoaded?.(cx, cy, rocks);
    }
    // Unload chunks nobody has needed for a while.
    for (const [key, chunk] of this.loaded) {
      if (this.needed.has(key) || now - chunk.lastNeededMs < this.lingerMs) continue;
      for (const id of chunk.ids) this.hooks.removeRock(id);
      this.loaded.delete(key);
      this.hooks.chunkUnloaded?.(unpackX(key), unpackY(key));
    }
    let rocks = 0;
    for (const c of this.loaded.values()) rocks += c.ids.length;
    this.stats.chunksLoaded = this.loaded.size;
    this.stats.rocksLoaded = rocks;
  }
}
