import { Container, Graphics, Text, TextStyle, Ticker } from 'pixi.js';
import {
  GALAXY_SECTORS,
  axialToPixel,
  type GalaxySector,
} from '@core/galaxy/galaxy';
import {
  isSectorSelectable,
  clusterFitFraction,
  type GalaxyLayerMode,
} from './galaxyLayerDecisions';
import { Camera } from '../worker/Camera';

/**
 * In-game additive galaxy-map layer (Map B).
 *
 * Lives as a screen-space child of the gameplay canvas's `app.stage`,
 * **above** the viewport — so it doesn't pan/zoom with the world camera.
 * Highly transparent: gameplay continues fully visible underneath, the
 * player keeps flying while choosing a destination.
 *
 * Three visual tiers:
 *  - **highlighted** (current sector): pulsing green outline at low fill.
 *  - **selectable** (neighbour): tappable, dim green fill, brighter stroke.
 *  - **non-adjacent**: stroke-only faint outline, non-interactive,
 *    preserving spatial context without competing with gameplay visuals.
 *
 * Pixi's hit-testing routes hex taps cleanly; non-hex regions pass through
 * to the viewport beneath, so input outside the hex graphics keeps reaching
 * gameplay (joystick, fire button) without any DOM-canvas hit-test trick.
 */

const HEX_SIZE_BASE = 64;

/**
 * Glyph rasterization resolution for the sector labels (WS-14 / R2.7 — "map
 * looks low-res / blurry"). The whole `clusterRoot` is fractionally downscaled
 * to fit (≈0.6 overlay / 0.85 selector), and a Pixi `Text` is a BAKED texture —
 * downscaling it off its native grid softens it (vector hex strokes stay
 * GPU-crisp; only the text texture blurs). Oversampling the glyph texture (≥ the
 * device pixel ratio of common phones) keeps the downscaled label crisp without
 * threading DPR into the worker-side layer; `roundPixels` snaps the final sprite
 * to integer device pixels so edges don't sub-pixel-blur. The on-device eye is
 * the [V] verdict (the blur is DPR-dependent and barely shows on a low-DPR dev box).
 */
export const MAP_LABEL_RESOLUTION = 3;

const COLOR_HIGHLIGHT = 0x00ff88;
const COLOR_SELECTABLE_FILL = 0x0a3322;
const COLOR_SELECTABLE_STROKE = 0x1f7a4d;
const COLOR_LOCKED_STROKE = 0x2a2f40;
const COLOR_LABEL = 0x00ff88;

interface HexEntry {
  sector: GalaxySector;
  x: number;
  y: number;
  hex: Graphics;
  label: Text;
}

