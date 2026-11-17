import { Container, Graphics, Sprite, Text, TextStyle, Texture, Ticker } from 'pixi.js';
import {
  GALAXY_SECTORS,
  axialToPixel,
  getSector,
  type GalaxySector,
} from '@core/galaxy/galaxy';
import {
  isSectorSelectable,
  isSectorWarpable,
  clusterFitFraction,
  hoverShrinkTargetScale,
  type GalaxyLayerMode,
} from './galaxyLayerDecisions';
import {
  computeTerritories,
  factionColor,
  factionBorderColor,
  ownerHatched,
  mixColor,
  type Territory,
} from './galaxyTerritories';
import { sectorNebulaPeak } from '@core/galaxy/nebulaField';
import {
  hexVertices,
  drawHexFill,
  drawHatch,
  drawSectorControl,
  hexFlat,
  makeNebulaSprite, ownerSigilSprite, fitSectorLabel,
  drawGalaxyStarfield,
  drawFeatureGlyphs,
  drawTerritoryBorder,
} from './galaxyHexDraw';
import { resolveSectorOwner, ownershipSignature } from './sectorOwnership';
import { GalaxyFocusView } from './galaxyFocusView';
import { GalaxyMapFx } from './galaxyMapFx';
import type { HexLook } from './galaxyMapMotion';
import {
  ENTITY_VISUALS,
  ENTITY_KIND_ORDER,
  entityBadgePolygon,
  entityBadgeCount,
} from '../entityVisuals';
import {
  layoutBadgeIconLabelRow,
  type BadgeSegmentMeasure,
} from './badgeIconLabelLayout';
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
/** Equinox Phase 7 (Item 1) — warpable (adjacent) sector ring on the in-game
 *  warp map: a bright cyan so the player sees where they can warp at a glance. */
const COLOR_WARPABLE = 0x33ddff;
/** Equinox Phase 9 (item 3) — the FULL-PAGE galaxy map's opaque deep-space
 *  backdrop, so the gameplay starfield can't bleed through. */
const COLOR_BACKDROP = 0x05070d;
/** Nebula cloud tint (backdrop clouds + the hex-fill lift in nebula sectors). */
const COLOR_NEBULA = 0x8a5cff;
/** Inset of the per-owner border from the hex edge, so the two owners on a
 *  front each draw their own line and the front reads as a two-colour seam. */
const BORDER_INSET = 0.93;
/** Owner tint strength of a hex fill over the backdrop (scaled by the state
 *  weight: current / warpable / selectable / hovered). */
const OWNER_TINT = 0.78;

/** Per-sector count readout badges — a small per-type ICON (the shared
 *  `entityVisuals` shape) with the count as a SEPARATE ADJACENT text LABEL to its
 *  right (#16 — the "icon + label" look, not a number knocked out of the shape's
 *  centre; that cramped the count and read poorly at map scale). Drawn as Pixi
 *  SHAPES (not unicode glyphs) so they render identically on every device. Order
 *  is FIXED: 0 hostiles, 1 neutral drones, 2 your ships, 3 structures —
 *  hostiles/neutrals from the global snapshot, ships/structures from the player's
 *  OWN presence (so structures aren't double-counted). Shapes + colours match the
 *  React drawer's `EntityBadge` (the shared VISUAL LANGUAGE). */
/** Icon radius (px) for the small per-type glyph. */
const COUNT_BADGE_R = 6;
/** Count-label font size (px). */
const COUNT_NUM_SIZE = 10;
/** Gap between adjacent type segments in the row. */
const COUNT_SEG_GAP = 4;
/** Gap between an icon and its trailing count label. */
const COUNT_ICON_LABEL_GAP = 2;

