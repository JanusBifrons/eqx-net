/**
 * Macro terrain v2 (room flag `cutField`): the cut-field chunks the client has
 * loaded, drawn with the owner-approved procedural rock look (the
 * `exp/terrain-look` big-rock shader, plan v2 B3): one Mesh per chunk, every
 * rock a fan from its centre whose per-vertex data (centre offset, radius,
 * noise seed) feeds `fieldRockShader.ts`. Built when the chunk arrives (no
 * triangulation: a fan per outline) and never touched per frame; per frame
 * only `setView` runs, a compare unless the camera zoom or the sun moved.
 */
import { Container, Mesh, MeshGeometry, Shader } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { CHUNK_SIZE, unpackRockKey } from '../../../core/terrain/fieldLayout';
import { packedRockBody, type PackedChunk } from '../../../core/terrain/packedChunk';
import type { FieldRockBody } from '../../../core/terrain/chunkStreamer';
import type { ObstacleBox } from '../../../core/structures/Grid';
import type { RestingFieldRock } from '../../structures/mirrorToGridNode';
import { fieldRockShaderResources, fieldRockProgram, setFieldOreStyle, setFieldRockView, type FieldOreStyle } from './fieldRockShader';

/** Chunk coords as one number (each fits ±32k). */
const chunkKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/** Per-rock vertex data for one chunk's packed outlines (game space in,
 *  Pixi space out: y flips). Exported for tests. */
export interface FieldChunkMeshData {
  positions: Float32Array; // aPosition: Pixi world
  uvs: Float32Array; // aUV.x: 1 at the rock's centre, 0 on its outline
  local: Float32Array; // aLocal: offset from the rock's centre (Pixi)
  rock: Float32Array; // aRock: radius, noise offset x/y, seed
  ore: Float32Array; // aOre: ice, crystal concentration (0..1) at the vertex
  indices: Uint32Array;
}

/** Mix a rock's centre into a stable seed (same rock, same surface). */
function rockSeed(x: number, y: number): number {
  let h = Math.imul(Math.round(x) | 0, 0x9e3779b1) ^ Math.imul(Math.round(y) | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

export function buildFieldChunkMesh(outlines: Float32Array, ore?: Float32Array | null): FieldChunkMeshData {
  let verts = 0, tris = 0, i = 0;
  while (i < outlines.length) { const n = outlines[i]!; verts += n + 1; tris += n; i += 1 + n * 2; }
  const positions = new Float32Array(verts * 2), uvs = new Float32Array(verts * 2);
  const local = new Float32Array(verts * 2), rock = new Float32Array(verts * 4);
  const indices = new Uint32Array(tris * 3);
  let v = 0, t = 0;
  i = 0;
  while (i < outlines.length) {
    const n = outlines[i++]!;
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += outlines[i + k * 2]!; my += outlines[i + k * 2 + 1]!; }
    mx /= n; my /= n;
    let r2 = 0;
    for (let k = 0; k < n; k++) {
      const dx = outlines[i + k * 2]! - mx, dy = outlines[i + k * 2 + 1]! - my;
      r2 = Math.max(r2, dx * dx + dy * dy);
    }
    const h = rockSeed(mx, my);
    const radius = Math.sqrt(r2), ox = ((h & 0xffff) / 65536) * 9000, oy = ((h >>> 16) / 65536) * 9000, seed = h & 0xffff;
    const c = v;
    // Centre (vT 1), then the outline (vT 0); Pixi y = -game y.
    for (let k = -1; k < n; k++) {
      const gx = k < 0 ? mx : outlines[i + k * 2]!, gy = k < 0 ? my : outlines[i + k * 2 + 1]!;
      positions[v * 2] = gx; positions[v * 2 + 1] = -gy;
      local[v * 2] = gx - mx; local[v * 2 + 1] = -(gy - my);
      uvs[v * 2] = k < 0 ? 1 : 0;
      rock[v * 4] = radius; rock[v * 4 + 1] = ox; rock[v * 4 + 2] = oy; rock[v * 4 + 3] = seed;
      v++;
    }
    for (let k = 0; k < n; k++) {
      indices[t++] = c; indices[t++] = c + 1 + k; indices[t++] = c + 1 + ((k + 1) % n);
    }
    i += n * 2;
  }
  const oreOut = ore && ore.length === verts * 2 ? ore : new Float32Array(verts * 2);
  return { positions, uvs, local, rock, ore: oreOut, indices };
}

/** Move rock `r`'s fan in `d` (first vertex `v0`, the centre, then `n`
 *  outline vertices) from where it was cut to body pose (x, y, angle), game
 *  space: each vertex keeps its offset from the body centre (`bodies`, the
 *  server's `fieldRockBody` centre; else the fan centre), turned by `angle`.
 *  `aLocal` stays in the rock's own frame, as on its woken sprite. Exported
 *  for the contract test. */
export function placeMovedRock(
  d: FieldChunkMeshData, v0: number, n: number, bodies: PackedChunk | null, r: number, x: number, y: number, angle: number,
): void {
  const p = d.positions;
  const bx = bodies && r * 3 + 1 < bodies.bodies.length ? bodies.bodies[r * 3]! : p[v0 * 2]!;
  const by = bodies && r * 3 + 1 < bodies.bodies.length ? bodies.bodies[r * 3 + 1]! : -p[v0 * 2 + 1]!;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let v = v0; v <= v0 + n; v++) {
    const dx = p[v * 2]! - bx, dy = -p[v * 2 + 1]! - by; // Pixi y flips back to game
    p[v * 2] = x + dx * cos - dy * sin;
    p[v * 2 + 1] = -(y + dx * sin + dy * cos);
  }
}

