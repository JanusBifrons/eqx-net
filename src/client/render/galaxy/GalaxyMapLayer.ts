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

  constructor(opts: { onSelect: (sectorKey: string) => void }) {
    super();
    this.onSelect = opts.onSelect;
    this.visible = false;
    this.eventMode = 'passive';
    this.clusterRoot.addChild(this.edgeLayer);
    this.clusterRoot.addChild(this.hexLayer);
    this.addChild(this.clusterRoot);
    this.buildHexes();
    Ticker.shared.add(this.tick);
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
    this.clusterRoot.x = screenW / 2 - focalX * scale;
    this.clusterRoot.y = screenH / 2 - focalY * scale;
    this.hexSize = HEX_SIZE_BASE; // graphics use base size; root is scaled
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

      hex.eventMode = selectable ? 'static' : 'none';
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