/** Contiguous-territory hover-shrink: the hovered (selector) / current-sector
 *  (overlay / touch) territory eases toward {@link HOVER_SHRINK_SCALE}; all
 *  others ease to 1.0. Small + subtle — the region "breathes" toward its
 *  centroid. The shrink VALUE is owned by `galaxyLayerDecisions` (the pure
 *  `hoverShrinkTargetScale` returns it) so there is ONE source of truth. */
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
  /** Live per-sector count readout — one solid-colour FILLED-shape badge per
   *  present type with the count knocked out of it (cutout), laid out as a centred
   *  row by layoutCountBadges. `box` = the badge (shape + cutout number); `num` =
   *  the knockout count Text. Order: hostiles, neutrals, ships, structures. */
  countSegs: { box: Container; num: Text }[];
  /** Cached counts [hostiles, neutrals, ships, structures] driving the badges —
   *  hostiles/neutrals from setGalaxyStats, ships/structures from
   *  setPlayerPresence; both call layoutCountBadges so the row stays consistent. */
  counts: number[];
  /** Equinox Phase 9 (item 5) — a small "recent combat" glyph shown at the top of
   *  the hex when fighting/kills happened here recently; hidden otherwise. */
  combatIcon: Text;
  /** Index into `territories` / `territoryContainers`. */
  territoryIndex: number;
  /** The sector's owner (its territory's owner id). */
  ownerId: string;
  /** Paint state set by repaint (feed / hover cadence) and reused by the
   *  per-frame tween repaint: owner-tint weight, nebula lift, border stroke. */
  weight: number;
  nebulaLift: number;
  stroke: HexStroke;
  /** This hex's own split-polygon buffers (see drawHexFill). */
  cutL: number[];
  cutR: number[];
}

interface HexStroke { readonly color: number; readonly width: number; readonly alpha: number }
const STROKE_HIGHLIGHT: HexStroke = { color: COLOR_HIGHLIGHT, width: 2.5, alpha: 1 };
const STROKE_HOVER: HexStroke = { color: COLOR_HIGHLIGHT, width: 2, alpha: 1 };
const STROKE_WARPABLE: HexStroke = { color: COLOR_WARPABLE, width: 2, alpha: 1 };
const STROKE_SELECTABLE: HexStroke = { color: COLOR_SELECTABLE_STROKE, width: 1.2, alpha: 1 };
const STROKE_LOCKED: HexStroke = { color: COLOR_LOCKED_STROKE, width: 1, alpha: 1 };

const HEX_VERTS_BASE = hexVertices(HEX_SIZE_BASE);
const HEX_FLAT_BASE = hexFlat(HEX_SIZE_BASE);
/** Widest a sector name draws (map px): hex width inside the inset border, less a margin. */
const LABEL_MAX_WIDTH = HEX_SIZE_BASE * Math.sqrt(3) * BORDER_INSET - 14;