/** Frames a woken rock may go unseen on the swarm wire before it shows in its
 *  chunk again (its server chunk unloaded and will re-cut it in place). */
export const WOKEN_ROCK_FORGET_FRAMES = 120;

interface LoadedChunk {
  mesh: Mesh<MeshGeometry, Shader>;
  data: FieldChunkMeshData;
  /** Per rock (chunk order = rock index): its start in the packed outlines. */
  starts: Int32Array;
  /** Per rock: its first vertex (the centre) in `data`. */
  firstVert: Int32Array;
  outlines: Float32Array;
  ore: Float32Array | null;
  /** The packed chunk (bodies, convex parts), when the sink sent it. */
  bodies: PackedChunk | null;
  /** [index, x, y, angle] per moved rock (C2 deep sleep), or null. */
  moved: Float64Array | null;
  cx: number;
  cy: number;
}

/** Was the rock at `s` in packed outlines flattened out of the draw
 *  (`collapsePackedRock`: a consumed rock)? Every vertex on one point. */
function collapsedAt(o: Float32Array, s: number): boolean {
  const n = o[s]!;
  if (n < 2) return false;
  const x = o[s + 1]!, y = o[s + 2]!;
  for (let k = 1; k < n; k++) if (o[s + 1 + k * 2] !== x || o[s + 2 + k * 2] !== y) return false;
  return true;
}

export class CutFieldLayer {
  readonly container = new Container();
  private readonly chunks = new Map<number, LoadedChunk>();
  private shader: Shader | null = null;
  /** Woken rocks (rock key → the frame they were last seen awake): drawn by
   *  their swarm sprite, collapsed out of their chunk mesh. */
  private readonly woken = new Map<number, number>();
  private frame = 0;
  private _version = 0;

  constructor() {
    this.container.eventMode = 'none';
    this.container.label = 'cut-field';
  }

  get chunkCount(): number { return this.chunks.size; }
  /** Bumped whenever a chunk is set or dropped (a cache key for its rocks). */
  get version(): number { return this._version; }

  /** The ore look (`?ore=`, F1c trial): shared by every field rock. */
  setOreStyle(style: FieldOreStyle): void { setFieldOreStyle(style); }

  /** Per frame: the sector's sun (Pixi azimuth) and the camera zoom (world
   *  scale), so the surface detail stops at ~2 px. A compare unless moved. */
  /** Each frame: apply the chunks loaded or dropped since the last frame
   *  (`mirror.pendingFieldChunks`, rare; drained here), then `setView`. */
  update(mirror: RenderMirror, sunAz: number, cameraScale: number): void {
    const chunks = mirror.pendingFieldChunks;
    if (chunks && chunks.length > 0) {
      for (const c of chunks) this.setChunk(c.cx, c.cy, c.outlines, c.ore, c.bodies ?? null, c.moved ?? null);
      chunks.length = 0;
    }
    this.setView(sunAz, cameraScale);
  }

