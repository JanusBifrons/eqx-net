/**
 * Placed rocks and cut rock pieces in ONE mesh (one draw call however many),
 * the way a field chunk mesh holds a chunk's rocks: the same fan data
 * (`FieldChunkMeshData`, `placedRockMesh.ts`) and the same rock shader
 * (`fieldRockBatchProgram`: per-vertex axes and colour, otherwise the chunk
 * shader). A lone Mesh per rock is one draw per rock: Pixi never batches a
 * custom-shader mesh.
 *
 * Each rock or piece is a `RockBatchMember`: an empty Container that stands
 * in the scene where its mesh used to (the swarm updater moves, turns, tints
 * and hides it as before; a piece's sits in its `WreckPieceSprite`). Before
 * each render (`onRender`) the batch reads each member's pose, colour and
 * visibility up to the batch's parent and writes that member's vertices when
 * any of them changed: positions into the batch's frame, `aXf` (its axes, for
 * the sun) and `aTint`. A hidden or detached member collapses to a point. The
 * vertex arrays are rebuilt only when a member is added or destroyed.
 *
 * The batch draws where `layer` sits (the renderer puts it in the ship layer,
 * under the hulls, wreck glows and far-zoom specks).
 */
import { Container, Mesh, MeshGeometry, Rectangle, type Shader } from 'pixi.js';
import type { FieldChunkMeshData } from './CutFieldLayer';

/** A rock or piece drawn by a `RockBatch` (its data in its own body frame). */
export class RockBatchMember extends Container {
  /** Where its vertices start in the batch (set on each rebuild). */
  v0 = 0;
  /** Its pose, colour and shown state as last written (NaN: never). */
  readonly last = new Float64Array(8).fill(NaN);
  constructor(readonly data: FieldChunkMeshData) {
    super();
    // Its size for `width` / `getBounds` (it draws nothing itself).
    const p = data.positions;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i]!, y = p[i + 1]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x0 <= x1) this.boundsArea = new Rectangle(x0, y0, x1 - x0, y1 - y0);
  }
}

/** Scratch: a member's pose in the batch's frame, colour and shown state. */
const cur = new Float64Array(8);

export class RockBatch {
  /** Put this where the rocks draw. */
  readonly layer = new Container();
  private readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly members: RockBatchMember[] = [];
  private rebuild = false;
  private xf = new Float32Array(0);
  private tint = new Float32Array(0);

  constructor(shader: Shader) {
    this.layer.label = 'rock-batch';
    this.layer.eventMode = 'none';
    const geometry = new MeshGeometry({ positions: new Float32Array(6), uvs: new Float32Array(6), indices: new Uint32Array(3) });
    geometry.addAttribute('aLocal', { buffer: new Float32Array(6), format: 'float32x2' });
    geometry.addAttribute('aRock', { buffer: new Float32Array(12), format: 'float32x4' });
    geometry.addAttribute('aOre', { buffer: new Float32Array(6), format: 'float32x2' });
    geometry.addAttribute('aXf', { buffer: new Float32Array(12), format: 'float32x4' });
    geometry.addAttribute('aTint', { buffer: new Float32Array(12), format: 'float32x4' });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.visible = false;
    this.mesh.once('destroyed', () => geometry.destroy());
    this.layer.addChild(this.mesh);
    // Every render, after the frame's sprite updates (also with the mesh hidden).
    this.layer.onRender = () => this.sync();
  }

  get count(): number { return this.members.length; }

  /** A new member for `d` (its data arrays are kept as they are). */
  add(d: FieldChunkMeshData): RockBatchMember {
    const m = new RockBatchMember(d);
    this.members.push(m);
    this.rebuild = true;
    m.once('destroyed', () => {
      const i = this.members.indexOf(m);
      if (i >= 0) { this.members.splice(i, 1); this.rebuild = true; }
    });
    return m;
  }

