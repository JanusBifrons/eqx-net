/**
 * Edge placement — the fence run's ghosts, drawn by the placement ghost pass
 * (`updatePlacementGhost`, its `PlacementGhostCtx`: no second ghost system).
 *
 * Two runs, ONE look: each post is the placement ghost itself (a
 * `StructureHologram` in its `ghost` look, `updateGhost`) and each link the
 * deck fence beam (`drawFenceBeamBody`, pixi space: Y flipped).
 * - SENT (`preview.run`): posts sent but not landed, flat (x, y), a NaN pair
 *   between clicks. Solid: the sent ghost look, full beams.
 * - HOVER (`preview.runHover` + `runHoverMark`, `fenceRunHover.ts`): the run a
 *   click at the hovered corner would place. Faint: ghosts at
 *   {@link HOVER_ALPHA}, beams on a Graphics at {@link HOVER_BEAM_ALPHA}. The corner the
 *   click's verdict refuses (mark 2), or the first one the ghost's rock check
 *   refuses (`obstacles`, as the single ghost), draws red with a down-beam
 *   into it, and nothing past it draws. The hovered corner itself is the
 *   single ghost, so it is not drawn twice.
 *
 * Ghosts come from a lazily built pool capped at {@link RUN_GHOST_CAP}.
 * Allocation-free per frame after warm-up (#14).
 */