export class GalaxyMapLayer extends Container {
  private readonly onSelect: (sectorKey: string) => void;
  /** Living Galaxy Phase 6 — deduped hover emit (drives cursor + tooltip). */
  private readonly onHover?: (ev: GalaxyHoverEvent) => void;
  /** Equinox Phase 9 — a confirmed TAP that hit NO hex (empty space). Drives
   *  blur-to-deselect: the host closes the SectorInfoDrawer (the user's "making
   *  a selection which isn't a sector should deselect"). */
  private readonly onDeselect?: () => void;
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
  /** Per-territory control overlay (threat brackets, trend arrows, lock
   *  glyphs), above the outline. Redrawn only when the feed changes. */
  private readonly territoryOverlays: Graphics[] = [];
  /** Static nebula clouds behind the hexes (`nebulaField`), one baked soft sprite, full-page only. */
  private readonly nebulaBackdrop: Sprite;
  /** Owner sigil textures (the ships' `teamSigilOf` emblem), one per owner. */
  private readonly sigilTextures = new Map<string, Texture>();
  /** Motion between feed polls: split ease, flip wipe + ring, flares, hot
   *  pulse, nebula drift (`galaxyMapFx.ts`). */
  private readonly fx: GalaxyMapFx;
  private readonly hexLook: HexLook = { left: '', right: null, frac: 1, wiping: false };
  private readonly paintAt = (i: number): void => this.paintHex(i);
  /** Layer UI clock: summed ticker deltas while the map is visible. */
  private uiClockMs = 0;
  private readonly _edgeScratch: number[] = [];
  /** owner id at each occupied axial hex ("q,r" → ownerId), built once in
   *  buildHexes; the `boundaryEdges` perimeter lookup (absent ⇒ map edge). */
  private readonly ownerByHexKey = new Map<string, string>();
  /** Live + target scale per territory (the hover-shrink ease state). */
  private readonly territoryScale: number[] = [];
  private readonly territoryTarget: number[] = [];
  /** Reused scratch for the per-call icon+label badge layout (#16) — poll cadence,
   *  not the render loop, but reused to keep the per-call alloc tiny. */
  private readonly _badgeMeasures: BadgeSegmentMeasure[] = [];
  private readonly _badgeVisibleIdx: number[] = [];
  /** Territory the pointer is currently over (selector hover / touch press), or
   *  -1. The tick eases this one toward HOVER_SHRINK_SCALE; -1 falls back to the
   *  current sector's territory. */
  private hoveredTerritory = -1;
  /** Living Galaxy Phase 6 — sector key under the pointer (selector hover) or
   *  null; drives the per-hex hover highlight + the deduped onHover emit. */
  private hoveredSectorKey: string | null = null;
  private currentSectorKey: string | null = null;
  /** Campaign 4.4 — the latest per-sector live state (from `setGalaxyStats`),
   *  fed to `resolveSectorOwner` so territories group by LIVE ownership. */
  private liveStateByKey: Map<string, SectorLiveState> | null = null;
  /** Ownership signature of the last territory grouping (`key:factionId`
   *  joined). `setGalaxyStats` re-groups ONLY when this changes — v1 owners are
   *  static (region factions), so that is one rebuild on the first stats push
   *  (behind the opaque landing gate) and none after. */
  private ownershipSig = '';
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
  private readonly focus: GalaxyFocusView;
  private _seedW = 0;
  private _seedH = 0;
  /** Touch device? Disables the territory hover-shrink — there's no true hover on
   *  touch, so a press/drag would otherwise shrink whatever sector is under the
   *  finger (the user's "shrink shouldn't happen on mobile"). */
  private readonly isTouch: boolean;

