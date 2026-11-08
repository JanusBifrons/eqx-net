/**
 * GPU-lit art (plan prancy-squishing-donut R2, `?shiplight=gpu`): the one
 * lighting pass a frame.
 *
 * Every lit mesh (hulls, capital tiles, guns, structures, rocks) registers
 * here when built and leaves when destroyed. Each frame the renderer begins
 * the pass, the effects add their lights (engines, shots, explosions) to
 * `scene`, and `finish` lights every visible mesh from its pose in the world
 * container: big hulls first become occluders, then each mesh takes the sun,
 * its nearest lights and occluders.
 *
 * Alloc-free per frame (invariant #14): scratch matrices and grown arrays.
 */
import { Matrix, type Container } from 'pixi.js';
import type { LightingSettings } from './lightingSettings.js';
import { LitScene, type LitShipMesh } from './litShipShader.js';
import type { LightRig } from './shade.js';

/** What makes a hull an occluder (capitals): its box and height, world u. */
export interface OccluderInfo { hx: number; hy: number; h: number; color: number }

export class LitPass {
  readonly scene = new LitScene();
  /** The settings lit art is built with; null = GPU lighting off. */
  settings: LightingSettings | null = null;
  private readonly meshes: LitShipMesh[] = [];
  private readonly occ: Array<OccluderInfo | null> = [];
  private px = new Float64Array(64);
  private py = new Float64Array(64);
  private pr = new Float64Array(64);
  private readonly m = new Matrix();
  private readonly w = new Matrix();
  private readonly r = new Matrix();
  private nextId = 0;
  /** Meshes lit last frame (diagnostic). */
  lastLit = 0;

  /** A fresh id for a hull's engines / occluder. */
  newId(): number { return this.nextId++; }

  register(mesh: LitShipMesh, occ: OccluderInfo | null = null): void {
    if (this.meshes.includes(mesh)) return;
    this.meshes.push(mesh);
    this.occ.push(occ);
    mesh.once('destroyed', () => this.unregister(mesh));
  }

  unregister(mesh: LitShipMesh): void {
    const i = this.meshes.indexOf(mesh);
    if (i < 0) return;
    const last = this.meshes.length - 1;
    this.meshes[i] = this.meshes[last]!; this.occ[i] = this.occ[last]!;
    this.meshes.pop(); this.occ.pop();
  }

  get count(): number { return this.meshes.length; }

  /** Start a frame: clear the lights (the effects add this frame's). */
  begin(): void { this.scene.begin(); this.attachedCount = 0; }

  // Lights pinned to a display object (a gun's muzzle flash): placed at the
  // object's position in the world when the frame is lit.
  private readonly attObj: Container[] = [];
  private attNum = new Float64Array(5 * 16);
  private attachedCount = 0;

  /** A light at `obj`'s origin this frame (it follows rotation and recoil). */
  attachLight(obj: Container, color: number, intensity: number, reach: number, z: number): void {
    const i = this.attachedCount++;
    this.attObj[i] = obj;
    if (this.attNum.length < (i + 1) * 5) { const n = new Float64Array(this.attNum.length * 2); n.set(this.attNum); this.attNum = n; }
    const a = this.attNum;
    a[i * 5] = color; a[i * 5 + 1] = intensity; a[i * 5 + 2] = reach; a[i * 5 + 3] = z;
  }

  /** Light every visible registered mesh under `world` (call before render). */
  finish(world: Container, rig: LightRig, resolution = 1): void {
    const n = this.meshes.length;
    if (this.px.length < n) { this.px = new Float64Array(n * 2); this.py = new Float64Array(n * 2); this.pr = new Float64Array(n * 2); }
    world.getGlobalTransform(this.w, false).invert();
    for (let i = 0; i < this.attachedCount; i++) {
      this.attObj[i]!.getGlobalTransform(this.m, false);
      this.r.copyFrom(this.w).append(this.m);
      const a = this.attNum;
      this.scene.addLight(this.r.tx, this.r.ty, a[i * 5 + 3]!, a[i * 5]!, a[i * 5 + 1]!, a[i * 5 + 2]!);
    }
    // Poses first (and capitals as occluders), so every hull sees them all.
    for (let i = 0; i < n; i++) {
      const mesh = this.meshes[i]!;
      if (!shownUnder(mesh, world)) { this.px[i] = NaN; continue; }
      mesh.getGlobalTransform(this.m, false);
      mesh.setScreenScale(Math.hypot(this.m.a, this.m.b) * resolution);
      this.r.copyFrom(this.w).append(this.m);
      const x = this.r.tx, y = this.r.ty, rot = Math.atan2(this.r.b, this.r.a);
      this.px[i] = x; this.py[i] = y; this.pr[i] = rot;
      const o = this.occ[i];
      if (o && mesh.occluderId >= 0) this.scene.addOccluder(mesh.occluderId, x, y, rot, o.hx, o.hy, o.h, o.color, 0.8);
    }
    let lit = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(this.px[i]!)) continue;
      this.meshes[i]!.setLight(rig, this.px[i]!, this.py[i]!, this.pr[i]!, this.scene);
      lit++;
    }
    this.lastLit = lit;
  }
}

/** True when the mesh and every parent up to `world` are visible. */
function shownUnder(c: Container, world: Container): boolean {
  let p: Container | null = c;
  while (p) {
    if (!p.visible || !p.renderable) return false;
    if (p === world) return true;
    p = p.parent;
  }
  return false;
}

/** The pass of this thread's renderer (one game renderer per thread). */
export const litPass = new LitPass();
