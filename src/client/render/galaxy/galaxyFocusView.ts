import { Container, Graphics } from 'pixi.js';
import { axialToPixel, getSector, GALAXY_SECTORS } from '@core/galaxy/galaxy';
import type { Camera } from '../worker/Camera';
import { hexFlat } from './galaxyHexDraw';
import { factionBorderColor } from './galaxyTerritories';
import {
  FOCUS_GLIDE_MS,
  FOCUS_IDLE,
  focusFrame,
  focusHidesHover,
  focusPanelDock,
  focusPanelInsets,
  focusStep,
  focusTapResult,
  hopArrow,
  type FocusEvent,
  type FocusFrame,
  type FocusState,
  type FocusTap,
} from './galaxyFocus';

/** Veil over the sectors that are neither focused nor a hop target. */
const VEIL_COLOR = 0x05070d;
const VEIL_ALPHA = 0.74;
/** Veil fade rate (alpha per ms) — reaches full in about the glide time. */
const VEIL_RATE = VEIL_ALPHA / 450;
/** A lit neighbour's edge (map px; the camera zooms it with the hex). */
const LIT_EDGE_W = 2.2;

/**
 * The Pixi side of the galaxy map FOCUS VIEW (decisions in `galaxyFocus.ts`).
 * Owned by `GalaxyMapLayer`: it drives the layer's existing pan/zoom `Camera`
 * with `glideTo` (centre + zoom), veils every sector except the focused one
 * and its linked neighbours, and lights those neighbours (a bright edge in the
 * owner's border colour plus an arrow on the shared edge) as hop targets.
 * Everything is redrawn on a focus change only; the per-frame `tick` just fades
 * the veil and watches for the glide to land, and does nothing at all while idle.
 */
export class GalaxyFocusView {
  private state: FocusState = FOCUS_IDLE;
  private neighbours: string[] = [];
  private readonly litSprites: Graphics[] = [];
  private readonly veil = new Graphics();
  private readonly litLayer = new Container();
  private readonly veilFlat: number[];
  private readonly litFlat: number[];
  private screenW = 0;
  private screenH = 0;
  private touch = false;

  constructor(
    private readonly camera: Camera,
    private readonly root: Container,
    private readonly hexR: number,
    private readonly reducedMotion: boolean,
    /** Live owner of a sector (the layer's `resolveSectorOwner`). */
    private readonly ownerOf: (key: string) => string,
  ) {
    this.veilFlat = hexFlat(hexR * 1.02);
    this.litFlat = hexFlat(hexR * 0.97);
    this.veil.alpha = 0;
    this.veil.visible = false;
    this.litLayer.visible = false;
    root.addChild(this.veil, this.litLayer);
  }

  /** The focused sector (null when idle or backing out). */
  get key(): string | null {
    return this.state.key;
  }

  /** Open (or hop) the focus on `key`, or back out on null. */
  set(key: string | null, screenW: number, screenH: number, touch: boolean): void {
    this.screenW = screenW;
    this.screenH = screenH;
    this.touch = touch;
    if (key !== null && !getSector(key)) key = null;
    this.apply(key === null ? { type: 'close' } : { type: 'open', key, view: this.currentView() });
  }

  /** Drop the focus at once (the map hid). */
  reset(): void {
    if (this.state.phase === 'idle') return;
    this.camera.cancelGlide();
    this.state = FOCUS_IDLE;
    this.veil.alpha = 0;
    this.veil.visible = false;
    this.litLayer.visible = false;
  }

  /** A pointer went down: a drag or pinch mid-glide stops the glide there. */
  onPointerDown(): void {
    if ((this.state.phase === 'in' || this.state.phase === 'out') && this.camera.isGliding()) {
      this.camera.cancelGlide();
      this.apply({ type: 'interrupt' });
    }
  }

  /** Resolve a confirmed tap (`hexKey` = the layer's own hit test). */
  tap(hexKey: string | null): FocusTap {
    return focusTapResult(this.state.key, this.neighbours, hexKey);
  }

  /** Hide the hover tooltip for this hex? (gliding, or the focused hex) */
  hidesHover(hoverKey: string): boolean {
    return focusHidesHover(this.state.phase, this.state.key, hoverKey);
  }

