/**
 * Macro terrain v2 (room flag `cutField`): the client half of the cut field.
 *
 * The welcome carries only the field seed; no rock rides the wire. This cuts
 * the chunks around the local ship with the shared `CutFieldStreamer` (the
 * server runs the same one) on its own slow timer, one chunk per step. The
 * cutting itself (a few ms a chunk on a desktop, several times that on a
 * phone) runs in the page's art bake pool, so it never lands on a frame; the
 * pool also packs the chunk (`packChunk`: draw outlines, ore, bodies) and
 * transfers it, so the main thread does no per-rock work on arrival. Each
 * loaded chunk goes to the renderer as flat outlines (the mirror's
 * `pendingFieldChunks` drain queue);
 * only the rocks the local ship can touch get a locked predWorld body, streamed
 * by edge distance like structures (`wantPredBody`), because every correction
 * replays ~20 ticks over the whole predWorld.
 *
 * The body is `fieldRockBody` on both sides (#15): same centre, outline and id
 * (packed in float64, unpacked only for rocks that get a collider or wake).
 */

import type { PhysicsWorld } from '@core/physics/World';
import {
  CutFieldStreamer,
  cutFieldOpts,
  fieldRockId,
  type FieldRockBody,
} from '@core/terrain/chunkStreamer';
import { rocksInChunk, unpackRockKey, type ChunkOpts } from '@core/terrain/fieldLayout';
import { collapsePackedRock, packChunk, packedRockBody, type PackedChunk } from '@core/terrain/packedChunk';
import { FieldConsumedSchema } from '@shared-types/messages/snapshotMessages';
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
  cutChunk?(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk>;
}

/** Where chunk outlines go (ColyseusClient: the mirror's drain queue). */
export interface CutFieldDrawSink {
  /** Draw one chunk: `outlines` is [n, x0, y0, …, x(n-1), y(n-1), n, …] in
   *  game space; null drops the chunk. `ore`: [ice, crystal] per fan vertex
   *  (`oreForOutlines`), so the look shows where the ore is (F1c). */
  setFieldChunk(cx: number, cy: number, outlines: Float32Array | null, ore?: Float32Array | null): void;
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

/** A rock as this side's streamer sees it: a handle into its packed chunk. */
interface PackedRock { key: number; chunk: PackedChunk; i: number }
/** `body` is unpacked the first time the rock needs a collider or wakes. */
interface LoadedRock { chunk: PackedChunk; i: number; key: number; body: FieldRockBody | null; inPred: boolean }

/** The streamer's handles for a packed chunk (one small object per rock). */
function rocksOf(chunk: PackedChunk): PackedRock[] {
  const out: PackedRock[] = new Array(chunk.keys.length);
  for (let i = 0; i < out.length; i++) out[i] = { key: chunk.keys[i]!, chunk, i };
  return out;
}

const NO_OUTLINES = new Float32Array(0);
const NO_KEYS: readonly number[] = [];

const bodyOf = (r: LoadedRock): FieldRockBody => (r.body ??= packedRockBody(r.chunk, r.i));

export interface CutFieldSummary { chunks: number; rocks: number; predBodies: number; awake: number }

export class CutFieldClient implements FieldRockSource {
  private seed: string | null = null;
  private streamer: CutFieldStreamer<PackedRock> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rocks = new Map<string, LoadedRock>();
  /** Cuts asked of the pool: null while out, the rocks once back. */
  private readonly cuts = new Map<string, PackedChunk | null>();
  private inFlight = 0;
  /** Bumped on stop, so a cut that lands after it is dropped. */
  private gen = 0;
  private inline = false;
  /** Awake rocks (rock key → game ms last seen on the swarm wire): they
   *  collide as swarm bodies, so their fixed body stays out. */
  private readonly awake = new Map<number, number>();
  /** Broken-up rocks (C3): never a body, flattened out of their chunk's draw.
   *  The welcome's list, then each `field_consumed` (#16). */
  private readonly consumed = new Set<number>();
  /** Counters for tests and diagnostics (counts, never timings). */
  readonly stats = { predBodies: 0, awake: 0 };

  constructor(private readonly deps: CutFieldClientDeps) {}

  /** The asteroid leaf, for an awake field rock on the swarm wire: mark it
   *  awake, drop its fixed predWorld body, return its centred outline. */
  wakeFieldRock(key: number): FieldRockBody | null {
    this.awake.set(key, this.deps.gameClock.now());
    const id = fieldRockId(key);
    const r = this.rocks.get(id);
    if (!r) return null;
    if (r.inPred) {
      this.deps.predWorld()?.despawnShip(id);
      r.inPred = false;
    }
    return bodyOf(r);
  }

