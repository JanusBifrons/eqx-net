/**
 * Macro terrain v2 (room flag `cutField`): the client half of the cut field.
 *
 * The welcome carries only the field seed; no rock rides the wire. This cuts
 * the chunks around the local ship with the shared `CutFieldStreamer` (the
 * server runs the same one) on its own slow timer, one chunk per step. The
 * cutting itself (a few ms a chunk on a desktop, several times that on a
 * phone) runs in the page's art bake pool, so it never lands on a frame. Each loaded chunk goes to the renderer as flat outlines (the
 * mirror's `pendingFieldChunks` drain queue);
 * only the rocks the local ship can touch get a locked predWorld body, streamed
 * by edge distance like structures (`wantPredBody`), because every correction
 * replays ~20 ticks over the whole predWorld.
 *
 * The body is `fieldRockBody` on both sides (#15): same centre, outline and id.
 */

import type { PhysicsWorld } from '@core/physics/World';
import {
  CutFieldStreamer,
  cutFieldOpts,
  fieldRockBody,
  fieldRockId,
  type FieldRockBody,
} from '@core/terrain/chunkStreamer';
import { rocksInChunk, type ChunkOpts, type ChunkRock } from '@core/terrain/fieldLayout';
import { wantPredBody } from '../structures/predStructureStreaming.js';
import type { FieldRockSource } from './entity/IClientEntityLeaf.js';

/** Client step cadence (wall time: it paces generation work, not anything in
 *  the game; the client has no game-time timer host). One chunk cut per step
 *  keeps a phone's frames clear. */
export const CLIENT_STEP_MS = 125;
const CLIENT_CUTS_PER_STEP = 1;
/** Chunks drawn around the ship (Chebyshev radius: 7×7 chunks ≈ 28 km). */
const CLIENT_WAKE_CHUNKS = 3;
const CLIENT_LINGER_MS = 5_000;
/** Field rocks are fixed: their predWorld mass is irrelevant (locked). */
const FIELD_ROCK_PRED_MASS = 3;
/** Chunk cuts out in the pool at once (nearest first; a few, so ship bakes
 *  still get workers). */
export const MAX_CUTS_IN_FLIGHT = 2;
/** Finished cuts the streamer stopped wanting are kept this many at most. */
const MAX_READY_CUTS = 16;
/** An awake rock not seen on the swarm wire for this long (game ms) is
 *  asleep again: its chunk went away on the server and will re-cut fixed. */
export const FIELD_AWAKE_FORGET_MS = 2_000;

/** Cuts a chunk off the main thread (the art bake pool's `cutChunk`). */
export interface ChunkCutter {
  cutChunk?(field: ChunkOpts, cx: number, cy: number): Promise<ChunkRock[]>;
}

/** Where chunk outlines go (ColyseusClient: the mirror's drain queue). */
export interface CutFieldDrawSink {
  /** Draw one chunk: `outlines` is [n, x0, y0, …, x(n-1), y(n-1), n, …] in
   *  game space; null drops the chunk. */
  setFieldChunk(cx: number, cy: number, outlines: Float32Array | null): void;
}

export interface CutFieldClientDeps {
  gameClock: { now(): number };
  predWorld(): PhysicsWorld | null;
  /** The local ship's pose, or null when there is none (spectating, dead). */
  localPose(): { x: number; y: number } | null;
  draw: CutFieldDrawSink;
  /** The background cutter; omitted or without `cutChunk`: cut inline. */
  cutter?: () => ChunkCutter | null;
}

interface LoadedRock { body: FieldRockBody; key: number; inPred: boolean }

export interface CutFieldSummary { chunks: number; rocks: number; predBodies: number; awake: number }

export class CutFieldClient implements FieldRockSource {
  private seed: string | null = null;
  private streamer: CutFieldStreamer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rocks = new Map<string, LoadedRock>();
  /** Cuts asked of the pool: null while out, the rocks once back. */
  private readonly cuts = new Map<string, readonly ChunkRock[] | null>();
  private inFlight = 0;
  /** Bumped on stop, so a cut that lands after it is dropped. */
  private gen = 0;
  private inline = false;
  /** Awake rocks (rock key → game ms last seen on the swarm wire): they
   *  collide as swarm bodies, so their fixed body stays out. */
  private readonly awake = new Map<number, number>();
  /** Counters for tests and diagnostics (counts, never timings). */
  readonly stats = { predBodies: 0, awake: 0 };

  constructor(private readonly deps: CutFieldClientDeps) {}

  /** The asteroid leaf, for an awake field rock on the swarm wire: mark it
   *  awake, drop its fixed predWorld body, return its centred outline. */
  wakeFieldRock(key: number): ReadonlyArray<{ x: number; y: number }> | null {
    this.awake.set(key, this.deps.gameClock.now());
    const id = fieldRockId(key);
    const r = this.rocks.get(id);
    if (!r) return null;
    if (r.inPred) {
      this.deps.predWorld()?.despawnShip(id);
      r.inPred = false;
    }
    return r.body.verts;
  }