  setView(sunAz: number, cameraScale: number): void {
    this.frame++;
    if (this.chunks.size > 0) setFieldRockView(sunAz, cameraScale);
    for (const [key, seen] of this.woken) {
      if (this.frame - seen <= WOKEN_ROCK_FORGET_FRAMES) continue;
      this.woken.delete(key);
      this.showInChunk(key, true);
    }
  }

  /** Per frame, from the swarm sprite updater, for each awake field rock. */
  noteAwake(key: number): void {
    const had = this.woken.has(key);
    this.woken.set(key, this.frame);
    if (!had) this.showInChunk(key, false);
  }

  /** Rock `key`'s body (centred outline, convex parts: `fieldRockBody`, the
   *  server's own), unpacked from its chunk; null when its chunk or its bodies
   *  aren't here. Builds new arrays: the caller caches (`RockObstacleShapes`). */
  rockBody(key: number): FieldRockBody | null {
    const k = unpackRockKey(key);
    const c = this.chunks.get(chunkKey(k.cx, k.cy))?.bodies;
    if (!c || k.index >= c.keys.length || c.keys[k.index] !== key) return null;
    return packedRockBody(c, k.index);
  }

  /**
   * The link preview's dormant rocks (C5h, the client twin of the server's
   * `dormantObstacles`): every rock of a loaded chunk whose bounding circle
   * reaches into `box`, at rest where it was cut or at its moved pose (C2); a
   * consumed rock (flattened out of the draw) is skipped. Awake rocks are
   * included: the caller drops those it has from the swarm wire. Fills the
   * caller's pooled `out` in place and returns the count (allocates nothing
   * once `out` is warm). A rock belongs to the chunk it was cut in, so chunks
   * one past the box are scanned too, for big rocks reaching in.
   */
  restingRocksInBox(box: ObstacleBox, out: RestingFieldRock[]): number {
    let n = 0;
    for (const c of this.chunks.values()) {
      const b = c.bodies;
      if (!b) continue;
      const x0 = (c.cx - 1) * CHUNK_SIZE, y0 = (c.cy - 1) * CHUNK_SIZE;
      if (box.x1 < x0 || box.y1 < y0 || box.x0 > x0 + 3 * CHUNK_SIZE || box.y0 > y0 + 3 * CHUNK_SIZE) continue;
      const rocks = Math.min(b.keys.length, c.starts.length);
      const m = c.moved;
      for (let r = 0; r < rocks; r++) {
        let x = b.bodies[r * 3]!, y = b.bodies[r * 3 + 1]!, angle = 0;
        const rad = b.bodies[r * 3 + 2]!;
        if (m) for (let j = 0; j + 3 < m.length; j += 4) {
          if (m[j] === r) { x = m[j + 1]!; y = m[j + 2]!; angle = m[j + 3]!; break; }
        }
        const dx = Math.max(box.x0 - x, 0, x - box.x1), dy = Math.max(box.y0 - y, 0, y - box.y1);
        if (dx * dx + dy * dy >= rad * rad) continue;
        if (collapsedAt(c.outlines, c.starts[r]!)) continue;
        let e = out[n];
        if (e === undefined) { e = { key: 0, x: 0, y: 0, angle: 0, radius: 0 }; out[n] = e; }
        e.key = b.keys[r]!; e.x = x; e.y = y; e.angle = angle; e.radius = rad;
        n++;
      }
    }
    return n;
  }