function hexVertices(size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

export class GalaxyMapLayer extends Container {
  private readonly onSelect: (sectorKey: string) => void;
  private readonly edgeLayer = new Container();
  private readonly hexLayer = new Container();
  private readonly clusterRoot = new Container();
  private readonly entries: HexEntry[] = [];
  /** Dedup scratch for `repaintEdges` (invariant #14). Single-pass
   *  dedup of bidirectional neighbour pairs; cleared at the top of
   *  each repaint. */
  private readonly _edgeDedupScratch = new Set<string>();
  private currentSectorKey: string | null = null;
  private isDocked = true;
  /** `overlay` = in-game additive HUD (Map B, neighbours-only);
   *  `selector` = spawn/warp picker (Map A's role, every sector
   *  tappable, full-screen). Single-canvas refactor, 2026-06-05. */
  private mode: GalaxyLayerMode = 'overlay';
  private pulsePhase = 0;
  private screenW = 0;
  private screenH = 0;
  private hexSize = HEX_SIZE_BASE;
  private disposed = false;

  /**
   * Free pan / pinch / wheel zoom for the `selector` (spawn/warp picker)
   * mode — restored 2026-06-06 (the single-canvas refactor had dropped it).
   * Reuses the same hand-rolled {@link Camera} as the world camera, driving
   * the screen-space `clusterRoot` transform. Works in BOTH render paths
   * (main-thread DOM + worker) because the renderer routes raw canvas
   * pointer/wheel events here when {@link isPanZoomActive} is true. A tap
   * (vs drag) still selects a sector via {@link hitTest}. `overlay` mode (the
   * in-game additive MAP) keeps its static fit — no pan/zoom there.
   */
  private readonly panZoomCamera: Camera;
  /** Screen dims the pan/zoom camera was last seeded (fit) at. A resize with
   *  the SAME dims preserves the user's pan/zoom; a real size change re-fits. */
  private _seedW = 0;
  private _seedH = 0;

  constructor(opts: { onSelect: (sectorKey: string) => void }) {
    super();
    this.onSelect = opts.onSelect;
    this.visible = false;
    this.eventMode = 'passive';
    this.clusterRoot.addChild(this.edgeLayer);
    this.clusterRoot.addChild(this.hexLayer);
    this.addChild(this.clusterRoot);
    // The camera drives `clusterRoot`'s transform. minScale/maxScale are
    // generous absolute bounds that comfortably contain the 7-hex fit
    // (~0.5 on a phone) and a reasonable zoom range around it. No follow
    // target is ever set (the galaxy doesn't track a ship).
    this.panZoomCamera = new Camera(this.clusterRoot, { minScale: 0.12, maxScale: 4 });
    this.buildHexes();
    Ticker.shared.add(this.tick);
  }

  /** True while the spawn/warp picker is on screen — the window during which
   *  the renderer routes pointer/wheel events here for pan/zoom. */
  isPanZoomActive(): boolean {
    return this.mode === 'selector' && this.visible;
  }

  // ── Pan/zoom input (routed from the renderer's canvas listeners; screen
  //    px in the same frame the world camera uses). The camera mutates
  //    `clusterRoot`; `tick` eases the wheel zoom + momentum each frame. ──
  onPointerDown(pointerId: number, screenX: number, screenY: number, stamp: number): void {
    this.panZoomCamera.onPointerDown(pointerId, screenX, screenY, stamp);
  }
  onPointerMove(pointerId: number, screenX: number, screenY: number): void {
    this.panZoomCamera.onPointerMove(pointerId, screenX, screenY);
  }
  /** Returns true if the pointer cycle was a tap (and a sector was selected). */
  onPointerUp(pointerId: number, screenX: number, screenY: number, stamp: number): boolean {
    const result = this.panZoomCamera.onPointerUp(pointerId, screenX, screenY, stamp);
    if (result.wasTap) {
      const key = this.hitTest(screenX, screenY);
      if (key !== null) this.onSelect(key);
    }
    return result.wasTap;
  }
  onPointerCancel(pointerId: number): void {
    this.panZoomCamera.onPointerCancel(pointerId);
  }
  onWheel(deltaY: number, screenX: number, screenY: number): void {
    this.panZoomCamera.onWheel(deltaY, screenX, screenY);
  }

  /** Live `clusterRoot` transform — the REAL drawn pan/zoom state (not a
   *  recompute). Used by the DEV `__eqxGalaxyTransform` E2E hook. */
  getDebugTransform(): { x: number; y: number; scale: number } {
    return { x: this.clusterRoot.x, y: this.clusterRoot.y, scale: this.clusterRoot.scale.x };
  }

  setVisible(open: boolean): void {
    this.visible = open;
  }

  setCurrentSector(key: string | null): void {
    if (this.currentSectorKey === key) return;
    this.currentSectorKey = key;
    this.repaint();
    // Re-centre the cluster on the new sector so the player's "you are
    // here" hex moves to screen-centre after a warp completes (otherwise
    // the overlay always points at the launch sector regardless of where
    // you've warped to). Skip when we don't yet have screen dims.
    if (this.screenW > 0 && this.screenH > 0) this.resize(this.screenW, this.screenH);
  }

  setTransitDocked(docked: boolean): void {
    if (this.isDocked === docked) return;
    this.isDocked = docked;
    this.repaint();
  }

  /**
   * Switch between the in-game additive overlay (`overlay`) and the
   * full-screen spawn/warp picker (`selector`). Repaints selectability
   * and re-fits the cluster (the selector fills more of the viewport).
   */
  setMode(mode: GalaxyLayerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // Force the next resize to re-fit the pan/zoom camera (fresh fit on
    // entering the selector; clears any stale pan/zoom from a prior session).
    this._seedW = 0;
    this._seedH = 0;
    this.repaint();
    if (this.screenW > 0 && this.screenH > 0) this.resize(this.screenW, this.screenH);
  }

  /**
   * Custom hit-test for the worker-renderer path — Pixi's `events`
   * subsystem isn't initialised in worker context (no DOM event source),
   * so the `pointertap` listeners attached to each hex Graphics don't
   * fire. The worker forwards raw pointer events to the renderer; on
   * a confirmed tap the worker calls this method with the pointer's
   * screen-pixel position and the layer reports which (selectable)
   * sector was hit, or null. Distance check against each hex's centre
   * within `HEX_SIZE_BASE * scale` — close enough; the hexes don't
   * overlap in screen space.
   */
  hitTest(screenX: number, screenY: number): string | null {
    if (!this.visible) return null;
    const scale = this.clusterRoot.scale.x;
    if (scale === 0) return null;
    const relX = (screenX - this.clusterRoot.x) / scale;
    const relY = (screenY - this.clusterRoot.y) / scale;
    for (const entry of this.entries) {
      if (!this.isSelectable(entry.sector)) continue;
      const dx = relX - entry.x;
      const dy = relY - entry.y;
      if (Math.hypot(dx, dy) <= HEX_SIZE_BASE) {
        return entry.sector.key;
      }
    }
    return null;
  }

  resize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    // Fit the cluster into ~60% of the smaller viewport dimension so it
    // doesn't occupy the whole gameplay area. HEX_SIZE_BASE is sized for
    // a 1080p reference; rescale the entire root container instead of
    // re-building graphics every resize.
    const positions = GALAXY_SECTORS.map((s) => axialToPixel(s.hex, HEX_SIZE_BASE));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions) {
      if (p.x - HEX_SIZE_BASE < minX) minX = p.x - HEX_SIZE_BASE;
      if (p.x + HEX_SIZE_BASE > maxX) maxX = p.x + HEX_SIZE_BASE;
      if (p.y - HEX_SIZE_BASE < minY) minY = p.y - HEX_SIZE_BASE;
      if (p.y + HEX_SIZE_BASE > maxY) maxY = p.y + HEX_SIZE_BASE;
    }
    const clusterW = maxX - minX;
    const clusterH = maxY - minY;
    const target = Math.min(screenW, screenH) * clusterFitFraction(this.mode);
    const scale = Math.min(target / clusterW, target / clusterH);
    this.clusterRoot.scale.set(scale);
    // Centre on the current sector ("you are here") if known, else fall
    // back to the cluster's geometric centre. Centering on the current
    // sector means the overlay re-orients around the player after each
    // warp instead of always pointing at Sol Prime.
    const focal = this.currentSectorKey
      ? this.entries.find((e) => e.sector.key === this.currentSectorKey)
      : null;
    const focalX = focal ? focal.x : (minX + maxX) / 2;
    const focalY = focal ? focal.y : (minY + maxY) / 2;
    this.hexSize = HEX_SIZE_BASE; // graphics use base size; root is scaled

    if (this.mode === 'selector') {
      // Selector (spawn/warp picker): the pan/zoom camera owns clusterRoot.
      // Always keep its screen size current; re-seed the FIT (zoom + centre)
      // only when the dims actually changed (or on first/mode entry, when
      // `_seedW`==0). A same-dims resize PRESERVES the user's pan/zoom.
      this.panZoomCamera.setScreenSize(screenW, screenH);
      if (screenW !== this._seedW || screenH !== this._seedH) {
        this.panZoomCamera.setZoom(scale);
        this.panZoomCamera.moveCenter(focalX, focalY);
        this._seedW = screenW;
        this._seedH = screenH;
      }
      return;
    }
    // Overlay (in-game additive MAP): static screen-space fit, no pan/zoom.
    this.clusterRoot.scale.set(scale);
    this.clusterRoot.x = screenW / 2 - focalX * scale;
    this.clusterRoot.y = screenH / 2 - focalY * scale;
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    Ticker.shared.remove(this.tick);
    super.destroy({ children: true });
  }

  private isSelectable(sec: GalaxySector): boolean {
    return isSectorSelectable({
      mode: this.mode,
      docked: this.isDocked,
      currentSectorKey: this.currentSectorKey,
      sectorKey: sec.key,
    });
  }

  private buildHexes(): void {
    const positions = GALAXY_SECTORS.map((s) => ({ s, ...axialToPixel(s.hex, HEX_SIZE_BASE) }));
    for (const p of positions) {
      const hex = new Graphics();
      hex.x = p.x;
      hex.y = p.y;
      hex.on('pointertap', () => {
        if (this.isSelectable(p.s)) this.onSelect(p.s.key);
      });
      this.hexLayer.addChild(hex);

      const label = new Text({
        text: p.s.name,
        // Oversample + snap so the fractional cluster downscale stays crisp (R2.7).
        resolution: MAP_LABEL_RESOLUTION,
        roundPixels: true,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: 12,
          fontWeight: '700',
          fill: COLOR_LABEL,
          letterSpacing: 1,
        }),
      });
      label.anchor.set(0.5);
      label.x = p.x;
      label.y = p.y;
      this.hexLayer.addChild(label);

      this.entries.push({ sector: p.s, x: p.x, y: p.y, hex, label });
    }
    this.repaint();
  }

  private repaint(): void {
    for (const entry of this.entries) {
      const { sector, hex, label } = entry;
      const highlighted = sector.key === this.currentSectorKey;
      const selectable = this.isSelectable(sector);

      hex.clear();
      const verts = hexVertices(this.hexSize);
      if (highlighted) {
        hex.poly(verts);
        hex.fill({ color: COLOR_HIGHLIGHT, alpha: 0.30 });
        hex.poly(verts);
        hex.stroke({ color: COLOR_HIGHLIGHT, width: 3, alpha: 0.85 });
      } else if (selectable) {
        hex.poly(verts);
        hex.fill({ color: COLOR_SELECTABLE_FILL, alpha: 0.30 });
        hex.poly(verts);
        hex.stroke({ color: COLOR_SELECTABLE_STROKE, width: 2, alpha: 0.85 });
      } else {
        hex.poly(verts);
        hex.stroke({ color: COLOR_LOCKED_STROKE, width: 1.5, alpha: 0.45 });
      }

      // Overlay mode keeps Pixi's per-hex `pointertap` for tap-to-warp. In
      // selector mode the pan/zoom camera owns ALL pointer input (a tap is
      // resolved via `hitTest` in `onPointerUp`), so hexes are non-interactive
      // to avoid double-handling the tap.
      hex.eventMode = this.mode === 'overlay' && selectable ? 'static' : 'none';
      hex.cursor = selectable ? 'pointer' : 'default';

      label.alpha = highlighted ? 0.95 : selectable ? 0.85 : 0.45;
    }
    this.repaintEdges();
  }

  private repaintEdges(): void {
    const removed = this.edgeLayer.removeChildren();
    for (const c of removed) c.destroy();
    const edges = new Graphics();
    const seen = this._edgeDedupScratch;
    seen.clear();
    for (const entry of this.entries) {
      for (const nKey of entry.sector.neighbours) {
        const a = entry.sector.key;
        const b = nKey;
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const target = this.entries.find((e) => e.sector.key === nKey);
        if (!target) continue;
        const aActive = this.isSelectable(entry.sector) || a === this.currentSectorKey;
        const bActive = this.isSelectable(target.sector) || b === this.currentSectorKey;
        const active = aActive && bActive;
        edges.moveTo(entry.x, entry.y).lineTo(target.x, target.y);
        edges.stroke({
          color: active ? COLOR_SELECTABLE_STROKE : COLOR_LOCKED_STROKE,
          width: 1.5,
          alpha: active ? 0.7 : 0.30,
        });
      }
    }
    this.edgeLayer.addChild(edges);
  }

  private readonly tick = (): void => {
    if (!this.visible) return;
    // Ease the wheel-zoom + coast pan momentum (selector pan/zoom only).
    if (this.mode === 'selector') this.panZoomCamera.tick();
    this.pulsePhase += 0.05;
    if (this.pulsePhase > Math.PI * 2) this.pulsePhase -= Math.PI * 2;
    const pulse = 0.7 + 0.3 * Math.abs(Math.sin(this.pulsePhase));
    for (const entry of this.entries) {
      if (entry.sector.key === this.currentSectorKey) {
        entry.hex.alpha = pulse;
      } else {
        entry.hex.alpha = 1;
      }
    }
  };
}