  /** Write the batch for this frame (Pixi calls it before each render). */
  sync(): void {
    if (this.rebuild) this.build();
    if (this.members.length === 0) return;
    const g = this.mesh.geometry;
    const pos = g.positions;
    const stop = this.layer.parent;
    let changed = false;
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i]!;
      poseOf(m, stop);
      const last = m.last;
      let same = true;
      for (let k = 0; k < 8; k++) if (last[k] !== cur[k]) { same = false; break; }
      if (same) continue;
      last.set(cur);
      changed = true;
      const p = m.data.positions, nv = p.length / 2, v0 = m.v0;
      const a = cur[0]!, b = cur[1]!, c = cur[2]!, d = cur[3]!, tx = cur[4]!, ty = cur[5]!;
      const shown = cur[7] === 1;
      for (let v = 0; v < nv; v++) {
        const x = p[v * 2]!, y = p[v * 2 + 1]!, o = (v0 + v) * 2;
        // Hidden: every vertex on one point (no area, nothing drawn).
        pos[o] = shown ? a * x + c * y + tx : tx;
        pos[o + 1] = shown ? b * x + d * y + ty : ty;
      }
      const col = cur[6]!, al = ((col >>> 24) & 255) / 255;
      const r = ((col >>> 16) & 255) / 255 * al, gg = ((col >>> 8) & 255) / 255 * al, bl = (col & 255) / 255 * al;
      for (let v = v0 * 4, e = (v0 + nv) * 4; v < e; v += 4) {
        this.xf[v] = a; this.xf[v + 1] = b; this.xf[v + 2] = c; this.xf[v + 3] = d;
        this.tint[v] = r; this.tint[v + 1] = gg; this.tint[v + 2] = bl; this.tint[v + 3] = al;
      }
    }
    if (!changed) return;
    g.getBuffer('aPosition').update();
    g.getBuffer('aXf').update();
    g.getBuffer('aTint').update();
  }

  /** Lay every member's vertices out afresh (a member came or went). */
  private build(): void {
    this.rebuild = false;
    let verts = 0, tris = 0;
    for (const m of this.members) { verts += m.data.positions.length / 2; tris += m.data.indices.length; }
    this.mesh.visible = verts > 0 && tris > 0;
    if (!this.mesh.visible) return;
    const positions = new Float32Array(verts * 2), uvs = new Float32Array(verts * 2), local = new Float32Array(verts * 2);
    const rock = new Float32Array(verts * 4), ore = new Float32Array(verts * 2), indices = new Uint32Array(tris);
    this.xf = new Float32Array(verts * 4);
    this.tint = new Float32Array(verts * 4);
    let v = 0, t = 0;
    for (const m of this.members) {
      const d = m.data, n = d.positions.length / 2;
      m.v0 = v;
      m.last.fill(NaN);
      uvs.set(d.uvs, v * 2); local.set(d.local, v * 2); rock.set(d.rock, v * 4); ore.set(d.ore, v * 2);
      for (let i = 0; i < d.indices.length; i++) indices[t + i] = d.indices[i]! + v;
      v += n; t += d.indices.length;
    }
    const g = this.mesh.geometry;
    g.positions = positions;
    g.uvs = uvs;
    g.indices = indices;
    g.getBuffer('aLocal').data = local;
    g.getBuffer('aRock').data = rock;
    g.getBuffer('aOre').data = ore;
    g.getBuffer('aXf').data = this.xf;
    g.getBuffer('aTint').data = this.tint;
  }
}

/** A 0..1 channel as a byte. */
const q = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

/** `m`'s pose in `stop`'s frame (a, b, c, d, tx, ty), its colour (0xAARRGGBB,
 *  tints and alphas multiplied up to `stop`) and shown (1: it and every
 *  ancestor below `stop` visible, renderable, not culled, and it reaches
 *  `stop`), into `cur`. */
function poseOf(m: Container, stop: Container | null): void {
  let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
  let r = 1, g = 1, bl = 1, al = 1, shown = true;
  let node: Container | null = m;
  while (node !== null && node !== stop) {
    if (!node.visible || !node.renderable || node.culled) shown = false;
    node.updateLocalTransform();
    const L = node.localTransform;
    // (a..ty) = L * (a..ty): the parent's transform after the child's.
    const na = L.a * a + L.c * b, nb = L.b * a + L.d * b;
    const nc = L.a * c + L.c * d, nd = L.b * c + L.d * d;
    const ntx = L.a * tx + L.c * ty + L.tx, nty = L.b * tx + L.d * ty + L.ty;
    a = na; b = nb; c = nc; d = nd; tx = ntx; ty = nty;
    const t = node.tint;
    r *= ((t >> 16) & 255) / 255; g *= ((t >> 8) & 255) / 255; bl *= (t & 255) / 255;
    al *= node.alpha;
    node = node.parent;
  }
  if (node !== stop) shown = false;
  cur[0] = a; cur[1] = b; cur[2] = c; cur[3] = d; cur[4] = tx; cur[5] = ty;
  cur[6] = ((q(al) << 24) | (q(r) << 16) | (q(g) << 8) | q(bl)) >>> 0;
  cur[7] = shown ? 1 : 0;
}