  /** A woken rock's own sprite: its fan in local space (centre at 0,0, Pixi
   *  axes), same surface as in its chunk. Null when its chunk isn't loaded. */
  buildRockSprite(key: number): Mesh<MeshGeometry, Shader> | null {
    const k = unpackRockKey(key);
    const c = this.chunks.get(chunkKey(k.cx, k.cy));
    if (!c || k.index >= c.starts.length) return null;
    const s = c.starts[k.index]!;
    const v0 = c.firstVert[k.index]!, n = c.outlines[s]!;
    const d = buildFieldChunkMesh(c.outlines.subarray(s, s + 1 + n * 2), c.ore?.subarray(v0 * 2, (v0 + n + 1) * 2));
    d.positions.set(d.local); // centred: local == position minus the centre
    return this.meshOf(d);
  }

  /** Collapse a rock's fan onto its centre (hide) or restore it (show). */
  private showInChunk(key: number, show: boolean): void {
    const k = unpackRockKey(key);
    const c = this.chunks.get(chunkKey(k.cx, k.cy));
    if (!c || k.index >= c.starts.length) return;
    const n = c.outlines[c.starts[k.index]!]!;
    const v0 = c.firstVert[k.index]!;
    const pos = c.mesh.geometry.positions;
    const cx = c.data.positions[v0 * 2]!, cy = c.data.positions[v0 * 2 + 1]!;
    for (let v = v0 + 1; v <= v0 + n; v++) {
      pos[v * 2] = show ? c.data.positions[v * 2]! : cx;
      pos[v * 2 + 1] = show ? c.data.positions[v * 2 + 1]! : cy;
    }
    c.mesh.geometry.getBuffer('aPosition').update();
  }

  private meshOf(d: FieldChunkMeshData): Mesh<MeshGeometry, Shader> {
    const geometry = new MeshGeometry({ positions: d.positions.slice(), uvs: d.uvs, indices: d.indices });
    geometry.addAttribute('aLocal', { buffer: d.local, format: 'float32x2' });
    geometry.addAttribute('aRock', { buffer: d.rock, format: 'float32x4' });
    geometry.addAttribute('aOre', { buffer: d.ore, format: 'float32x2' });
    this.shader ??= new Shader({ glProgram: fieldRockProgram(), resources: fieldRockShaderResources() });
    const mesh = new Mesh({ geometry, shader: this.shader });
    mesh.once('destroyed', () => geometry.destroy());
    return mesh;
  }

  /** See `IRenderer.setFieldChunk`. Game space in, Pixi space out (y flips).
   *  `moved`: [index, x, y, angle] per moved rock (C2 deep sleep): its fan is
   *  drawn turned and moved to that body pose instead of where it was cut. */
  setChunk(
    cx: number, cy: number, outlines: Float32Array | null, ore: Float32Array | null = null,
    bodies: PackedChunk | null = null, moved: Float64Array | null = null,
  ): void {
    const key = chunkKey(cx, cy);
    this._version++;
    this.chunks.get(key)?.mesh.destroy();
    this.chunks.delete(key);
    if (outlines === null || outlines.length === 0) return;
    const data = buildFieldChunkMesh(outlines, ore);
    let rocks = 0;
    for (let i = 0; i < outlines.length; i += 1 + outlines[i]! * 2) rocks++;
    const starts = new Int32Array(rocks), firstVert = new Int32Array(rocks);
    for (let i = 0, r = 0, v = 0; i < outlines.length; i += 1 + outlines[i]! * 2, r++) {
      starts[r] = i; firstVert[r] = v; v += outlines[i]! + 1;
    }
    if (moved) for (let j = 0; j + 3 < moved.length; j += 4) {
      const r = moved[j]!;
      if (r < rocks) placeMovedRock(data, firstVert[r]!, outlines[starts[r]!]!, bodies, r, moved[j + 1]!, moved[j + 2]!, moved[j + 3]!);
    }
    const mesh = this.meshOf(data);
    this.chunks.set(key, { mesh, data, starts, firstVert, outlines, ore, bodies, moved, cx, cy });
    this.container.addChild(mesh);
    // A rock woken before this chunk (re)arrived stays out of it.
    for (const wk of this.woken.keys()) {
      const k = unpackRockKey(wk);
      if (k.cx === cx && k.cy === cy) this.showInChunk(wk, false);
    }
  }

  clear(): void {
    for (const c of this.chunks.values()) c.mesh.destroy();
    this.chunks.clear();
    this.woken.clear();
    this._version++;
  }
}
