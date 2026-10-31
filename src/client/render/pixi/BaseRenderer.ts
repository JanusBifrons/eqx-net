/**
 * Draws procedural bases (plan: soft-leaping-truffle, PR-V2).
 *
 * Budgets (baseBudgets.ts) it is built around:
 *  - ONE retained `Graphics` per chunk (+ one light layer per chunk), built
 *    ONCE from the pure `buildChunkVisual` plan — never redrawn per frame;
 *  - per-frame CULLING toggles `visible` from the camera bounds
 *    (`cullChunks`, allocation-free) — no draw cost for off-screen chunks;
 *  - below BASE_LOD_ZOOM a single SILHOUETTE `Graphics` per base replaces
 *    every chunk (the zoomed-out establishing shot costs one object);
 *  - no `cacheAsTexture` (a 1024 u chunk at zoom 3 would be ~36 MB, and it
 *    blurs when zoomed in — research §4.3).
 * Geometry is regenerated here from the descriptors (`setBases`), so it works
 * identically on the main-thread and the worker render paths.
 */
import { Container, Graphics } from 'pixi.js';
import { generateBase } from '../../../core/procgen/generateBase.js';
import type { BaseLayout } from '../../../core/procgen/baseLayout.js';
import { chunkCount, isPieceDead } from '../../../core/procgen/baseChunkMesh.js';
import { basePieceKindAt } from '../../../shared-types/basePieceKinds.js';
import { BASE_LOD_ZOOM } from '../../../shared-types/baseBudgets.js';
import type { BaseRenderDescriptor } from '../../../core/contracts/IRenderer.js';
import { BASE_PALETTE, buildChunkVisual, cullChunks, mixColor, useSilhouette } from './baseVisuals.js';

interface DrawnBase {
  readonly key: string;
  readonly layout: BaseLayout;
  readonly root: Container;
  readonly chunks: Graphics[];
  readonly lights: Graphics[];
  readonly silhouette: Graphics;
  readonly visible: Uint8Array;
}

export class BaseRenderer {
  readonly container = new Container();
  private bases: DrawnBase[] = [];
  /** Visible chunks last frame (budget-lock / E2E seam). */
  lastVisibleChunks = 0;
  /** True while bases drew as silhouettes last frame. */
  lastSilhouette = false;

  /** Replace the drawn bases. Rebuilds only bases whose descriptor changed. */
  setBases(descs: readonly BaseRenderDescriptor[]): void {
    const keep = new Map<string, DrawnBase>();
    for (const b of this.bases) keep.set(b.key, b);
    const next: DrawnBase[] = [];
    for (const d of descs) {
      const key = `${d.id}|${d.ver}|${d.archetype}|${d.seed}|${d.x}|${d.y}|${d.size}|${d.dead?.join(',') ?? ''}`;
      const existing = keep.get(key);
      if (existing) {
        keep.delete(key);
        next.push(existing);
        continue;
      }
      next.push(this.build(key, d));
    }
    for (const stale of keep.values()) {
      this.container.removeChild(stale.root);
      stale.root.destroy({ children: true });
    }
    this.bases = next;
  }

  private build(key: string, d: BaseRenderDescriptor): DrawnBase {
    const layout = generateBase({ ver: d.ver, archetype: d.archetype, seed: d.seed, x: d.x, y: d.y, size: d.size });
    const dead = d.dead ? Uint32Array.from(d.dead) : null;
    const root = new Container();
    const chunks: Graphics[] = [];
    const lights: Graphics[] = [];
    for (let c = 0; c < chunkCount(layout); c++) {
      const plan = buildChunkVisual(layout, c, dead);
      const g = new Graphics();
      for (const r of plan.rects) g.rect(r.x, r.y, r.w, r.h).fill({ color: r.color, alpha: r.alpha });
      const lg = new Graphics();
      for (const lt of plan.lights) {
        lg.circle(lt.x, lt.y, lt.r * 2.4).fill({ color: lt.color, alpha: 0.18 });
        lg.circle(lt.x, lt.y, lt.r).fill({ color: lt.color, alpha: 0.95 });
      }
      root.addChild(g);
      root.addChild(lg);
      chunks.push(g);
      lights.push(lg);
    }
    const silhouette = new Graphics();
    const sil = mixColor(BASE_PALETTE.hull, 0xffffff, 0.15);
    for (let i = 0; i < layout.count; i++) {
      if (isPieceDead(dead, i)) continue;
      const kind = basePieceKindAt(layout.kind[i]!);
      const gx = d.x + layout.x[i]!;
      const gy = d.y + layout.y[i]!;
      silhouette
        .rect(gx, -(gy + layout.h[i]!), layout.w[i]!, layout.h[i]!)
        .fill({ color: kind.solid ? (kind.id === 'rack_row' ? BASE_PALETTE.rack : sil) : BASE_PALETTE.floor, alpha: kind.solid ? 1 : 0.7 });
    }
    silhouette.visible = false;
    root.addChild(silhouette);
    this.container.addChild(root);
    return { key, layout, root, chunks, lights, silhouette, visible: new Uint8Array(chunks.length) };
  }

  /**
   * Per-frame: cull chunks to the camera view (pixi-space bounds
   * [minX, minY, maxX, maxY]) and switch to silhouettes when zoomed out.
   * `nowMs` drives the light pulse. Allocation-free.
   */
  update(view: Float64Array, zoom: number, nowMs: number): void {
    const silhouette = useSilhouette(zoom, BASE_LOD_ZOOM);
    const pulse = 0.55 + 0.45 * Math.sin(nowMs * 0.004);
    let visibleTotal = 0;
    for (let b = 0; b < this.bases.length; b++) {
      const base = this.bases[b]!;
      base.silhouette.visible = silhouette;
      if (silhouette) {
        for (let c = 0; c < base.chunks.length; c++) {
          base.chunks[c]!.visible = false;
          base.lights[c]!.visible = false;
        }
        continue;
      }
      visibleTotal += cullChunks(base.layout, view, base.visible);
      for (let c = 0; c < base.chunks.length; c++) {
        const v = base.visible[c] === 1;
        base.chunks[c]!.visible = v;
        const lg = base.lights[c]!;
        lg.visible = v;
        if (v) lg.alpha = pulse;
      }
    }
    this.lastVisibleChunks = visibleTotal;
    this.lastSilhouette = silhouette && this.bases.length > 0;
  }

  get baseCount(): number {
    return this.bases.length;
  }
}