import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import type { GridObstacle } from '../../../core/structures/Grid.js';
import type { PlacementDeck } from '../../../core/structures/placementRules.js';
import { DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { DECK_CORNER_TOLERANCE } from '../../../core/hex/deckCorners.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { GhostPose, PlacementGhostVerdict } from '../../structures/placementGhostVerdict.js';
import { drawFenceBeamBody } from './connectorFenceBeam.js';
import { StructureHologram } from './structureHologram.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;
/** The preview's fence-run hover fields (client `PlacementPreview`). */

/** Most post ghosts drawn at once (sent + hover). */
export const RUN_GHOST_CAP = 24;
/** The hover run's alpha (posts and beams): faint next to the sent run. */
export const HOVER_ALPHA = 0.4;
/** The hover run's beams: stronger than its posts so the leg reads next to the green power line (owner, 2026-11-26). */
export const HOVER_BEAM_ALPHA = 0.7;

/** What one frame's run drawing needs (from the placement ghost ctx). */
export interface RunGhostFrame {
  mirror: RenderMirror;
  preview: Preview;
  verdict: PlacementGhostVerdict;
  obstacles: readonly GridObstacle[] | null;
  deck: PlacementDeck | null;
  /** The single ghost's drawn point (game space). */
  ghostX: number;
  ghostY: number;
  scale: number;
  nowMs: number;
}

const pose: GhostPose = { kind: DECK_FENCE_POST_KIND, x: 0, y: 0, angle: 0 };

export class PendingRunGhosts {
  private readonly posts: StructureHologram[] = [];
  private used = 0;
  private sentGfx: Graphics | null = null;
  private hoverGfx: Graphics | null = null;
  /** Probe counts for tests: posts and beams drawn last frame. */
  sentPosts = 0;
  hoverPosts = 0;
  hoverBeams = 0;
  /** Index (corner) of the red refused hover corner last frame, or -1. */
  hoverStop = -1;

  constructor(private readonly parent: Container, private readonly style: string | undefined) {}

  /** Draw this frame's runs (call after the single ghost). */
  update(f: RunGhostFrame): void {
    this.begin();
    const radius = getStructureKind(DECK_FENCE_POST_KIND).radius;
    this.sentPosts = this.drawSent(f, radius);
    this.drawHover(f, radius);
    this.end();
  }

  /** Hide everything (no preview). */
  hide(): void {
    this.begin();
    this.sentPosts = 0; this.hoverPosts = 0; this.hoverBeams = 0; this.hoverStop = -1;
    this.end();
  }

  private begin(): void {
    this.used = 0;
    this.sentGfx?.clear();
    this.hoverGfx?.clear();
  }

  private end(): void {
    for (let i = this.used; i < this.posts.length; i++) this.posts[i]!.visible = false;
  }

  private gfx(hover: boolean): Graphics {
    if (hover) {
      if (!this.hoverGfx) { this.hoverGfx = new Graphics(); this.hoverGfx.alpha = HOVER_BEAM_ALPHA; this.parent.addChild(this.hoverGfx); }
      return this.hoverGfx;
    }
    if (!this.sentGfx) { this.sentGfx = new Graphics(); this.parent.addChild(this.sentGfx); }
    return this.sentGfx;
  }

  /** The next pooled post ghost at (x, y) game space, or null at the cap. */
  private post(x: number, y: number, radius: number): StructureHologram | null {
    if (this.used >= RUN_GHOST_CAP) return null;
    let g = this.posts[this.used];
    if (g === undefined) {
      g = new StructureHologram(DECK_FENCE_POST_KIND, radius, this.style, 'ghost');
      this.parent.addChild(g);
      this.posts.push(g);
    }
    this.used++;
    g.visible = true;
    g.x = x; g.y = -y; g.rotation = 0; g.scale.x = 1;
    return g;
  }

  private drawSent(f: RunGhostFrame, radius: number): number {
    const run = f.preview.run;
    if (run === undefined || run.length < 2) return 0;
    let px = NaN, py = NaN, n = 0;
    for (let i = 0; i + 1 < run.length; i += 2) {
      const x = run[i]!, y = run[i + 1]!;
      if (Number.isFinite(px) && Number.isFinite(x) && (px !== x || py !== y)) {
        drawFenceBeamBody(this.gfx(false), px, -py, x, -y, f.scale, radius, radius, true);
      }
      px = x; py = y;
      if (!Number.isFinite(x)) continue;
      const g = this.post(x, y, radius);
      if (g) { g.updateGhost(false, true, f.nowMs); n++; }
    }
    return n;
  }

  private drawHover(f: RunGhostFrame, radius: number): void {
    const pv = f.preview;
    const hover = pv.runHover, mark = pv.runHoverMark;
    this.hoverPosts = 0; this.hoverBeams = 0; this.hoverStop = -1;
    if (hover === undefined || mark === undefined || hover.length < 2 || pv.pending === true) return;
    const sw = f.mirror.swarm;
    if (sw) f.verdict.prepare(f.mirror.structures, sw);
    const corners = hover.length >> 1;
    // The stop: the click's refused corner, or the first a rock refuses.
    let stop = -1;
    for (let c = 0; c < corners && c < mark.length; c++) {
      if (mark[c] === 2) { stop = c; break; }
      if (mark[c] === 1 && sw) {
        pose.x = hover[2 * c]!; pose.y = hover[2 * c + 1]!;
        if (f.verdict.checkPrepared(pose, f.obstacles, f.deck) !== null) { stop = c; break; }
      }
    }
    this.hoverStop = stop;
    const last = stop >= 0 ? stop : corners - 1;
    for (let c = 1; c <= last; c++) {
      const ax = hover[2 * c - 2]!, ay = hover[2 * c - 1]!, bx = hover[2 * c]!, by = hover[2 * c + 1]!;
      drawFenceBeamBody(this.gfx(true), ax, -ay, bx, -by, f.scale, radius, radius, c !== stop);
      this.hoverBeams++;
    }
    for (let c = 0; c <= last; c++) {
      if (mark[c] === 0) continue;
      const x = hover[2 * c]!, y = hover[2 * c + 1]!;
      // The hovered corner is the single ghost itself.
      if (Math.abs(x - f.ghostX) <= DECK_CORNER_TOLERANCE && Math.abs(y - f.ghostY) <= DECK_CORNER_TOLERANCE) continue;
      const g = this.post(x, y, radius);
      if (!g) break;
      g.updateGhost(c === stop, false, f.nowMs);
      g.alpha *= HOVER_ALPHA;
      this.hoverPosts++;
    }
  }
}