  get loadedRocks(): number { return this.rocks.size; }
  /** Counts for the E2E and perf scenes (allocates; never per frame). */
  summary(): CutFieldSummary {
    return { chunks: this.chunksLoaded, rocks: this.rocks.size, predBodies: this.stats.predBodies, awake: this.stats.awake };
  }
  get chunksLoaded(): number { return this.streamer?.stats.chunksLoaded ?? 0; }

  /** From the welcome: a seed turns the field on, null turns it off.
   *  `consumed` is the whole consumed set, so it replaces ours. */
  setSeed(seed: string | null, consumed: readonly number[] = NO_KEYS): void {
    if (seed !== this.seed) {
      this.stop();
      this.seed = seed;
      if (seed !== null) this.start(seed);
    }
    this.consumed.clear();
    for (const k of consumed) this.consume(k);
  }

  /** `field_consumed` from the server (validated here). */
  onConsumedMessage(raw: unknown): void {
    const r = FieldConsumedSchema.safeParse(raw);
    if (r.success && this.seed !== null) this.consume(r.data.k);
  }

  /** Rock `key` was broken up: drop its body and flatten it out of its
   *  chunk's draw (re-sent once, rare). Its pieces ride the wreck wire. */
  private consume(key: number): void {
    if (this.consumed.has(key)) return;
    this.consumed.add(key);
    this.awake.delete(key);
    const id = fieldRockId(key);
    const r = this.rocks.get(id);
    if (!r) return; // not loaded: its chunk skips it when cut
    collapsePackedRock(r.chunk, r.i);
    const { cx, cy } = unpackRockKey(key);
    this.deps.draw.setFieldChunk(cx, cy, r.chunk.outlines, r.chunk.ore);
    this.dropRock(id);
  }

  private start(seed: string): void {
    const field = cutFieldOpts(seed);
    this.streamer = new CutFieldStreamer<PackedRock>(field, {
      visitShips: (cb) => { const p = this.deps.localPose(); if (p) cb(p.x, p.y); },
      spawnRock: (id, rock) => {
        if (this.consumed.has(rock.key)) return false;
        this.rocks.set(id, { chunk: rock.chunk, i: rock.i, key: rock.key, body: null, inPred: false });
        return true;
      },
      removeRock: (id) => this.dropRock(id),
      nowMs: () => this.deps.gameClock.now(),
      chunkLoaded: (cx, cy, rocks) => {
        const c = rocks[0]?.chunk; // none: an empty chunk
        if (c && this.consumed.size > 0) for (let i = 0; i < c.keys.length; i++) if (this.consumed.has(c.keys[i]!)) collapsePackedRock(c, i);
        this.deps.draw.setFieldChunk(cx, cy, c?.outlines ?? NO_OUTLINES, c?.ore ?? NO_OUTLINES);
      },
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
  private cutChunk(field: ChunkOpts, cx: number, cy: number): readonly PackedRock[] | null {
    const cutter = this.inline ? null : this.deps.cutter?.() ?? null;
    if (!cutter?.cutChunk) return rocksOf(packChunk(rocksInChunk(field, cx, cy), field.seed));
    const key = `${cx},${cy}`;
    const have = this.cuts.get(key);
    if (have) { this.cuts.delete(key); return rocksOf(have); }
    if (have === null || this.inFlight >= MAX_CUTS_IN_FLIGHT) return null;
    this.cuts.set(key, null);
    this.inFlight++;
    const gen = this.gen;
    cutter.cutChunk(field, cx, cy).then((packed) => {
      if (gen !== this.gen) return;
      this.inFlight--;
      this.cuts.set(key, packed);
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
      const p = r.chunk.bodies, j = r.i * 3; // x, y, radius
      const dx = p[j]! - (me?.x ?? 0), dy = p[j + 1]! - (me?.y ?? 0);
      // sqrt, not Math.hypot: this runs over every loaded rock (thousands) a step.
      const want = pw !== null && me !== null && !this.awake.has(r.key)
        && wantPredBody(r.inPred, Math.sqrt(dx * dx + dy * dy) - p[j + 2]!);
      if (want && !r.inPred) {
        const b = bodyOf(r);
        pw.spawnObstacle(id, b.x, b.y, b.radius, FIELD_ROCK_PRED_MASS, b.verts, undefined, undefined, b.parts ?? undefined);
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
