import { Container, Graphics, Text, TextStyle, Ticker } from 'pixi.js';
import {
  GALAXY_SECTORS,
  axialToPixel,
  getSector,
  type GalaxySector,
  type SectorFeature,
} from '@core/galaxy/galaxy';
import {
  isSectorSelectable,
  isSectorWarpable,
  clusterFitFraction,
  type GalaxyLayerMode,
} from './galaxyLayerDecisions';
import {
  computeTerritories,
  boundaryEdges,
  factionBorderColor,
  DEFAULT_FACTION_COLOR,
  type Territory,
} from './galaxyTerritories';
import { resolveSectorOwner } from './sectorOwnership';
import {
  GALAXY_STAR_LAYERS,
  STAR_MAX_TILE_HALF,
  starHash,
  starLayerAlphaAt,
} from './galaxyStarfield';
import type { SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import type { SectorPresence } from '../../../shared-types/galaxyPresence.js';
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
/** Equinox Phase 7 — the "yours" tint for the player's own presence readout
 *  (own ships ▲ / structures ■), distinct from the global E/N/P/S counts. */
const COLOR_MINE = 0x66ffcc;
/** Equinox Phase 7 (Item 1) — warpable (adjacent) sector ring on the in-game
 *  warp map: a bright cyan so the player sees where they can warp at a glance. */
const COLOR_WARPABLE = 0x33ddff;
/** Equinox Phase 9 (item 3) — the FULL-PAGE galaxy map's opaque deep-space
 *  backdrop, so the gameplay starfield can't bleed through. */
const COLOR_BACKDROP = 0x05070d;

/** Contiguous-territory hover-shrink: the hovered (selector) / current-sector
 *  (overlay / touch) territory eases toward this scale; all others ease to 1.0.
 *  Small + subtle — the region "breathes" toward its centroid. Tunable. */
const HOVER_SCALE = 0.94; // eqx-peri's proven value (6% shrink)
const HOVER_LERP = 0.12; // per-frame ease toward target (tunable feel knob)

/** Living Galaxy Phase 6 — emitted when the hovered sector changes (deduped),
 *  driving the main-thread canvas cursor + the React sector tooltip. */
export interface GalaxyHoverEvent {
  sectorKey: string | null;
  screenX: number;
  screenY: number;
  selectable: boolean;
}

interface HexEntry {
  sector: GalaxySector;
  /** Base position in clusterRoot space (== `axialToPixel(hex, HEX_SIZE_BASE)`).
   *  Used by hitTest / resize / edges — INVARIANT under the hover-shrink (which
   *  lives on the territory container, not these coords). */
  x: number;
  y: number;
  hex: Graphics;
  label: Text;
  /** Live per-sector count readout (enemies / neutrals / players / structures),
   *  updated by setGalaxyStats; hidden when the sector has no activity. */
  countText: Text;
  /** Equinox Phase 7 — the player's OWN presence readout (ships ▲ / structures
   *  ■), updated by setPlayerPresence; hidden where the player has nothing. */
  presenceText: Text;
  /** Equinox Phase 9 (item 5) — a small "recent combat" glyph shown at the top of
   *  the hex when fighting/kills happened here recently; hidden otherwise. */
  combatIcon: Text;
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
  /** Living Galaxy Phase 6 — deduped hover emit (drives cursor + tooltip). */
  private readonly onHover?: (ev: GalaxyHoverEvent) => void;
  private readonly hexLayer = new Container();
  private readonly clusterRoot = new Container();
  /** Equinox Phase 9 (item 3) — opaque deep-space backdrop + zoom-aware LOD
   *  starfield, drawn BEHIND clusterRoot, ONLY in the full-page `selector` mode
   *  (the in-game `overlay` HUD stays fully transparent). Screen-space children
   *  of `this` (not clusterRoot): the starfield is projected by its own pure LOD
   *  math, not the clusterRoot transform. */
  private readonly backdrop = new Graphics();
  private readonly starfield = new Graphics();
  private readonly entries: HexEntry[] = [];
  /** Per-territory sub-containers (Phase 4a), positioned at each territory's
   *  centroid; scaling one shrinks the whole region toward its centre. */
  private territories: Territory[] = [];
  private readonly territoryContainers: Container[] = [];
  /** One bold perimeter outline per territory (Equinox Phase 9, item 4 — applies
   *  to neutral territories too). A child of the matching territory container, so
   *  it shrinks WITH the hover-shrink. */
  private readonly territoryOutlines: Graphics[] = [];
  /** owner id at each occupied axial hex ("q,r" → ownerId), built once in
   *  buildHexes; the `boundaryEdges` perimeter lookup (absent ⇒ map edge). */
  private readonly ownerByHexKey = new Map<string, string>();
  /** Live + target scale per territory (the hover-shrink ease state). */
  private readonly territoryScale: number[] = [];
  private readonly territoryTarget: number[] = [];
  /** Territory the pointer is currently over (selector hover / touch press), or
   *  -1. The tick eases this one toward HOVER_SCALE; -1 falls back to the
   *  current sector's territory. */
  private hoveredTerritory = -1;
  /** Living Galaxy Phase 6 — sector key under the pointer (selector hover) or
   *  null; drives the per-hex hover highlight + the deduped onHover emit. */
  private hoveredSectorKey: string | null = null;
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

  constructor(opts: {
    onSelect: (sectorKey: string) => void;
    onHover?: (ev: GalaxyHoverEvent) => void;
  }) {
    super();
    this.onSelect = opts.onSelect;
    this.onHover = opts.onHover;
    this.visible = false;
    this.eventMode = 'passive';
    // Back-to-front: opaque backdrop, LOD starfield, then the hex cluster.
    this.backdrop.visible = false;
    this.starfield.visible = false;
    this.addChild(this.backdrop);
    this.addChild(this.starfield);
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
    this.updateHover(screenX, screenY);
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
   *  OWNER id (NEUTRAL_OWNER today). DEV `__eqxGalaxyTerritoryScale` E2E hook
   *  (asserts the whole contiguous region scales as one unit on hover). */
  getDebugTerritoryScales(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.territories.length; i++) {
      out[this.territories[i]!.ownerId] = this.territoryContainers[i]!.scale.x;
    }
    return out;
  }

  setVisible(open: boolean): void {
    const wasVisible = this.visible;
    this.visible = open;
    if (!open) {
      this.clearHover();
      return;
    }
    // Equinox Phase 7 (Item 1) — re-frame on (re)open so the in-game warp map
    // auto-zooms to the current sector + its neighbours each time it's shown.
    if (!wasVisible && this.screenW > 0 && this.screenH > 0) {
      this._seedW = 0;
      this._seedH = 0;
      this.resize(this.screenW, this.screenH);
    }
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
   * beneath its feature glyphs, colour-coded by salience. Called ~every 3-5 s
   * from the useGalaxyStats poll (NOT the render loop), so the small per-call
   * allocation is fine. Sectors with no activity hide their readout.
   *
   * Equinox Phase 7 (omnipotent view): now also shows roaming NEUTRAL squads
   * (`N`). They were dropped before, so roaming ships/squads were invisible on
   * the map even though the count rode the snapshot all along. Readout is
   * `E enemies / N roamers / P players / S structures`.
   */
  setGalaxyStats(stats: readonly SectorLiveState[]): void {
    const byKey = new Map<string, SectorLiveState>();
    for (const s of stats) byKey.set(s.key, s);
    for (const entry of this.entries) {
      const ct = entry.countText;
      const st = byKey.get(entry.sector.key);
      // Equinox Phase 9 (item 5) — recent-combat glyph, set independently of the
      // live counts below (a razed sector can have recentCombat but zero current
      // entities, so this must not sit behind the no-activity `continue`).
      entry.combatIcon.visible = st?.recentCombat != null;
      if (!st || (st.enemies === 0 && st.neutrals === 0 && st.players === 0 && st.structures === 0)) {
        ct.visible = false;
        continue;
      }
      const parts: string[] = [];
      if (st.enemies > 0) parts.push(`E${st.enemies}`);
      if (st.neutrals > 0) parts.push(`N${st.neutrals}`);
      if (st.players > 0) parts.push(`P${st.players}`);
      if (st.structures > 0) parts.push(`S${st.structures}`);
      ct.text = parts.join('  ');
      // Colour by the most salient presence: hostile red → roamer amber →
      // player green → structures grey.
      ct.style.fill =
        st.enemies > 0
          ? 0xff6b6b
          : st.neutrals > 0
            ? 0xffc14d
            : st.players > 0
              ? 0x6bff9b
              : 0xaab0c0;
      ct.visible = true;
    }
  }

  /**
   * Equinox Phase 7 — the logged-in player's OWN per-sector presence overlay
   * (omnipotent view): owned structures (■) + ships (▲), in a distinct "yours"
   * green below the global counts. Merged client-side from the roster (ships) +
   * GET /galaxy/presence (structures); pushed at the ~4 s poll cadence (NOT the
   * render loop), so the small per-call allocation matches setGalaxyStats. Hidden
   * in sectors where the player has neither ships nor structures.
   */
  setPlayerPresence(presence: readonly SectorPresence[]): void {
    const byKey = new Map<string, SectorPresence>();
    for (const p of presence) byKey.set(p.key, p);
    for (const entry of this.entries) {
      const pt = entry.presenceText;
      const p = byKey.get(entry.sector.key);
      if (!p || (p.ships === 0 && p.structures === 0)) {
        pt.visible = false;
        continue;
      }
      const parts: string[] = [];
      if (p.structures > 0) parts.push(`■${p.structures}`);
      if (p.ships > 0) parts.push(`▲${p.ships}`);
      pt.text = parts.join('  ');
      pt.visible = true;
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
    this.clearHover();
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

  /**
   * Living Galaxy Phase 6 — the sector hex under a screen point (ANY sector) +
   * whether it's selectable, or `{ key: null }`. Reads BASE hex centres so it's
   * invariant under the transient hover-shrink (mirrors `hitTest`).
   */
  private sectorAtScreen(screenX: number, screenY: number): { key: string | null; selectable: boolean } {
    const scale = this.clusterRoot.scale.x;
    if (scale !== 0) {
      const relX = (screenX - this.clusterRoot.x) / scale;
      const relY = (screenY - this.clusterRoot.y) / scale;
      for (const entry of this.entries) {
        const dx = relX - entry.x;
        const dy = relY - entry.y;
        if (Math.hypot(dx, dy) <= HEX_SIZE_BASE) {
          return { key: entry.sector.key, selectable: this.isSelectable(entry.sector) };
        }
      }
    }
    return { key: null, selectable: false };
  }

  /**
   * Living Galaxy Phase 6 — recompute the hovered sector; on a CHANGE, repaint
   * the hover highlight + emit `onHover` (deduped on sector key, so it NEVER
   * fires per-pointermove — the cursor + React tooltip only update when the
   * pointer crosses into a different hex or off the map).
   */
  private updateHover(screenX: number, screenY: number): void {
    const { key, selectable } = this.sectorAtScreen(screenX, screenY);
    if (key === this.hoveredSectorKey) return;
    this.hoveredSectorKey = key;
    this.repaint();
    // Equinox Phase 9 — anchor the DESKTOP tooltip ABOVE the hovered hex's CENTRE
    // (not down-right of the pointer). Emit the hex's TOP-centre in screen space
    // (clusterRoot transform ∘ the BASE hex position, invariant under the
    // hover-shrink), so the React tooltip floats centred just above the sector.
    // Runs only on hover CHANGE (deduped above), never per-frame — `.find` is fine.
    // Off-map (key === null, a clear) falls back to the raw pointer coords.
    if (key === null) {
      this.onHover?.({ sectorKey: null, screenX, screenY, selectable });
      return;
    }
    const entry = this.entries.find((e) => e.sector.key === key);
    const scale = this.clusterRoot.scale.x;
    const cx = entry ? this.clusterRoot.x + entry.x * scale : screenX;
    const cyTop = entry ? this.clusterRoot.y + entry.y * scale - HEX_SIZE_BASE * scale : screenY;
    this.onHover?.({ sectorKey: key, screenX: cx, screenY: cyTop, selectable });
  }

  /** Clear the hover state + tell the main thread (cursor reset + tooltip hide).
   *  Called when the map hides or the mode flips. */
  private clearHover(): void {
    if (this.hoveredSectorKey === null) return;
    this.hoveredSectorKey = null;
    this.repaint();
    this.onHover?.({ sectorKey: null, screenX: 0, screenY: 0, selectable: false });
  }

  /** DEV/E2E hook — the sector key currently hovered (or null). */
  getDebugHoveredSector(): string | null {
    return this.hoveredSectorKey;
  }

  resize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    // Equinox Phase 9 (item 3) — opaque deep-space backdrop covering the screen,
    // ONLY on the full-page map (`selector`); the in-game `overlay` HUD stays
    // transparent. Drawn before the selector early-return so it always refreshes.
    this.backdrop.clear();
    if (this.mode === 'selector') {
      this.backdrop.rect(0, 0, screenW, screenH).fill({ color: COLOR_BACKDROP, alpha: 1 });
      this.backdrop.visible = true;
    } else {
      this.backdrop.visible = false;
    }
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
        // Equinox Phase 7 (Item 1) — when the player IS in a sector (the in-game
        // warp map), auto-zoom to frame the current sector + its neighbours (the
        // warp targets); on the landing map (no current sector) frame the whole
        // galaxy.
        const frame = this.warpFrame(screenW, screenH);
        this.panZoomCamera.setZoom(frame ? frame.scale : scale);
        this.panZoomCamera.moveCenter(frame ? frame.cx : focalX, frame ? frame.cy : focalY);
        this._seedW = screenW;
        this._seedH = screenH;
      }
      return;
    }
    this.clusterRoot.scale.set(scale);
    this.clusterRoot.x = screenW / 2 - focalX * scale;
    this.clusterRoot.y = screenH / 2 - focalY * scale;
  }

  /**
   * Equinox Phase 7 (Item 1) — the camera frame (zoom + centre) that fits the
   * current sector + its neighbours (the warp targets) into ~70% of the screen.
   * Returns null when the player isn't in a sector (the landing map → frame the
   * whole galaxy via the caller's whole-cluster fit).
   */
  private warpFrame(screenW: number, screenH: number): { scale: number; cx: number; cy: number } | null {
    if (!this.currentSectorKey) return null;
    const cur = getSector(this.currentSectorKey);
    if (!cur) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const key of [this.currentSectorKey, ...cur.neighbours]) {
      const s = getSector(key);
      if (!s) continue;
      const p = axialToPixel(s.hex, HEX_SIZE_BASE);
      if (p.x - HEX_SIZE_BASE < minX) minX = p.x - HEX_SIZE_BASE;
      if (p.x + HEX_SIZE_BASE > maxX) maxX = p.x + HEX_SIZE_BASE;
      if (p.y - HEX_SIZE_BASE < minY) minY = p.y - HEX_SIZE_BASE;
      if (p.y + HEX_SIZE_BASE > maxY) maxY = p.y + HEX_SIZE_BASE;
    }
    if (!Number.isFinite(minX)) return null;
    const target = Math.min(screenW, screenH) * 0.7;
    const scale = Math.min(target / Math.max(maxX - minX, 1), target / Math.max(maxY - minY, 1));
    return { scale, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
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
    // Group sectors into OWNER-contiguous territories (Phase 4a; Equinox Phase 9
    // item 1 — DYNAMIC, via the `resolveSectorOwner` seam, NOT the baked region).
    // Each territory becomes a sub-container at its centroid; member hexes hang
    // off it at an offset, so scaling the container shrinks the region toward its
    // centre. Today every sector is NEUTRAL ⇒ one contiguous territory.
    for (const s of GALAXY_SECTORS) {
      this.ownerByHexKey.set(`${s.hex.q},${s.hex.r}`, resolveSectorOwner(s.key));
    }
    this.territories = computeTerritories(GALAXY_SECTORS, HEX_SIZE_BASE, (s) =>
      resolveSectorOwner(s.key),
    );
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

      // The bold contiguous-territory outline is drawn per-territory in
      // buildTerritoryOutlines (Equinox Phase 9 item 4 — applies to neutral
      // territories too), not per-hex here.

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

      // Asteroid-field glyph only (Equinox Phase 8 / Bug 3) — the other static
      // environmental glyphs are gone; only buildings / ships / asteroids show.
      // Live count glyphs (structures / enemy / neutral / player) are layered in
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

      // Equinox Phase 7 — the player's OWN presence readout (own structures ■ /
      // ships ▲), a distinct "yours" green row below the global counts. Hidden
      // until setPlayerPresence reports the player has presence here.
      const presenceText = new Text({
        text: '',
        resolution: MAP_LABEL_RESOLUTION,
        roundPixels: true,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: 10,
          fontWeight: '700',
          fill: COLOR_MINE,
          letterSpacing: 0.5,
        }),
      });
      presenceText.anchor.set(0.5);
      presenceText.x = ox;
      presenceText.y = oy + HEX_SIZE_BASE * 0.46 + 25;
      presenceText.visible = false;
      container.addChild(presenceText);

      // Equinox Phase 9 (item 5) — "recent combat" glyph at the TOP of the hex,
      // shown by setGalaxyStats when the sector saw fighting/kills recently.
      const combatIcon = new Text({
        text: '⚔',
        resolution: MAP_LABEL_RESOLUTION,
        roundPixels: true,
        style: new TextStyle({ fontFamily: 'sans-serif', fontSize: 13, fontWeight: '700', fill: 0xff7043 }),
      });
      combatIcon.anchor.set(0.5);
      combatIcon.x = ox;
      combatIcon.y = oy - HEX_SIZE_BASE * 0.5;
      combatIcon.visible = false;
      container.addChild(combatIcon);

      this.entries.push({ sector: s, x: pos.x, y: pos.y, hex, label, countText, presenceText, combatIcon, territoryIndex: ti });
    }
    this.buildTerritoryOutlines();
    this.repaint();
  }

  /**
   * Draw one bold perimeter outline per territory — the eqx-peri "territory
   * outline, not per-cell grid" look (Equinox Phase 9 item 4). The outline strokes
   * only each member hex's edges whose across-neighbour is a DIFFERENT owner (or
   * absent) via the unit-locked `boundaryEdges`, yielding one continuous perimeter
   * per contiguous territory. It is a child of the territory CONTAINER, so it
   * shrinks WITH the hover-shrink. Border colour comes from the owner
   * (`factionBorderColor` ⇒ DEFAULT for NEUTRAL today; a faction/player hue once
   * capture exists), so neutral territories get the outline too — exactly what
   * the bug report asked for. Drawn once (ownership is static-neutral now); a
   * future re-group would re-run this.
   */
  private buildTerritoryOutlines(): void {
    const verts = hexVertices(HEX_SIZE_BASE);
    const ownerAt = (q: number, r: number): string | null =>
      this.ownerByHexKey.get(`${q},${r}`) ?? null;
    for (let ti = 0; ti < this.territories.length; ti++) {
      const t = this.territories[ti]!;
      const container = this.territoryContainers[ti]!;
      const g = new Graphics();
      for (const key of t.sectorKeys) {
        const sec = getSector(key);
        if (!sec) continue;
        const pos = axialToPixel(sec.hex, HEX_SIZE_BASE);
        const ox = pos.x - container.x;
        const oy = pos.y - container.y;
        for (const ei of boundaryEdges({ hex: sec.hex, region: t.ownerId }, ownerAt)) {
          const a = verts[ei]!;
          const b = verts[(ei + 1) % 6]!;
          g.moveTo(ox + a.x, oy + a.y);
          g.lineTo(ox + b.x, oy + b.y);
        }
      }
      g.stroke({ color: factionBorderColor(t.ownerId), width: 2, alpha: 0.5 });
      container.addChild(g);
      this.territoryOutlines.push(g);
    }
  }

  /**
   * Equinox Phase 9 (item 3) — redraw the zoom-aware LOD parallax starfield for
   * the full-page map. Screen-space (a direct child of `this`, NOT clusterRoot):
   * we project each star through the SAME world→screen transform clusterRoot uses
   * (`screen = root.xy + world * scale`) but pick which LOD layers are visible by
   * the live zoom `scale`, so density stays ~constant and stars stay crisp at any
   * zoom (vs the old fixed TilingSprite). No-op outside `selector` mode (the
   * in-game overlay HUD has no backdrop/starfield). Pure layer/fade/placement
   * math is in `galaxyStarfield.ts`; this is just the Pixi draw.
   */
  private drawStarfield(): void {
    const g = this.starfield;
    g.clear();
    if (this.mode !== 'selector' || this.screenW === 0 || this.screenH === 0) {
      g.visible = false;
      return;
    }
    const scale = this.clusterRoot.scale.x;
    if (scale <= 0) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const scx = this.screenW / 2;
    const scy = this.screenH / 2;
    // The world point currently under the screen centre (inverse clusterRoot map).
    const camX = (scx - this.clusterRoot.x) / scale;
    const camY = (scy - this.clusterRoot.y) / scale;
    const hw = this.screenW / (2 * scale); // half-viewport in world units
    const hh = this.screenH / (2 * scale);

    for (const layer of GALAXY_STAR_LAYERS) {
      const alpha = starLayerAlphaAt(layer, scale);
      if (alpha <= 0) continue;
      const T = layer.tileSize;
      const p = layer.parallax;
      const bgCx = camX * p;
      const bgCy = camY * p;
      const cTX = Math.round(bgCx / T);
      const cTY = Math.round(bgCy / T);
      const halfX = Math.min(STAR_MAX_TILE_HALF, Math.ceil(hw / T) + 1);
      const halfY = Math.min(STAR_MAX_TILE_HALF, Math.ceil(hh / T) + 1);
      // Batch the whole layer into one fill call (one colour + alpha).
      for (let atx = cTX - halfX; atx <= cTX + halfX; atx++) {
        for (let aty = cTY - halfY; aty <= cTY + halfY; aty++) {
          for (let i = 0; i < layer.starsPerTile; i++) {
            const sx = (atx + starHash(atx, aty, layer.seed, i * 2)) * T;
            const sy = (aty + starHash(atx, aty, layer.seed, i * 2 + 1)) * T;
            g.circle(scx + (sx - bgCx) * scale, scy + (sy - bgCy) * scale, layer.radius);
          }
        }
      }
      g.fill({ color: layer.color, alpha });
    }
  }

  /** Draw a sector's asteroid-field glyph(s) in a small centred row at (cx, cy).
   *  Equinox Phase 8 (Bug 3): only ASTEROID features are drawn — the other static
   *  environmental glyphs (nebula / minerals / black-hole / station) are removed
   *  so the map shows only buildings / ships / asteroids. Runs once in buildHexes
   *  (not per-frame), so the filter allocation is fine (invariant #14). */
  private drawFeatureGlyphs(g: Graphics, features: readonly SectorFeature[], cx: number, cy: number): void {
    const asteroids = features.filter((f) => f === 'asteroid');
    if (asteroids.length === 0) return;
    const spacing = 13;
    const startX = cx - ((asteroids.length - 1) * spacing) / 2;
    for (let i = 0; i < asteroids.length; i++) {
      this.drawFeatureGlyph(g, asteroids[i]!, startX + i * spacing, cy, 5);
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
      // Living Galaxy Phase 6 — subtle lighter tint + brighter ring on the
      // hovered hex (the "this is clickable" affordance the bug doc asked for).
      const hovered = sector.key === this.hoveredSectorKey;
      // Equinox Phase 7 (Item 1) — a WARPABLE (docked neighbour) sector on the
      // in-game warp map: bright cyan ring + lifted fill so the warp targets
      // read at a glance. No-op on the landing map (no current sector).
      const warpable = isSectorWarpable({
        docked: this.isDocked,
        currentSectorKey: this.currentSectorKey,
        sectorKey: sector.key,
      });
      const verts = hexVertices(this.hexSize);

      hex.clear();
      // 1) Neutral sector fill (Equinox Phase 8 / Bug 3) — there are no factions
      //    to capture sectors, so every hex is the same neutral tint; a hovered
      //    hex lifts its fill alpha so it reads brighter than its neighbours.
      const baseAlpha = highlighted ? 0.5 : warpable ? 0.46 : selectable ? 0.38 : 0.22;
      hex.poly(verts);
      hex.fill({
        color: DEFAULT_FACTION_COLOR,
        alpha: (hovered ? baseAlpha + 0.18 : baseAlpha) * fillBoost,
      });
      // 2) Faint inner per-hex border for cell separation (under the bold
      //    faction outer-territory outline drawn in buildHexes); the current
      //    sector keeps a brighter ring as the "you are here" marker; a warpable
      //    neighbour gets a bright cyan ring; a hovered hex gets a lighter ring.
      hex.poly(verts);
      if (highlighted) {
        hex.stroke({ color: COLOR_HIGHLIGHT, width: 2.5, alpha: 0.9 });
      } else if (hovered) {
        hex.stroke({ color: COLOR_HIGHLIGHT, width: 2, alpha: 0.65 });
      } else if (warpable) {
        hex.stroke({ color: COLOR_WARPABLE, width: 2, alpha: 0.85 });
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

    // Equinox Phase 9 (item 3) — redraw the zoom-aware starfield against the live
    // clusterRoot transform (full-page mode only; no-op otherwise).
    this.drawStarfield();

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