  constructor(opts: {
    onSelect: (sectorKey: string) => void;
    onHover?: (ev: GalaxyHoverEvent) => void;
    onDeselect?: () => void;
    isTouch?: boolean;
    /** prefers-reduced-motion: no tweens, pulses or drift. */
    reducedMotion?: boolean;
  }) {
    super();
    this.onSelect = opts.onSelect;
    this.onHover = opts.onHover;
    this.onDeselect = opts.onDeselect;
    this.isTouch = opts.isTouch ?? false;
    this.visible = false;
    this.eventMode = 'passive';
    // Back-to-front: opaque backdrop, LOD starfield, then the hex cluster.
    this.backdrop.visible = false;
    this.starfield.visible = false;
    this.addChild(this.backdrop);
    this.addChild(this.starfield);
    this.nebulaBackdrop = makeNebulaSprite(HEX_SIZE_BASE, COLOR_NEBULA);
    this.clusterRoot.addChild(this.nebulaBackdrop);
    this.fx = new GalaxyMapFx(opts.reducedMotion ?? false, this.nebulaBackdrop);
    this.clusterRoot.addChild(this.hexLayer);
    this.addChild(this.clusterRoot);
    this.panZoomCamera = new Camera(this.clusterRoot, { minScale: 0.12, maxScale: 4 });
    this.focus = new GalaxyFocusView(this.panZoomCamera, this.clusterRoot, HEX_SIZE_BASE, opts.reducedMotion ?? false, (k) => resolveSectorOwner(k, this.liveStateByKey));
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
    this.focus.onPointerDown();
    this.panZoomCamera.onPointerDown(pointerId, screenX, screenY, stamp);
    // Hover-shrink is DESKTOP-ONLY — on touch a press/drag is not a hover.
    if (!this.isTouch) this.hoveredTerritory = this.territoryIndexAtScreen(screenX, screenY);
  }
  onPointerMove(pointerId: number, screenX: number, screenY: number): void {
    this.panZoomCamera.onPointerMove(pointerId, screenX, screenY);
    // Desktop hover: shrink whatever territory is under the pointer (never on touch).
    if (!this.isTouch) this.hoveredTerritory = this.territoryIndexAtScreen(screenX, screenY);
    this.updateHover(screenX, screenY);
  }
  /** Returns true if the pointer cycle was a tap (and a sector was selected). */
  onPointerUp(pointerId: number, screenX: number, screenY: number, stamp: number): boolean {
    const result = this.panZoomCamera.onPointerUp(pointerId, screenX, screenY, stamp);
    if (result.wasTap) {
      // Plain map: a hex selects, empty space deselects (closes the drawer). In
      // focus: a door hops, the focused hex is a no-op, anything else backs out.
      const t = this.focus.tap(screenX, screenY, this.hitTest(screenX, screenY));
      if (t.kind === 'select') this.onSelect(t.key);
      else if (t.kind === 'deselect') this.onDeselect?.();
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

  /** Drawn `clusterRoot` pan/zoom (DEV `__eqxGalaxyTransform` E2E hook). */
  getDebugTransform(): { x: number; y: number; scale: number } {
    return { x: this.clusterRoot.x, y: this.clusterRoot.y, scale: this.clusterRoot.scale.x };
  }
  /** DEV `__eqxGalaxyFocus` E2E hook: focus phase, sector, door keys. */
  getDebugFocus(): { phase: string; key: string | null; doors: string[] } { return this.focus.debug(); }

  /** Focus the selected sector (the info panel's), or back out on null. */
  setFocus(key: string | null): void {
    if (this.mode === 'selector' && this.visible) this.focus.set(key, this.screenW, this.screenH, this.isTouch);
  }

  /** VISIBLE count badges drawn for a sector (`__eqxGalaxyBadgeCount` E2E hook:
   *  icons present the moment the map reveals, no pixel screenshots). */
  getDebugBadgeCount(sectorKey: string): number {
    const entry = this.entries.find((e) => e.sector.key === sectorKey);
    if (!entry) return 0;
    let n = 0;
    for (const seg of entry.countSegs) if (seg.box.visible) n++;
    return n;
  }

  /** Drawn per-territory shrink scale by OWNER id (`__eqxGalaxyTerritoryScale`). */
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
      this.focus.reset();
      return;
    }
    // Re-frame on (re)open: the warp map zooms to the current sector + links.
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
    // Campaign 4.4 — territories group by LIVE ownership. Re-group only when
    // the ownership signature actually changes (poll cadence, tiny alloc). The
    // rebuild preserves per-entry presence counts; the loop below then applies
    // this push's enemy/neutral counts to the fresh entries.
    this.liveStateByKey = byKey;
    this.fx.onFeed(byKey, GALAXY_SECTORS, this.uiClockMs);
    const sig = ownershipSignature(byKey);
    if (sig !== this.ownershipSig) {
      this.ownershipSig = sig;
      this.rebuildTerritoryGrouping();
      this.focus.refresh();
    } else {
      // Control (split, threat, lock, trend) can change without an owner flip.
      this.repaint();
      this.drawControlOverlays();
    }
    for (const entry of this.entries) {
      const st = byKey.get(entry.sector.key);
      // Equinox Phase 9 (item 5) — recent-combat glyph (independent of the live
      // counts: a razed sector can have recentCombat but zero current entities).
      entry.combatIcon.visible = st?.recentCombat != null;
      // Hostiles + neutrals are the global (omnipotent) NPC counts; ships +
      // structures come from setPlayerPresence. Update only this slice, then
      // re-lay-out the full badge row.
      entry.counts[0] = st?.enemies ?? 0;
      entry.counts[1] = st?.neutrals ?? 0;
      this.layoutCountBadges(entry);
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
      const p = byKey.get(entry.sector.key);
      // The player's OWN ships + structures (badges 2 + 3). Update only this slice,
      // then re-lay-out the row (hostiles/neutrals come from setGalaxyStats). This
      // is the single source for structures now — no more global+owned double-count.
      entry.counts[2] = p?.ships ?? 0;
      entry.counts[3] = p?.structures ?? 0;
      this.layoutCountBadges(entry);
    }
  }

