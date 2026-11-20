/**
 * Unfold from a crate, the look (sunday base loop): a structure whose rig
 * carries the `unfold` clip (`core/articulation/unfoldRig.ts`, the Capital)
 * is posed by the rig as usual (the panels slide out of the crate block);
 * this adds what a pose cannot say, all from the scrubbed clip position
 * (`unfoldPosition`, 0 = crate .. 1 = standing), so a late joiner sees the
 * finished structure (#16):
 *  - 0 .. UNFOLD_OUT_AT: the panels slide out; the real body art is hidden
 *    (`bodyAlpha` 0), only the crate's panels show;
 *  - .. UNFOLD_FUSE_AT: every panel is in place; the seams between them glow up;
 *  - .. 1: they fuse: the panels and seams fade out as the body art fades in;
 *  - 1: panels and seams hidden, the body at full (nothing to draw).
 * Packing runs the same position backwards (`pack`).
 *
 * Allocation-free per frame (#14): one shared panel context, one seam
 * Graphics per view drawn once, only alpha / visibility change.
 */
import { Graphics, GraphicsContext } from 'pixi.js';
import { UNFOLD_FUSE_AT, UNFOLD_OUT_AT, isUnfoldPart } from '../../../core/articulation/unfoldRig.js';
import type { Rig } from '../../../core/articulation/rig.js';
import { RIVET, SLAB, SLAB_DARK, SLAB_LIGHT } from './structureStyleKit.js';

/** Seam glow colour (hot weld). */
export const UNFOLD_SEAM_COLOR = 0xffb050;

let panelCtx: GraphicsContext | null = null;
let panelKey = '';

/** One shared crate-panel context for `rig`'s panel size: a riveted slab
 *  plate with a darker inset and a cross brace (Pixi frame, y down). */
export function unfoldPanelContext(rig: Rig, i: number): GraphicsContext {
  const o = rig.parts[i]!.outline!;
  const hw = Math.abs(o[0]!), hh = Math.abs(o[1]!);
  const key = `${hw}x${hh}`;
  if (panelCtx !== null && panelKey === key) return panelCtx;
  const g = new GraphicsContext();
  g.rect(-hw, -hh, 2 * hw, 2 * hh).fill(SLAB).stroke({ color: SLAB_DARK, width: 4 });
  const ins = Math.min(hw, hh) * 0.18;
  g.rect(-hw + ins, -hh + ins, 2 * (hw - ins), 2 * (hh - ins)).fill(SLAB_LIGHT).stroke({ color: SLAB_DARK, width: 2 });
  g.moveTo(-hw + ins, -hh + ins).lineTo(hw - ins, hh - ins).moveTo(hw - ins, -hh + ins).lineTo(-hw + ins, hh - ins)
    .stroke({ color: SLAB_DARK, width: 3, alpha: 0.6 });
  const r = Math.max(2, ins * 0.18);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.circle(sx * (hw - ins / 2), sy * (hh - ins / 2), r).fill(RIVET);
  panelCtx = g;
  panelKey = key;
  return g;
}

/** The panels' alpha at position `p`: 1 until they fuse, then fading to 0. */
export function unfoldPanelAlpha(p: number): number {
  if (p >= 1) return 0;
  if (p <= UNFOLD_FUSE_AT) return 1;
  return (1 - p) / (1 - UNFOLD_FUSE_AT);
}

/** The seam glow at `p`: up from UNFOLD_OUT_AT to UNFOLD_FUSE_AT, then down
 *  with the fuse. */
export function unfoldSeamAlpha(p: number): number {
  if (p <= UNFOLD_OUT_AT || p >= 1) return 0;
  if (p <= UNFOLD_FUSE_AT) return (p - UNFOLD_OUT_AT) / (UNFOLD_FUSE_AT - UNFOLD_OUT_AT);
  return (1 - p) / (1 - UNFOLD_FUSE_AT);
}

/** The structure's own (body) art alpha at `p`: hidden until the fuse, then up. */
export function unfoldBodyAlpha(p: number): number {
  if (p >= 1) return 1;
  if (p <= UNFOLD_FUSE_AT) return 0;
  return (p - UNFOLD_FUSE_AT) / (1 - UNFOLD_FUSE_AT);
}

/** Per-view unfold state: the rig's panel parts and the seam grid. */
export class RigUnfold {
  readonly seams = new Graphics();
  /** Panel part indices (rig order). */
  private readonly panels: number[] = [];

  constructor(rig: Rig) {
    this.seams.label = 'rig-unfold-seams';
    this.seams.visible = false;
    for (let i = 0; i < rig.partCount; i++) {
      if (!isUnfoldPart(rig, i)) continue;
      this.panels.push(i);
      // The seams: every panel's edge at rest (Pixi y down).
      const o = rig.parts[i]!.outline!;
      const ax = rig.anchorX[i]!, ay = -rig.anchorY[i]!;
      const hw = Math.abs(o[0]!), hh = Math.abs(o[1]!);
      this.seams.rect(ax - hw, ay - hh, 2 * hw, 2 * hh);
    }
    this.seams.stroke({ color: UNFOLD_SEAM_COLOR, width: 10, alpha: 0.35 });
    this.seams.stroke({ color: 0xfff0c8, width: 3, alpha: 0.95 });
  }

  /** Show position `p` (0..1): panel and shadow alpha, the seam glow.
   *  Returns the body art alpha. Allocation-free. */
  apply(p: number, parts: readonly Graphics[], shadows: ReadonlyArray<Graphics | null>, shadowAlpha: number): number {
    const a = unfoldPanelAlpha(p);
    for (let k = 0; k < this.panels.length; k++) {
      const i = this.panels[k]!;
      const g = parts[i]!;
      g.visible = a > 0;
      g.alpha = a;
      const sh = shadows[i];
      if (sh) { sh.visible = a > 0; sh.alpha = shadowAlpha * a; }
    }
    const s = unfoldSeamAlpha(p);
    this.seams.visible = s > 0;
    this.seams.alpha = s;
    return unfoldBodyAlpha(p);
  }
}