  /** The screen changed size (the layer has just re-seeded its camera):
   *  that view is the new home, and the focus re-frames at once. */
  onResize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    if (this.state.key === null) return;
    this.state = { ...this.state, home: this.currentView() };
    this.glideToKey(1);
  }

  /** The feed changed owners: recolour the lit neighbours. */
  refresh(): void {
    if (this.state.key !== null) this.drawLit(this.state.key);
  }

  /** Per frame (selector map only). Allocates nothing; idle does nothing. */
  tick(dtMs: number): void {
    const phase = this.state.phase;
    if (phase === 'idle') return;
    if ((phase === 'in' || phase === 'out') && !this.camera.isGliding()) this.apply({ type: 'arrived' });
    const want = this.state.key !== null ? VEIL_ALPHA : 0;
    const a = this.veil.alpha;
    const step = this.reducedMotion ? 1 : VEIL_RATE * dtMs;
    this.veil.alpha = want > a ? Math.min(want, a + step) : Math.max(want, a - step);
    this.litLayer.alpha = this.veil.alpha / VEIL_ALPHA;
    if (this.state.phase === 'idle' && this.veil.alpha === 0) {
      this.veil.visible = false;
      this.litLayer.visible = false;
    }
  }

  /** DEV/E2E: the focus phase, sector and its lit (hop target) neighbours. */
  debug(): { phase: string; key: string | null; neighbours: string[] } {
    return { phase: this.state.phase, key: this.state.key, neighbours: this.neighbours.slice() };
  }

  private apply(e: FocusEvent): void {
    const { state, glide } = focusStep(this.state, e);
    this.state = state;
    if (glide === 'to-key' && state.key !== null) {
      this.drawFocus(state.key);
      this.glideToKey(this.reducedMotion ? 1 : FOCUS_GLIDE_MS);
    } else if (glide === 'home' && state.home !== null) {
      const h = state.home;
      this.camera.glideTo(h.cx, h.cy, this.reducedMotion ? 1 : FOCUS_GLIDE_MS, h.scale);
    }
  }

  private glideToKey(ms: number): void {
    const key = this.state.key;
    const sec = key !== null ? getSector(key) : undefined;
    if (!sec || this.screenW === 0 || this.screenH === 0) return;
    const p = axialToPixel(sec.hex, this.hexR);
    const dock = focusPanelDock(this.screenH > this.screenW);
    const insets = focusPanelInsets(dock, this.screenW, this.screenH, this.touch);
    const f = focusFrame(p.x, p.y, this.hexR, this.screenW, this.screenH, insets);
    this.camera.glideTo(f.cx, f.cy, ms, f.scale);
  }

  private currentView(): FocusFrame {
    const c = this.camera.center;
    return { scale: this.root.scale.x, cx: c.x, cy: c.y };
  }

  /** Veil every sector but the focused one and its linked neighbours, then
   *  light the neighbours. (Focus change only — not per frame.) */
  private drawFocus(key: string): void {
    const sec = getSector(key);
    if (!sec) return;
    this.neighbours = sec.neighbours.filter((k) => getSector(k) !== undefined);
    const v = this.veil;
    v.clear();
    const hole: number[] = new Array(this.veilFlat.length);
    for (const s of GALAXY_SECTORS) {
      if (s.key === key || this.neighbours.includes(s.key)) continue;
      const p = axialToPixel(s.hex, this.hexR);
      for (let k = 0; k < this.veilFlat.length; k += 2) {
        hole[k] = this.veilFlat[k]! + p.x;
        hole[k + 1] = this.veilFlat[k + 1]! + p.y;
      }
      v.poly(hole).fill(VEIL_COLOR);
    }
    v.visible = true;
    this.drawLit(key);
  }

  /** Each neighbour: a bright edge in its owner's border colour and an arrow
   *  on the edge it shares with the focused hex, pointing into it. */
  private drawLit(key: string): void {
    const sec = getSector(key);
    if (!sec) return;
    const c = axialToPixel(sec.hex, this.hexR);
    for (const g of this.litSprites) g.visible = false;
    for (let i = 0; i < this.neighbours.length; i++) {
      const ns = getSector(this.neighbours[i]!);
      if (!ns) continue;
      const n = axialToPixel(ns.hex, this.hexR);
      const color = factionBorderColor(this.ownerOf(ns.key));
      const g = this.litSprite(i);
      g.clear();
      g.poly(this.litFlat).stroke({ color, width: LIT_EDGE_W, alpha: 0.95 });
      g.position.set(n.x, n.y);
      const arrow = hopArrow(c.x, c.y, n.x, n.y, this.hexR);
      for (let k = 0; k < arrow.length; k += 2) {
        arrow[k] = arrow[k]! - n.x;
        arrow[k + 1] = arrow[k + 1]! - n.y;
      }
      g.poly(arrow).fill(color);
      g.visible = true;
    }
    this.litLayer.visible = true;
  }

  private litSprite(i: number): Graphics {
    let g = this.litSprites[i];
    if (!g) {
      g = new Graphics();
      this.litLayer.addChild(g);
      this.litSprites.push(g);
    }
    return g;
  }
}