  /** Lay out the cached `entry.counts` as a centred row of "icon + count label"
   *  segments inside the hex (#16): each present type (count > 0) shows its small
   *  icon glyph with the count as an ADJACENT label to its right; absent types
   *  hide. The row centres via the pure `layoutBadgeIconLabelRow`. Called by
   *  setGalaxyStats + setPlayerPresence (poll cadence, not the render loop). */
  private layoutCountBadges(entry: HexEntry): void {
    const segs = entry.countSegs;
    const counts = entry.counts;
    // Set text + visibility, and measure each VISIBLE segment (icon + label).
    // `_badgeMeasures` is a reused scratch (the visible-segment indices line up
    // with the placement order); cleared per call.
    const measures = this._badgeMeasures;
    measures.length = 0;
    const visibleIdx = this._badgeVisibleIdx;
    visibleIdx.length = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const n = counts[i]!;
      if (n > 0) {
        // Count label + per-digit shrink (caps at "99+") from the shared visual
        // language — identical capping to the SVG EntityBadge in the drawer.
        const { label, scale } = entityBadgeCount(n);
        seg.num.text = label;
        const fontPx = COUNT_NUM_SIZE * scale;
        if (seg.num.style.fontSize !== fontPx) {
          seg.num.style.fontSize = fontPx;
          seg.num.style.lineHeight = fontPx;
        }
        seg.box.visible = true;
        measures.push({ iconW: COUNT_BADGE_R * 2, labelW: seg.num.width });
        visibleIdx.push(i);
      } else {
        seg.box.visible = false;
      }
    }
    const placements = layoutBadgeIconLabelRow({
      measures,
      segGap: COUNT_SEG_GAP,
      iconLabelGap: COUNT_ICON_LABEL_GAP,
    });
    for (let p = 0; p < placements.length; p++) {
      const seg = segs[visibleIdx[p]!]!;
      const place = placements[p]!;
      seg.box.x = place.x;
      seg.num.x = place.labelX;
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
    this.focus.reset();
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
    // Anchor the desktop tooltip above the hovered hex: its TOP-centre in screen
    // space (clusterRoot ∘ BASE hex position, so hover-shrink can't move it).
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
      this.nebulaBackdrop.visible = true;
    } else {
      this.backdrop.visible = false;
      this.nebulaBackdrop.visible = false;
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
        // In a sector (the warp map) frame it + its warp targets; on the
        // landing map frame the whole galaxy.
        const frame = this.warpFrame(screenW, screenH);
        this.panZoomCamera.setZoom(frame ? frame.scale : scale);
        this.panZoomCamera.moveCenter(frame ? frame.cx : focalX, frame ? frame.cy : focalY);
        this._seedW = screenW;
        this._seedH = screenH;
        this.focus.onResize(screenW, screenH);
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
    const nebulaTexture = this.nebulaBackdrop.texture;
    super.destroy({ children: true });
    nebulaTexture.destroy(true);
    for (const t of this.sigilTextures.values()) t.destroy(true);
    this.sigilTextures.clear();
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
    // Group sectors into owner-contiguous territories (live `resolveSectorOwner`;
    // all NEUTRAL before the first poll), each a sub-container at its centroid so
    // the hover-shrink scales the region; re-run by `rebuildTerritoryGrouping`.
    for (const s of GALAXY_SECTORS) {
      this.ownerByHexKey.set(`${s.hex.q},${s.hex.r}`, resolveSectorOwner(s.key, this.liveStateByKey));
    }
    this.territories = computeTerritories(GALAXY_SECTORS, HEX_SIZE_BASE, (s) =>
      resolveSectorOwner(s.key, this.liveStateByKey),
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

      // The territory outline is drawn per-territory (buildTerritoryOutlines).

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
      fitSectorLabel(label, LABEL_MAX_WIDTH);
      label.x = ox;
      label.y = oy - HEX_SIZE_BASE * 0.18; // upper-centre, leaving room for the badge row
      container.addChild(label);

      // Asteroid-field glyph only (Equinox Phase 8 / Bug 3) — the other static
      // environmental glyphs are gone; only buildings / ships / asteroids show.
      // Live count glyphs (structures / enemy / neutral / player) are layered in
      // separately by setGalaxyStats (Phase 4b).
      const glyphs = new Graphics();
      drawFeatureGlyphs(glyphs, s.features, ox, oy + HEX_SIZE_BASE * 0.05);
      container.addChild(glyphs);

      // Live per-sector count readout — a centred row of "icon + count label"
      // segments (#16), placed INSIDE the hex (lower-centre) so it never spills
      // past the hex edge or hides behind an adjacent hex. Each segment is a small
      // per-type ICON (the shared `entityVisuals` shape, NO cutout) with the count
      // as a SEPARATE text LABEL to its right (in the type colour). Laid out by
      // layoutCountBadges; row centred on the hex.
      const countRow = new Container();
      countRow.x = ox;
      countRow.y = oy + HEX_SIZE_BASE * 0.34;
      const countSegs: { box: Container; num: Text }[] = [];
      for (const kind of ENTITY_KIND_ORDER) {
        const v = ENTITY_VISUALS[kind];
        const box = new Container();
        const shapeG = new Graphics();
        // The icon: a small solid glyph drawn at the box origin (no knockout).
        shapeG.poly(entityBadgePolygon(v.shape, COUNT_BADGE_R));
        shapeG.fill(v.color);
        // The count, as an ADJACENT label (left-anchored, vertically centred on
        // the icon), in the type colour so the badge reads "icon: N" at a glance.
        const num = new Text({
          text: '',
          resolution: MAP_LABEL_RESOLUTION,
          roundPixels: true,
          style: new TextStyle({ fontFamily: 'sans-serif', fontSize: COUNT_NUM_SIZE, lineHeight: COUNT_NUM_SIZE, fontWeight: '700', fill: v.color }),
        });
        num.anchor.set(0, 0.5); // left-anchored, vertically centred
        box.addChild(shapeG, num);
        box.visible = false;
        countRow.addChild(box);
        countSegs.push({ box, num });
      }
      container.addChild(countRow);

      // The owner's sigil (its ships' emblem) below the count row; none on neutral ground.
      const sigil = ownerSigilSprite(this.sigilTextures, this.territories[ti]?.ownerId ?? '', ox, oy + HEX_SIZE_BASE * 0.62);
      if (sigil) container.addChild(sigil);

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

      this.entries.push({ sector: s, x: pos.x, y: pos.y, hex, label, countSegs, counts: [0, 0, 0, 0], combatIcon, territoryIndex: ti, ownerId: this.territories[ti]?.ownerId ?? '',
        weight: 0, nebulaLift: Math.min(0.5, sectorNebulaPeak(s.key) * 0.35), stroke: STROKE_LOCKED, cutL: [], cutR: [] });
    }
    this.buildTerritoryOutlines();
    this.repaint();
    this.drawControlOverlays();
  }

