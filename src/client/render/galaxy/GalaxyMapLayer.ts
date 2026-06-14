import { Container, Graphics, Text, TextStyle, Ticker } from 'pixi.js';
import {
  GALAXY_SECTORS,
  axialToPixel,
  type GalaxySector,
  type SectorFeature,
} from '@core/galaxy/galaxy';
import {
  isSectorSelectable,
  clusterFitFraction,
  type GalaxyLayerMode,
} from './galaxyLayerDecisions';
import {
  computeTerritories,
  factionColor,
  factionBorderColor,
  boundaryEdges,
  type Territory,
} from './galaxyTerritories';
import type { SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import { Camera } from '../worker/Camera';

/**
 * In-game additive galaxy-map layer (Map B) + the full-screen spawn/warp picker.
 *
 * Lives as a screen-space child of the gameplay canvas's `app.stage`, **above**
 * the viewport — so it doesn't pan/zoom with the world camera. Highly
 * transparent in `overlay` mode: gameplay continues fully visible underneath.
 *
 * Living Galaxy Phase 4a — **faction territory tint + contiguous-territory
 * hover-shrink**. Hexes are grouped into per-territory sub-containers (one per
 * faction-contiguous region, positioned at the territory CENTROID with children
 * offset relative to it), so a single `container.scale` shrinks the whole
 * territory toward its centre as one unit. The pure grouping/centroid lives in
 * `galaxyTerritories.ts`; the layer stays thin. Hit-testing + resize + edges read
 * the BASE (un-shrunk) hex positions, so the transient hover-shrink never moves a
 * tap target. (No eraser layer: eqx-net hexes are a SPACED node graph — gaps
 * already separate them — so shrinking exposes no grid artefacts, unlike a tiled
 * grid.)
 *
 * Three stroke tiers layer over the faction fill:
 *  - **highlighted** (current sector): pulsing bright ring.
 *  - **selectable** (neighbour / any sector in selector): brighter stroke.
 *  - **non-adjacent**: faint stroke, non-interactive.
 */

const HEX_SIZE_BASE = 64;

/**
 * Glyph rasterization resolution for the sector labels (WS-14 / R2.7 — "map
 * looks low-res / blurry"). The whole `clusterRoot` is fractionally downscaled
 * to fit; a Pixi `Text` is a BAKED texture, so oversample (≥ common phone DPR) +
 * `roundPixels` keep the downscaled label crisp.
 */
export const MAP_LABEL_RESOLUTION = 3;

const COLOR_HIGHLIGHT = 0x00ff88;
const COLOR_SELECTABLE_STROKE = 0x8fe9c0;
const COLOR_LOCKED_STROKE = 0x2a2f40;
const COLOR_LABEL = 0xdffff0;

/** Bold faction-coloured outer-territory perimeter stroke width (eqx-peri value). */
const FACTION_OUTLINE_WIDTH = 3.5;

/** Contiguous-territory hover-shrink: the hovered (selector) / current-sector
 *  (overlay / touch) territory eases toward this scale; all others ease to 1.0.
 *  Small + subtle — the region "breathes" toward its centroid. Tunable. */
const HOVER_SCALE = 0.94; // eqx-peri's proven value (6% shrink)
const HOVER_LERP = 0.12; // per-frame ease toward target (tunable feel knob)

interface HexEntry {
  sector: GalaxySector;
  /** Base position in clusterRoot space (== `axialToPixel(hex, HEX_SIZE_BASE)`).
   *  Used by hitTest / resize / edges — INVARIANT under the hover-shrink (which
   *  lives on the territory container, not these coords). */
  x: number;
  y: number;
  hex: Graphics;
  label: Text;
  /** Live per-sector count readout (enemies / players / structures), updated by
   *  setGalaxyStats; hidden when the sector has no activity. */
  countText: Text;
  /** Index into `territories` / `territoryContainers`. */
  territoryIndex: number;
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
  private readonly hexLayer = new Container();
  private readonly clusterRoot = new Container();
  private readonly entries: HexEntry[] = [];
  /** Per-territory sub-containers (Phase 4a), positioned at each territory's
   *  centroid; scaling one shrinks the whole region toward its centre. */
  private territories: Territory[] = [];
  private readonly territoryContainers: Container[] = [];
  /** Live + target scale per territory (the hover-shrink ease state). */
  private readonly territoryScale: number[] = [];
  private readonly territoryTarget: number[] = [];
  /** Territory the pointer is currently over (selector hover / touch press), or
   *  -1. The tick eases this one toward HOVER_SCALE; -1 falls back to the
   *  current sector's territory. */
  private hoveredTerritory = -1;
  private currentSectorKey: string | null = null;
  private isDocked = true;
  private mode: GalaxyLayerMode = 'overlay';
  private pulsePhase = 0;
  private screenW = 0;
  private screenH = 0;
  private hexSize = HEX_SIZE_BASE;
  private disposed = false;

  /**
   * Free pan / pinch / wheel zoom for the `selector` (spawn/warp picker) mode.
   * Reuses the hand-rolled {@link Camera} driving the screen-space `clusterRoot`.
   * Works in both render paths because the renderer routes raw canvas
   * pointer/wheel events here when {@link isPanZoomActive}.
   */
  private readonly panZoomCamera: Camera;
  private _seedW = 0;
  private _seedH = 0;

  constructor(opts: { onSelect: (sectorKey: string) => void }) {
    super();
    this.onSelect = opts.onSelect;
    this.visible = false;
    this.eventMode = 'passive';
    this.clusterRoot.addChild(this.hexLayer);
    this.addChild(this.clusterRoot);
    this.panZoomCamera = new Camera(this.clusterRoot, { minScale: 0.12, maxScale: 4 });
    this.buildHexes();
    Ticker.shared.add(this.tick);
  }

  /** True while the spawn/warp picker is on screen — the window during which the
   *  renderer routes pointer/wheel events here for pan/zoom + hover-shrink. */
  isPanZoomActive(): boolean {
    return this.mode === 'selector' && this.visible;
  }

  // ── Pan/zoom + hover input (routed from the renderer's canvas listeners). ──
  onPointerDown(pointerId: number, screenX: number, screenY: number, stamp: number): void {
    this.panZoomCamera.onPointerDown(pointerId, screenX, screenY, stamp);
    // Touch press shrinks the territory under the finger (no true hover on touch).
    this.hoveredTerritory = this.territoryIndexAtScreen(screenX, screenY);
  }
  onPointerMove(pointerId: number, screenX: number, screenY: number): void {
    this.panZoomCamera.onPointerMove(pointerId, screenX, screenY);
    // Desktop hover (or touch drag): shrink whatever territory is under the pointer.
    this.hoveredTerritory = this.territoryIndexAtScreen(screenX, screenY);
  }
  /** Returns true if the pointer cycle was a tap (and a sector was selected). */
  onPointerUp(pointerId: number, screenX: number, screenY: number, stamp: number): boolean {
    const result = this.panZoomCamera.onPointerUp(pointerId, screenX, screenY, stamp);
    if (result.wasTap) {
      const key = this.hitTest(screenX, screenY);
      if (key !== null) this.onSelect(key);
    }
    // Release → fall back to the current-sector territory (touch has no hover).
    this.hoveredTerritory = -1;
    return result.wasTap;
  }
  onPointerCancel(pointerId: number): void {
    this.panZoomCamera.onPointerCancel(pointerId);
    this.hoveredTerritory = -1;
  }
  onWheel(deltaY: number, screenX: number, screenY: number): void {
    this.panZoomCamera.onWheel(deltaY, screenX, screenY);
  }

  /** Live `clusterRoot` transform — the REAL drawn pan/zoom state. DEV
   *  `__eqxGalaxyTransform` E2E hook. */
  getDebugTransform(): { x: number; y: number; scale: number } {
    return { x: this.clusterRoot.x, y: this.clusterRoot.y, scale: this.clusterRoot.scale.x };
  }

  /** Live territory shrink scales — the REAL drawn per-territory scale, keyed by
   *  faction id. DEV `__eqxGalaxyTerritoryScale` E2E hook (asserts the whole
   *  contiguous region scales as one unit on hover). */
  getDebugTerritoryScales(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.territories.length; i++) {
      out[this.territories[i]!.factionId] = this.territoryContainers[i]!.scale.x;
    }
    return out;
  }

  setVisible(open: boolean): void {
    this.visible = open;
  }

  setCurrentSector(key: string | null): void {
    if (this.currentSectorKey === key) return;
    this.currentSectorKey = key;
    this.repaint();
    if (this.screenW > 0 && this.screenH > 0) this.resize(this.screenW, this.screenH);
  }

  setTransitDocked(docked: boolean): void {
    if (this.isDocked === docked) return;
    this.isDocked = docked;
    this.repaint();
  }

  /**
   * Live per-sector counts (Phase 4b) — updates each sector's count readout
   * (enemies / players / structures) beneath its feature glyphs, colour-coded by
   * danger (red enemies → green players → grey). Called ~every 3-5 s from the
   * useGalaxyStats poll (NOT the render loop), so the small per-call allocation
   * is fine. Sectors with no activity hide their readout.
   */
  setGalaxyStats(stats: readonly SectorLiveState[]): void {
    const byKey = new Map<string, SectorLiveState>();
    for (const s of stats) byKey.set(s.key, s);
    for (const entry of this.entries) {
      const ct = entry.countText;
      const st = byKey.get(entry.sector.key);
      if (!st || (st.enemies === 0 && st.players === 0 && st.structures === 0)) {
        ct.visible = false;
        continue;
      }
      const parts: string[] = [];
      if (st.enemies > 0) parts.push(`E${st.enemies}`);
      if (st.players > 0) parts.push(`P${st.players}`);
      if (st.structures > 0) parts.push(`S${st.structures}`);
      ct.text = parts.join('  ');
      ct.style.fill = st.enemies > 0 ? 0xff6b6b : st.players > 0 ? 0x6bff9b : 0xaab0c0;
      ct.visible = true;
    }
  }

  /**
   * Switch between the in-game additive overlay (`overlay`) and the full-screen
   * spawn/warp picker (`selector`). Repaints selectability + re-fits the cluster.
   */
  setMode(mode: GalaxyLayerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this._seedW = 0;
    this._seedH = 0;
    this.hoveredTerritory = -1;
    this.repaint();
    if (this.screenW > 0 && this.screenH > 0) this.resize(this.screenW, this.screenH);
  }

  /**
   * Custom hit-test for the worker-renderer path — Pixi's `events` subsystem
   * isn't initialised in worker context, so the `pointertap` listeners don't
   * fire. The worker forwards raw pointer events; on a confirmed tap it calls
   * this with the screen-pixel position. Distance check against each hex's BASE
   * centre (unaffected by the transient hover-shrink) within `HEX_SIZE_BASE`.
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

  /** Which territory is under a screen point (any sector, not just selectable —
   *  hover-shrink shows on every territory), or -1. Reads BASE hex centres. */
  private territoryIndexAtScreen(screenX: number, screenY: number): number {
    const scale = this.clusterRoot.scale.x;
    if (scale === 0) return -1;
    const relX = (screenX - this.clusterRoot.x) / scale;
    const relY = (screenY - this.clusterRoot.y) / scale;
    for (const entry of this.entries) {
      const dx = relX - entry.x;
      const dy = relY - entry.y;
      if (Math.hypot(dx, dy) <= HEX_SIZE_BASE) return entry.territoryIndex;
    }
    return -1;
  }

  resize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
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
    const focal = this.currentSectorKey
      ? this.entries.find((e) => e.sector.key === this.currentSectorKey)
      : null;
    const focalX = focal ? focal.x : (minX + maxX) / 2;
    const focalY = focal ? focal.y : (minY + maxY) / 2;
    this.hexSize = HEX_SIZE_BASE;

    if (this.mode === 'selector') {
      this.panZoomCamera.setScreenSize(screenW, screenH);
      if (screenW !== this._seedW || screenH !== this._seedH) {
        this.panZoomCamera.setZoom(scale);
        this.panZoomCamera.moveCenter(focalX, focalY);
        this._seedW = screenW;
        this._seedH = screenH;
      }
      return;
    }
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
    // Group sectors into faction-contiguous territories (Phase 4a). Each
    // territory becomes a sub-container at its centroid; member hexes hang off it
    // at an offset, so scaling the container shrinks the region toward its centre.
    this.territories = computeTerritories(GALAXY_SECTORS, HEX_SIZE_BASE);
    const territoryOf = new Map<string, number>();
    for (let i = 0; i < this.territories.length; i++) {
      const t = this.territories[i]!;
      const container = new Container();
      container.x = t.centroid.x;
      container.y = t.centroid.y;
      this.hexLayer.addChild(container);
      this.territoryContainers.push(container);
      this.territoryScale.push(1);
      this.territoryTarget.push(1);
      for (const key of t.sectorKeys) territoryOf.set(key, i);
    }

    // Hex-position → faction lookup for the bold outer-territory outline
    // (eqx-peri faction-coloured perimeter; HEX-adjacency based, not graph edges,
    // so a faction boundary — including a chokepoint — is stroked on both sides).
    const hexFaction = new Map<string, string>();
    for (const s of GALAXY_SECTORS) hexFaction.set(`${s.hex.q},${s.hex.r}`, s.region);
    const factionAt = (q: number, r: number): string | null => hexFaction.get(`${q},${r}`) ?? null;

    for (const s of GALAXY_SECTORS) {
      const pos = axialToPixel(s.hex, HEX_SIZE_BASE);
      const ti = territoryOf.get(s.key) ?? 0;
      const container = this.territoryContainers[ti]!;
      const ox = pos.x - container.x;
      const oy = pos.y - container.y;

      const hex = new Graphics();
      hex.x = ox;
      hex.y = oy;
      hex.on('pointertap', () => {
        if (this.isSelectable(s)) this.onSelect(s.key);
      });
      container.addChild(hex);

      // Bold faction-coloured outline on this hex's OUTER-perimeter edges (edges
      // whose across-neighbour is absent or a different faction). Drawn ONCE —
      // the faction layout is static. Sits above the fill, below the label.
      const boundary = boundaryEdges(s, factionAt);
      if (boundary.length > 0) {
        const outline = new Graphics();
        outline.x = ox;
        outline.y = oy;
        const ov = hexVertices(HEX_SIZE_BASE);
        for (const ei of boundary) {
          outline.moveTo(ov[ei]!.x, ov[ei]!.y).lineTo(ov[(ei + 1) % 6]!.x, ov[(ei + 1) % 6]!.y);
        }
        outline.stroke({ color: factionBorderColor(s.region), width: FACTION_OUTLINE_WIDTH, alpha: 0.95 });
        container.addChild(outline);
      }

      const label = new Text({
        text: s.name,
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
      label.x = ox;
      label.y = oy;
      container.addChild(label);

      // Static environmental-feature glyphs (asteroid / nebula / minerals /
      // black-hole / station) — baked per sector in galaxy.ts, drawn once. Live
      // count glyphs (structures / enemy / neutral / player) are layered in
      // separately by setGalaxyStats (Phase 4b).
      const glyphs = new Graphics();
      this.drawFeatureGlyphs(glyphs, s.features, ox, oy + HEX_SIZE_BASE * 0.46);
      container.addChild(glyphs);

      // Live count readout (Phase 4b), beneath the feature glyphs. Empty/hidden
      // until setGalaxyStats reports activity.
      const countText = new Text({
        text: '',
        resolution: MAP_LABEL_RESOLUTION,
        roundPixels: true,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: 10,
          fontWeight: '700',
          fill: 0xaab0c0,
          letterSpacing: 0.5,
        }),
      });
      countText.anchor.set(0.5);
      countText.x = ox;
      countText.y = oy + HEX_SIZE_BASE * 0.46 + 13;
      countText.visible = false;
      container.addChild(countText);

      this.entries.push({ sector: s, x: pos.x, y: pos.y, hex, label, countText, territoryIndex: ti });
    }
    this.repaint();
  }

  /** Draw a sector's static feature glyphs in a small centred row at (cx, cy). */
  private drawFeatureGlyphs(g: Graphics, features: readonly SectorFeature[], cx: number, cy: number): void {
    if (features.length === 0) return;
    const spacing = 13;
    const startX = cx - ((features.length - 1) * spacing) / 2;
    for (let i = 0; i < features.length; i++) {
      this.drawFeatureGlyph(g, features[i]!, startX + i * spacing, cy, 5);
    }
  }

  /** One small procedural feature glyph (Pixi v8 Graphics). Kept tiny + legible
   *  per the "start tiny" UI rule; tunable. */
  private drawFeatureGlyph(g: Graphics, feature: SectorFeature, x: number, y: number, r: number): void {
    switch (feature) {
      case 'asteroid':
        g.ellipse(x, y, r * 1.1, r * 0.8).fill({ color: 0xaa9977 });
        break;
      case 'nebula':
        g.circle(x, y, r).fill({ color: 0xcc88ff, alpha: 0.7 });
        break;
      case 'minerals':
        g.poly([x, y - r, x + r * 0.7, y, x, y + r * 0.8, x - r * 0.7, y]).fill({ color: 0xffdd33 });
        break;
      case 'blackhole':
        g.circle(x, y, r).stroke({ color: 0xff4466, width: 1.5, alpha: 0.9 });
        g.circle(x, y, r * 0.5).fill({ color: 0x080010 });
        break;
      case 'station':
        g.rect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4).fill({ color: 0xddeeff });
        break;
    }
  }

  private repaint(): void {
    // Faction-tint fills read more strongly in the full-screen selector; the
    // in-game overlay stays highly transparent so gameplay shows through.
    const fillBoost = this.mode === 'selector' ? 1 : 0.55;
    for (const entry of this.entries) {
      const { sector, hex, label } = entry;
      const highlighted = sector.key === this.currentSectorKey;
      const selectable = this.isSelectable(sector);
      const verts = hexVertices(this.hexSize);

      hex.clear();
      // 1) Faction territory tint (always) — the region colour.
      hex.poly(verts);
      hex.fill({
        color: factionColor(sector.region),
        alpha: (highlighted ? 0.5 : selectable ? 0.38 : 0.22) * fillBoost,
      });
      // 2) Faint inner per-hex border for cell separation (under the bold
      //    faction outer-territory outline drawn in buildHexes); the current
      //    sector keeps a brighter ring as the "you are here" marker.
      hex.poly(verts);
      if (highlighted) {
        hex.stroke({ color: COLOR_HIGHLIGHT, width: 2.5, alpha: 0.9 });
      } else if (selectable) {
        hex.stroke({ color: COLOR_SELECTABLE_STROKE, width: 1, alpha: 0.4 });
      } else {
        hex.stroke({ color: COLOR_LOCKED_STROKE, width: 0.8, alpha: 0.25 });
      }

      hex.eventMode = this.mode === 'overlay' && selectable ? 'static' : 'none';
      hex.cursor = selectable ? 'pointer' : 'default';
      label.alpha = highlighted ? 0.95 : selectable ? 0.85 : 0.5;
    }
  }

  /** The territory index of the current "you are here" sector, or -1. */
  private currentTerritoryIndex(): number {
    if (!this.currentSectorKey) return -1;
    for (const entry of this.entries) {
      if (entry.sector.key === this.currentSectorKey) return entry.territoryIndex;
    }
    return -1;
  }

  private readonly tick = (): void => {
    if (!this.visible) return;
    if (this.mode === 'selector') this.panZoomCamera.tick();

    // ── Contiguous-territory hover-shrink ease (Phase 4a) ──
    // The active territory (pointer-hovered, else the current sector's) eases
    // toward HOVER_SCALE; every other eases back to 1.0. Lerping ALL of them
    // each frame IS the smooth incoming/outgoing transition.
    const active = this.hoveredTerritory >= 0 ? this.hoveredTerritory : this.currentTerritoryIndex();
    for (let i = 0; i < this.territoryContainers.length; i++) {
      this.territoryTarget[i] = i === active ? HOVER_SCALE : 1;
      const cur = this.territoryScale[i]!;
      const next = cur + (this.territoryTarget[i]! - cur) * HOVER_LERP;
      this.territoryScale[i] = next;
      this.territoryContainers[i]!.scale.set(next);
    }

    // Pulse the current-sector hex.
    this.pulsePhase += 0.05;
    if (this.pulsePhase > Math.PI * 2) this.pulsePhase -= Math.PI * 2;
    const pulse = 0.7 + 0.3 * Math.abs(Math.sin(this.pulsePhase));
    for (const entry of this.entries) {
      entry.hex.alpha = entry.sector.key === this.currentSectorKey ? pulse : 1;
    }
  };
}
