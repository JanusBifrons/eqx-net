/**
 * Macro terrain v2 (room flag `cutField`): the client half of the cut field.
 *
 * The welcome carries only the field seed; no rock rides the wire. This cuts
 * the chunks around the local ship with the shared `CutFieldStreamer` (the
 * server runs the same one), off the frame on its own slow timer, one chunk
 * per step. Each loaded chunk goes to the renderer as flat outlines (the
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
  type FieldRockBody,
} from '@core/terrain/chunkStreamer';
import type { ChunkRock } from '@core/terrain/fieldLayout';
import { wantPredBody } from '../structures/predStructureStreaming.js';

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
}

interface LoadedRock { body: FieldRockBody; inPred: boolean }

export class CutFieldClient {
  private seed: string | null = null;
  private streamer: CutFieldStreamer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rocks = new Map<string, LoadedRock>();
  /** Counters for tests and diagnostics (counts, never timings). */
  readonly stats = { predBodies: 0 };

  constructor(private readonly deps: CutFieldClientDeps) {}

  get loadedRocks(): number { return this.rocks.size; }
  get chunksLoaded(): number { return this.streamer?.stats.chunksLoaded ?? 0; }

  /** From the welcome: a seed turns the field on, null turns it off. */
  setSeed(seed: string | null): void {
    if (seed === this.seed) return;
    this.stop();
    this.seed = seed;
    if (seed === null) return;
    this.streamer = new CutFieldStreamer(cutFieldOpts(seed), {
      visitShips: (cb) => { const p = this.deps.localPose(); if (p) cb(p.x, p.y); },
      spawnRock: (id, rock) => { this.rocks.set(id, { body: fieldRockBody(rock), inPred: false }); return true; },
      removeRock: (id) => this.dropRock(id),
      nowMs: () => this.deps.gameClock.now(),
      chunkLoaded: (cx, cy, rocks) => this.deps.draw.setFieldChunk(cx, cy, packOutlines(rocks)),
      chunkUnloaded: (cx, cy) => this.deps.draw.setFieldChunk(cx, cy, null),
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
  }

  private syncPred(): void {
    const pw = this.deps.predWorld();
    const me = this.deps.localPose();
    let n = 0;
    for (const [id, r] of this.rocks) {
      const b = r.body;
      const want = pw !== null && me !== null
        && wantPredBody(r.inPred, Math.hypot(b.x - me.x, b.y - me.y) - b.radius);
      if (want && !r.inPred) {
        pw.spawnObstacle(id, b.x, b.y, b.radius, FIELD_ROCK_PRED_MASS, b.verts);
        pw.lockBody(id);
        r.inPred = true;
      } else if (!want && r.inPred) {
        if (pw) pw.despawnShip(id);
        r.inPred = false;
      }
      if (r.inPred) n++;
    }
    this.stats.predBodies = n;
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