  /**
   * Campaign 4.4 — re-group territories after an ownership change. Tears down
   * every per-territory container (hexes, labels, glyphs, badge rows, combat
   * icons, outlines are all its children) and re-runs `buildHexes` against the
   * current `liveStateByKey`, preserving each sector's badge counts (the
   * presence slice arrives on a DIFFERENT poll and must survive the rebuild;
   * the caller re-applies the enemy/neutral slice right after). The pan/zoom
   * transform lives on `clusterRoot` (not rebuilt) so the camera is untouched.
   */
  private rebuildTerritoryGrouping(): void {
    const savedCounts = new Map<string, number[]>();
    for (const e of this.entries) savedCounts.set(e.sector.key, e.counts);
    for (const c of this.territoryContainers) c.destroy({ children: true });
    this.territoryContainers.length = 0;
    this.territoryOutlines.length = 0;
    this.territoryOverlays.length = 0;
    this.fx.resetTerritories();
    this.territories = [];
    this.territoryScale.length = 0;
    this.territoryTarget.length = 0;
    this.ownerByHexKey.clear();
    this.entries.length = 0;
    this.hoveredTerritory = -1;
    this.buildHexes();
    for (const e of this.entries) {
      const saved = savedCounts.get(e.sector.key);
      if (!saved) continue;
      for (let i = 0; i < e.counts.length; i++) e.counts[i] = saved[i] ?? 0;
      this.layoutCountBadges(e);
    }
  }