  get loadedRocks(): number { return this.rocks.size; }
  /** Counts for the E2E and perf scenes (allocates; never per frame). */
  summary(): CutFieldSummary {
    return { chunks: this.chunksLoaded, rocks: this.rocks.size, predBodies: this.stats.predBodies, awake: this.stats.awake };
  }
  get chunksLoaded(): number { return this.streamer?.stats.chunksLoaded ?? 0; }

  /** From the welcome: a seed turns the field on, null turns it off. */
  setSeed(seed: string | null): void {
    if (seed === this.seed) return;
    this.stop();
    this.seed = seed;
    if (seed === null) return;
    const field = cutFieldOpts(seed);
    this.streamer = new CutFieldStreamer(field, {
      visitShips: (cb) => { const p = this.deps.localPose(); if (p) cb(p.x, p.y); },
      spawnRock: (id, rock) => { this.rocks.set(id, { body: fieldRockBody(rock), key: rock.key, inPred: false }); return true; },
      removeRock: (id) => this.dropRock(id),
      nowMs: () => this.deps.gameClock.now(),
      chunkLoaded: (cx, cy, rocks) => this.deps.draw.setFieldChunk(cx, cy, packOutlines(rocks)),
      chunkUnloaded: (cx, cy) => this.deps.draw.setFieldChunk(cx, cy, null),
      cutChunk: (cx, cy) => this.cutChunk(field, cx, cy),
    }, CLIENT_WAKE_CHUNKS, CLIENT_LINGER_MS, CLIENT_CUTS_PER_STEP);
    this.timer = setInterval(() => this.step(), CLIENT_STEP_MS);
  }

  /** One slow step: cut at most one chunk, then stream predWorld bodies. */
  step(): void {
    if (!this.streamer) return;
    this.streamer.step();
    this.syncPred();
  }

  /** Sector change or disconnect: drop every chunk and body. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.streamer?.clear();
    this.streamer = null;
    this.seed = null;
    this.cuts.clear();
    this.awake.clear();
    this.inFlight = 0;
    this.gen++;
  }

  /** The streamer's cut hook: the chunk's rocks once the pool has cut them,
   *  else null (asked again next step). Inline without a pool. */
  private cutChunk(field: ChunkOpts, cx: number, cy: number): readonly ChunkRock[] | null {
    const cutter = this.inline ? null : this.deps.cutter?.() ?? null;
    if (!cutter?.cutChunk) return rocksInChunk(field, cx, cy);
    const key = `${cx},${cy}`;
    const have = this.cuts.get(key);
    if (have) { this.cuts.delete(key); return have; }
    if (have === null || this.inFlight >= MAX_CUTS_IN_FLIGHT) return null;
    this.cuts.set(key, null);
    this.inFlight++;
    const gen = this.gen;
    cutter.cutChunk(field, cx, cy).then((rocks) => {
      if (gen !== this.gen) return;
      this.inFlight--;
      this.cuts.set(key, rocks);
      this.trimReady();
    }, () => {
      if (gen !== this.gen) return;
      // The pool failed: cut inline from now on (same rocks, #15).
      this.inFlight--;
      this.cuts.delete(key);
      this.inline = true;
    });
    return null;
  }

  /** Drop the oldest finished cuts the ship flew away from before using. */
  private trimReady(): void {
    let ready = 0;
    for (const v of this.cuts.values()) if (v) ready++;
    for (const [k, v] of this.cuts) {
      if (ready <= MAX_READY_CUTS) break;
      if (v) { this.cuts.delete(k); ready--; }
    }
  }

  private syncPred(): void {
    const pw = this.deps.predWorld();
    const me = this.deps.localPose();
    const now = this.deps.gameClock.now();
    for (const [k, seen] of this.awake) {
      if (now - seen > FIELD_AWAKE_FORGET_MS) this.awake.delete(k);
    }
    let n = 0;
    for (const [id, r] of this.rocks) {
      const b = r.body;
      const want = pw !== null && me !== null && !this.awake.has(r.key)
        && wantPredBody(r.inPred, Math.hypot(b.x - me.x, b.y - me.y) - b.radius);
      if (want && !r.inPred) {
        pw.spawnObstacle(id, b.x, b.y, b.radius, FIELD_ROCK_PRED_MASS, b.verts);
        pw.fixBody(id);
        r.inPred = true;
      } else if (!want && r.inPred) {
        if (pw) pw.despawnShip(id);
        r.inPred = false;
      }
      if (r.inPred) n++;
    }
    this.stats.predBodies = n;
    this.stats.awake = this.awake.size;
  }

  private dropRock(id: string): void {
    const r = this.rocks.get(id);
    if (!r) return;
    if (r.inPred) this.deps.predWorld()?.despawnShip(id);
    this.rocks.delete(id);
  }
}

/** A chunk's outlines as one flat array (cheap to post to the render worker). */
export function packOutlines(rocks: readonly ChunkRock[]): Float32Array {
  let len = 0;
  for (const r of rocks) len += 1 + r.verts.length * 2;
  const out = new Float32Array(len);
  let i = 0;
  for (const r of rocks) {
    out[i++] = r.verts.length;
    for (const v of r.verts) { out[i++] = v.x; out[i++] = v.y; }
  }
  return out;
}