  /**
   * One perimeter outline per territory (a child of its container, so it
   * breathes with the hover-shrink), inset per owner so a front reads as a
   * two-colour seam; then the territory's control overlay and flip-ring
   * Graphics above it. Re-run on every re-group.
   */
  private buildTerritoryOutlines(): void {
    const verts = hexVertices(HEX_SIZE_BASE * BORDER_INSET);
    const ownerAt = (q: number, r: number): string | null =>
      this.ownerByHexKey.get(`${q},${r}`) ?? null;
    for (let ti = 0; ti < this.territories.length; ti++) {
      const t = this.territories[ti]!;
      const container = this.territoryContainers[ti]!;
      const g = new Graphics();
      drawTerritoryBorder(g, verts, t.sectorKeys, t.ownerId, HEX_SIZE_BASE, container.x, container.y, ownerAt, this._edgeScratch);
      const overlay = new Graphics();
      container.addChild(g, overlay);
      this.fx.addTerritory(container);
      this.territoryOutlines.push(g);
      this.territoryOverlays.push(overlay);
    }
  }

  /**
   * The galaxy-feed control marks, per territory overlay: amber threat
   * brackets (more corners and longer arms as threat rises), a lock glyph on a
   * locked sector, and a trend arrow on a contested (split) sector. Feed
   * cadence only (~10 s), never per frame.
   */
  private drawControlOverlays(): void {
    for (const g of this.territoryOverlays) g.clear();
    for (const entry of this.entries) {
      const g = this.territoryOverlays[entry.territoryIndex];
      const container = this.territoryContainers[entry.territoryIndex];
      const c = this.liveStateByKey?.get(entry.sector.key)?.control;
      if (!g || !container || !c) continue;
      drawSectorControl(g, HEX_VERTS_BASE, HEX_SIZE_BASE, entry.x - container.x, entry.y - container.y, c, entry.ownerId);
    }
    this.fx.redraw(this.entries, this.territoryContainers, HEX_SIZE_BASE, HEX_FLAT_BASE);
  }

  /** Redraw the LOD starfield against the live cluster transform (full-page
   *  map only; the in-game overlay has no backdrop). */
  private drawStarfield(): void {
    const g = this.starfield;
    g.clear();
    const scale = this.clusterRoot.scale.x;
    if (this.mode !== 'selector' || this.screenW === 0 || this.screenH === 0 || scale <= 0) {
      g.visible = false;
      return;
    }
    g.visible = true;
    drawGalaxyStarfield(g, this.screenW, this.screenH, this.clusterRoot.x, this.clusterRoot.y, scale);
  }

  private repaint(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const { sector, hex, label } = entry;
      const highlighted = sector.key === this.currentSectorKey;
      const selectable = this.isSelectable(sector);
      // Living Galaxy Phase 6 — the hovered hex gets a lighter tint + ring.
      const hovered = sector.key === this.hoveredSectorKey;
      // Equinox Phase 7 (Item 1) — a WARPABLE (docked neighbour) sector on the
      // in-game warp map: bright cyan ring + lifted fill. No-op on the landing map.
      const warpable = isSectorWarpable({
        docked: this.isDocked,
        currentSectorKey: this.currentSectorKey,
        sectorKey: sector.key,
      });
      // Fills are OPAQUE in every mode (a hex is never see-through): the owner
      // tint over the backdrop, weighted by state (current / warpable /
      // selectable / hover). Borders are solid; state reads via colour + width.
      const tint = highlighted ? 0.62 : warpable ? 0.58 : selectable ? 0.5 : 0.42;
      entry.weight = Math.min(1, hovered ? tint + 0.16 : tint) * OWNER_TINT;
      entry.stroke = highlighted ? STROKE_HIGHLIGHT : hovered ? STROKE_HOVER
        : warpable ? STROKE_WARPABLE : selectable ? STROKE_SELECTABLE : STROKE_LOCKED;
      this.paintHex(i);
      hex.eventMode = this.mode === 'overlay' && selectable ? 'static' : 'none';
      hex.cursor = selectable ? 'pointer' : 'default';
      label.alpha = highlighted ? 0.95 : selectable ? 0.85 : 0.5;
    }
  }

  /** Draw one hex's fill + border from its cached paint state and its motion
   *  look (split share, flip wipe). Runs per frame for a moving hex only, so
   *  it allocates nothing of ours. Owner tint is the ships' colour, lifted
   *  toward violet in a nebula; a split is holder left, challenger right. */
  private paintHex(i: number): void {
    const entry = this.entries[i]!;
    const hex = entry.hex;
    const look = this.hexLook;
    this.fx.motion.look(i, entry.ownerId, this.uiClockMs, look);
    const leftFill = mixColor(COLOR_BACKDROP, mixColor(factionColor(look.left), COLOR_NEBULA, entry.nebulaLift), entry.weight);
    const rightFill = look.right === null ? null
      : mixColor(COLOR_BACKDROP, mixColor(factionColor(look.right), COLOR_NEBULA, entry.nebulaLift), entry.weight);
    hex.clear();
    const seam = look.wiping ? factionBorderColor(look.left) : COLOR_BACKDROP;
    drawHexFill(hex, HEX_FLAT_BASE, leftFill, rightFill, look.frac, seam, look.wiping, entry.cutL, entry.cutR);
    if (ownerHatched(entry.ownerId)) drawHatch(hex, this.hexSize, mixColor(leftFill, 0x000000, 0.5));
    hex.poly(HEX_FLAT_BASE).stroke(entry.stroke);
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
    if (this.mode === 'selector') this.panZoomCamera.tick(Ticker.shared.deltaMS);

    // Equinox Phase 9 (item 3) — redraw the zoom-aware starfield against the live
    // clusterRoot transform (full-page mode only; no-op otherwise).
    this.drawStarfield();

    // ── Contiguous-territory hover-shrink ease (Phase 4a) ──
    // The active territory (pointer-hovered, else the current sector's) eases
    // toward HOVER_SHRINK_SCALE; every other eases back to 1.0. Lerping ALL of them
    // each frame IS the smooth incoming/outgoing transition.
    this.focus.tick(Ticker.shared.deltaMS);
    // No shrink in focus: the veil's hole is cut at the unshrunk hex.
    const active = this.focus.key !== null ? -1 : this.hoveredTerritory >= 0 ? this.hoveredTerritory : this.currentTerritoryIndex();
    const territoryCount = this.territoryContainers.length;
    for (let i = 0; i < territoryCount; i++) {
      // #1 — never shrink when the whole galaxy is ONE territory (all-neutral):
      // shrinking the sole territory shrinks the entire map under the pointer.
      // Positional scalar args — NO per-territory-per-frame object literal in
      // this `Ticker.shared` hot loop (invariant #14).
      this.territoryTarget[i] = hoverShrinkTargetScale(i === active, territoryCount);
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

    // Motion between polls: flip rings, hot pulse, flares, nebula drift, and
    // a repaint of only the hexes whose split or wipe is moving.
    this.uiClockMs += Ticker.shared.deltaMS;
    this.fx.tick(this.entries, this.territoryContainers, this.uiClockMs, pulse, HEX_SIZE_BASE, this.paintAt, this.mode === 'selector');
  };
}
