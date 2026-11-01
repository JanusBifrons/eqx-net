/**
 * Off-screen indicator radar — EDGE-TRACK design (plan sparkling-wondering-rose,
 * Wave 2). Research + rules: docs/architecture/off-screen-indicators.md.
 *
 *  - Icons sit on a track inset from the screen edge, at the bearing from the
 *    screen centre to the contact (position = DIRECTION only).
 *  - Distance is SIZE + OPACITY (log-compressed distance beyond the viewport
 *    edge), with a fade-out approaching the range cutoff.
 *  - Nothing with any part on screen gets an icon (bounding-circle test with
 *    hysteresis).
 *  - Icons avoid HUD exclusion zones and are de-overlapped along the edge.
 *  - Which categories show and how they look come from `RadarPrefs`
 *    (per-device defaults; per-player overrides pushed via `setPrefs`).
 *
 * State crosses into the radar ONLY via setters (prefs, insets, spectator,
 * suppressed). It never reads the Zustand store: on the desktop worker path
 * that store is an isolated, never-updated copy (the old transit-clear and
 * spectator-centre behaviour silently never ran there).
 *
 * `update()` runs per RAF → invariant #14: no allocation in steady state
 * (scratch arrays/points are class fields; key strings are cached per id).
 */
import { Container, type Graphics } from 'pixi.js';
import type { Camera } from './worker/Camera';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import { getShipKind } from '../../shared-types/shipKinds.js';
import {
  defaultRadarPrefs,
  EMPTY_RADAR_INSETS,
  type RadarCategory,
  type RadarInsets,
  type RadarPrefs,
  type RadarShape,
} from '../../shared-types/settings/radar.js';
import { haloAppearFadeStep } from './haloAppear.js';
import {
  partitionAndGroupCandidates,
  groupingDistanceForBand,
  RADAR_WEDGE_COUNT,
  type Candidate,
  type PartitionScratch,
} from './halo/wedgeGrouping.js';
import {
  buildRadarGlyph,
  paintRadarGlyph,
  radarCategoryForSwarm,
  GLYPH_BASE_DIAMETER,
  GROUPED_SIZE_MUL,
} from './halo/arrowGraphics.js';
import { resolveRadarReference } from './halo/radarReference.js';
import {
  circleTouchesViewport,
  deOverlapAlongTrack,
  distanceT,
  placeOnTrack,
  pointViewportDistance,
  rampNearFar,
  rangeFade,
  buildBlockedIntervals,
  resolveBlocked,
  trackParam,
  trackPerimeter,
  trackPoint,
  type TrackRect,
} from './halo/edgeRadar.js';

export { radarCategoryForSwarm } from './halo/arrowGraphics.js';

/** Hard cap on candidates considered per frame (before grouping + the
 *  per-device `maxIcons`). Also sizes the per-icon scratch arrays. */
const MAX_CANDIDATES = 64;
/** Dead-reckoning cap — a contact that hasn't updated for longer than this is
 *  frozen at its last pose rather than extrapolated off into space. */
const EXTRAP_CAP_MS = 400;
/** Cosmetic spring on icon screen position (smooths wedge handoffs / snaps). */
const SMOOTH_HALF_LIFE_MS = 110;
/** Fallback body radius (world u) when a kind is unknown. */
const DEFAULT_RADIUS = 20;
/** Clear gap (CSS px) kept between an icon and any HUD widget. */
const HUD_GAP_PX = 6;

/** Sort priority for the icon cap: lower = kept first. */
const CATEGORY_RANK: Record<RadarCategory, number> = {
  hostile: 0,
  player: 1,
  neutral: 2,
  structure: 3,
  lingering: 4,
  scrap: 5,
  asteroid: 6,
  loot: 4,
};

function compareCandidates(a: Candidate, b: Candidate): number {
  const ra = a.cat ? CATEGORY_RANK[a.cat] : 9;
  const rb = b.cat ? CATEGORY_RANK[b.cat] : 9;
  return ra !== rb ? ra - rb : a.dist - b.dist;
}

function writeCandidate(
  arr: Candidate[], i: number, key: string, x: number, y: number,
  cat: RadarCategory, color: number, dist: number, radius: number,
): void {
  const slot = arr[i];
  const hostile = cat === 'hostile';
  if (!slot) {
    arr[i] = { key, x, y, color, cat, dist, radius, hostile, grouped: false };
    return;
  }
  slot.key = key; slot.x = x; slot.y = y; slot.color = color; slot.cat = cat;
  slot.dist = dist; slot.radius = radius; slot.hostile = hostile; slot.grouped = false;
}

interface IconEntry {
  gfx: Graphics;
  /** Debug/E2E: category + the contact's GAME-space position. */
  cat: RadarCategory;
  wx: number;
  wy: number;
  shape: RadarShape;
  color: number;
  glow: boolean;
  sx: SpringState;
  sy: SpringState;
  lastVisible: boolean;
  presentAtFrame: number;
  renderedAtFrame: number;
  fade: number;
}

/** Debug snapshot of one drawn icon (E2E geometry assertions). */
export interface RadarDebugIcon {
  key: string;
  cat: RadarCategory;
  /** The contact's GAME-space position. */
  wx: number;
  wy: number;
  x: number;
  y: number;
  size: number;
  alpha: number;
  grouped: boolean;
}

export class HaloRadar {
  private readonly container = new Container();
  private camera: Camera | null = null;
  private prefs: RadarPrefs;
  private insets: RadarInsets = EMPTY_RADAR_INSETS;
  private spectating = false;
  private suppressed = false;

  private readonly icons = new Map<string, IconEntry>();
  /** key → last frame the contact was (partly) on screen — hysteresis state. */
  private readonly onScreenAt = new Map<string, number>();
  private frameId = 0;
  private lastUpdateMs: number | null = null;

  // ── scratch (invariant #14) ────────────────────────────────────────────
  private readonly raw: Candidate[] = [];
  private readonly partition: PartitionScratch = { result: [], wedges: new Map(), wedgeReps: [] };
  private readonly swarmKeys = new Map<number, string>();
  private readonly shipKeys = new Map<string, string>();
  private readonly lingerKeys = new Map<string, string>();
  private readonly ref = { x: 0, y: 0 };
  private readonly camCentre = { x: 0, y: 0 };
  private readonly pt = { x: 0, y: 0 };
  private readonly pt2 = { x: 0, y: 0 };
  private readonly track: TrackRect = { left: 0, top: 0, right: 0, bottom: 0 };
  private readonly param = new Float64Array(MAX_CANDIDATES);
  private readonly sizePx = new Float64Array(MAX_CANDIDATES);
  private readonly alpha = new Float64Array(MAX_CANDIDATES);
  private readonly order = new Int32Array(MAX_CANDIDATES);
  private readonly drawn: Candidate[] = [];
  /** HUD-blocked perimeter intervals [s0,e0,s1,e1,…] + their cache key. */
  private readonly blocked = new Float64Array(128);
  private blockedCount = 0;
  private blockedW = -1;
  private blockedH = -1;
  private blockedInsets: RadarInsets | null = null;
  private blockedPrefs: RadarPrefs | null = null;

  constructor(isTouch = false) {
    this.prefs = defaultRadarPrefs(isTouch ? 'touch' : 'desktop');
  }

  init(camera: Camera): void {
    this.camera = camera;
    // Screen-space layer: attach to the camera's PARENT (app.stage).
    const stage = camera.parent;
    if (stage) stage.addChild(this.container);
  }

  /** Replace the active preferences (device defaults or the player's saved
   *  overrides). Glyphs whose shape / colour / glow changed repaint once. */
  setPrefs(prefs: RadarPrefs): void {
    this.prefs = prefs;
  }

  /** HUD geometry to keep clear of (measured on the main thread). */
  setInsets(insets: RadarInsets): void {
    this.insets = insets;
  }

  /** Spectator → the radar is camera-relative (no ship). */
  setSpectator(active: boolean): void {
    this.spectating = active;
  }

  /** Cinematic camera script active (CameraDirector) — also camera-relative,
   *  since the framed subject may not be the local ship. */
  private cameraRelative = false;
  setCameraRelative(active: boolean): void {
    this.cameraRelative = active;
  }

  /** In transit / arriving → clear the radar (the mirror holds the OLD sector).
   *  Deliberately NOT during the spool-up: the player can still be attacked. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  update(mirror: RenderMirror): void {
    const camera = this.camera;
    if (!camera) return;

    if (this.suppressed) {
      this.clearAll();
      this.lastUpdateMs = null;
      return;
    }

    const now = performance.now();
    const dtMs = this.lastUpdateMs === null ? 0 : Math.max(0, Math.min(100, now - this.lastUpdateMs));
    this.lastUpdateMs = now;
    const frameId = ++this.frameId;
    const prefs = this.prefs;
    const cats = prefs.categories;

    const localId = mirror.localPlayerId;
    const local = localId ? mirror.ships.get(localId) : undefined;
    camera.centerInto(this.camCentre);
    const hasRef = resolveRadarReference(
      this.spectating || this.cameraRelative,
      local ? local.x : null,
      local ? local.y : null,
      this.camCentre.x,
      this.camCentre.y,
      this.ref,
    );
    if (!hasRef) {
      this.hideAll();
      return;
    }
    const refX = this.ref.x;
    const refY = this.ref.y;

    const W = camera.screenWidth;
    const H = camera.screenHeight;
    const s = camera.scale.x > 0 ? camera.scale.x : 1;
    const ins = this.insets;
    const edge = prefs.edgeInsetPx;
    const track = this.track;
    track.left = ins.left + edge;
    track.top = ins.top + edge;
    track.right = W - ins.right - edge;
    track.bottom = H - ins.bottom - edge;
    if (track.right <= track.left || track.bottom <= track.top) {
      this.hideAll();
      return;
    }

    // ── 1. Candidate build ─────────────────────────────────────────────
    const raw = this.raw;
    let n = 0;
    let closest = Infinity;
    const maxRange = prefs.maxRange;
    const hyst = prefs.hysteresisPx;

    if (mirror.swarm) {
      for (const [id, e] of mirror.swarm) {
        if (n >= MAX_CANDIDATES * 4) break;
        const hostile = e.kind === 1 && (e.isHostileToLocal ?? false);
        const cat = radarCategoryForSwarm(e.kind, hostile, e.shipKind);
        if (cat === null || !cats[cat].enabled) continue;
        // NO staleness drop: the server only re-sends a pose when it CHANGES,
        // so a parked / sleeping contact legitimately goes un-updated forever.
        // Extrapolation is capped instead (a stale contact freezes in place).
        const ageMs = now - e.latestArrivalMs;
        const dtSec = Math.min(EXTRAP_CAP_MS, Math.max(0, ageMs)) / 1000;
        const x = e.x + e.vx * dtSec;
        const y = e.y + e.vy * dtSec;
        let key = this.swarmKeys.get(id);
        if (key === undefined) { key = `swarm:${id}`; this.swarmKeys.set(id, key); }
        if (this.consider(key, x, y, e.radius > 0 ? e.radius : DEFAULT_RADIUS, refX, refY, W, H, s, maxRange, hyst, frameId)) {
          const dist = Math.hypot(x - refX, y - refY);
          if (dist < closest) closest = dist;
          writeCandidate(raw, n++, key, x, y, cat, cats[cat].color, dist, e.radius);
        }
      }
    }
    if (cats.player.enabled) {
      for (const [id, sh] of mirror.ships) {
        if (id === localId) continue;
        let key = this.shipKeys.get(id);
        if (key === undefined) { key = `ship:${id}`; this.shipKeys.set(id, key); }
        const r = getShipKind(sh.kind).radius;
        if (this.consider(key, sh.x, sh.y, r, refX, refY, W, H, s, maxRange, hyst, frameId)) {
          const dist = Math.hypot(sh.x - refX, sh.y - refY);
          if (dist < closest) closest = dist;
          writeCandidate(raw, n++, key, sh.x, sh.y, 'player', cats.player.color, dist, r);
        }
      }
    }
    if (cats.lingering.enabled && mirror.lingeringShips) {
      for (const [id, sh] of mirror.lingeringShips) {
        let key = this.lingerKeys.get(id);
        if (key === undefined) { key = `linger:${id}`; this.lingerKeys.set(id, key); }
        const r = getShipKind(sh.kind).radius;
        if (this.consider(key, sh.x, sh.y, r, refX, refY, W, H, s, maxRange, hyst, frameId)) {
          const dist = Math.hypot(sh.x - refX, sh.y - refY);
          if (dist < closest) closest = dist;
          writeCandidate(raw, n++, key, sh.x, sh.y, 'lingering', cats.lingering.color, dist, r);
        }
      }
    }
    raw.length = n;
    raw.sort(compareCandidates);
    if (raw.length > MAX_CANDIDATES) raw.length = MAX_CANDIDATES;

    // ── 2. Aggregate far contacts into bearing wedges — ONLY when needed ──
    // Grouping is clutter control (research R3): below the icon cap every
    // contact keeps its own icon (de-overlap handles spacing), so same-bearing
    // contacts at very different ranges keep their distinct size/opacity.
    // Beyond the cap, far contacts collapse into per-wedge group icons.
    const grouped = raw.length <= prefs.maxIcons
      ? raw
      : partitionAndGroupCandidates(
        this.ref,
        raw,
        groupingDistanceForBand(closest),
        maxRange,
        RADAR_WEDGE_COUNT,
        this.partition,
      );
    // Re-prioritise (wedge reps are appended after singletons) + cap.
    grouped.sort(compareCandidates);
    const count = Math.min(grouped.length, prefs.maxIcons, MAX_CANDIDATES);

    // ── 3. Distance → size / opacity; direction → track position ───────
    const drawn = this.drawn;
    drawn.length = 0;
    // HUD-blocked stretches of the track: rebuilt only when the screen, the
    // HUD layout or the preferences change (never per frame in steady state).
    if (W !== this.blockedW || H !== this.blockedH || ins !== this.blockedInsets || prefs !== this.blockedPrefs) {
      this.blockedW = W;
      this.blockedH = H;
      this.blockedInsets = ins;
      this.blockedPrefs = prefs;
      // Pad = the largest icon's half-size + a breathing gap, so no icon
      // sits on, or flush against, a HUD widget.
      const pad = prefs.sizeNearPx * GROUPED_SIZE_MUL * 0.5 + HUD_GAP_PX;
      this.blockedCount = buildBlockedIntervals(track, ins.exclusions, pad, this.blocked);
    }
    const perimeter = trackPerimeter(track);
    for (let i = 0; i < count; i++) {
      const c = grouped[i]!;
      const cat = c.cat ?? 'neutral';
      const cp = cats[cat];
      camera.toScreenInto(c.x, -c.y, this.pt);
      const rPx = (c.radius ?? DEFAULT_RADIUS) * s;
      const dOffPx = pointViewportDistance(this.pt.x, this.pt.y, W, H) - rPx;
      const t = distanceT(dOffPx > 0 ? dOffPx / s : 0, prefs.nearDistance, prefs.farDistance);
      let size = rampNearFar(t, prefs.sizeNearPx, prefs.sizeFarPx, prefs.sizeGamma) * cp.sizeMul;
      if (c.grouped === true) size *= GROUPED_SIZE_MUL;
      if (cat === 'hostile' && size < prefs.hostileMinSizePx) size = prefs.hostileMinSizePx;
      let a = rampNearFar(t, prefs.opacityNear, prefs.opacityFar, prefs.sizeGamma)
        * cp.opacityMul * rangeFade(c.dist, maxRange, prefs.fadeBand);
      if (a > 1) a = 1;
      placeOnTrack(this.pt.x, this.pt.y, W, H, track, this.pt2);
      let p = trackParam(this.pt2.x, this.pt2.y, track);
      if (this.blockedCount > 0) p = resolveBlocked(p, this.blocked, this.blockedCount, perimeter);
      const k = drawn.length;
      this.param[k] = p;
      this.sizePx[k] = size;
      this.alpha[k] = a;
      drawn.push(c);
    }
    deOverlapAlongTrack(this.param, drawn.length, prefs.minSpacingPx, this.order, this.sizePx, perimeter);

    // ── 4. Draw ─────────────────────────────────────────────────────────
    for (let k = 0; k < drawn.length; k++) {
      const c = drawn[k]!;
      const cat = c.cat ?? 'neutral';
      const cp = cats[cat];
      const glow = cat === 'hostile' && prefs.hostileGlow;
      trackPoint(this.param[k]!, track, this.pt);
      let entry = this.icons.get(c.key);
      if (!entry) {
        const gfx = buildRadarGlyph(cp.shape, cp.color, glow);
        this.container.addChild(gfx);
        entry = {
          gfx, cat, wx: c.x, wy: c.y, shape: cp.shape, color: cp.color, glow,
          sx: { x: this.pt.x, v: 0 }, sy: { x: this.pt.y, v: 0 },
          lastVisible: false, presentAtFrame: frameId, renderedAtFrame: 0, fade: 0,
        };
        this.icons.set(c.key, entry);
      } else if (entry.shape !== cp.shape || entry.color !== cp.color || entry.glow !== glow) {
        paintRadarGlyph(entry.gfx, cp.shape, cp.color, glow);
        entry.shape = cp.shape; entry.color = cp.color; entry.glow = glow;
      }
      entry.cat = cat;
      entry.wx = c.x;
      entry.wy = c.y;
      entry.presentAtFrame = frameId;
      entry.renderedAtFrame = frameId;
      if (!entry.lastVisible) {
        entry.sx.x = this.pt.x; entry.sx.v = 0;
        entry.sy.x = this.pt.y; entry.sy.v = 0;
      } else {
        springStep(entry.sx, this.pt.x, SMOOTH_HALF_LIFE_MS, dtMs);
        springStep(entry.sy, this.pt.y, SMOOTH_HALF_LIFE_MS, dtMs);
      }
      entry.fade = haloAppearFadeStep(entry.fade, dtMs);
      entry.gfx.visible = true;
      entry.gfx.x = entry.sx.x;
      entry.gfx.y = entry.sy.x;
      entry.gfx.rotation = 0;
      entry.gfx.scale.set(this.sizePx[k]! / GLYPH_BASE_DIAMETER);
      entry.gfx.alpha = this.alpha[k]! * entry.fade;
      entry.lastVisible = true;
    }

    // ── 5. Sweep ─────────────────────────────────────────────────────────
    for (const [key, entry] of this.icons) {
      if (entry.renderedAtFrame !== frameId) {
        entry.gfx.visible = false;
        entry.lastVisible = false;
        entry.fade = 0;
      }
      if (entry.presentAtFrame !== frameId) {
        this.container.removeChild(entry.gfx);
        entry.gfx.destroy();
        this.icons.delete(key);
      }
    }
    if ((frameId & 127) === 0) {
      for (const [key, f] of this.onScreenAt) if (f < frameId - 2) this.onScreenAt.delete(key);
    }
  }

  /**
   * Per-contact gate: in range, and NOT (partly) on screen. A contact that was
   * on screen last frame must clear the viewport by the hysteresis margin
   * before it re-appears on the radar (anti-flicker). Records the on-screen
   * stamp as a side effect.
   */
  private consider(
    key: string, x: number, y: number, radius: number,
    refX: number, refY: number, W: number, H: number, s: number,
    maxRange: number, hyst: number, frameId: number,
  ): boolean {
    const ddx = x - refX;
    const ddy = y - refY;
    if (ddx * ddx + ddy * ddy >= maxRange * maxRange) return false;
    const cam = this.camera!;
    cam.toScreenInto(x, -y, this.pt);
    const wasOn = this.onScreenAt.get(key) === frameId - 1;
    if (circleTouchesViewport(this.pt.x, this.pt.y, radius * s, W, H, wasOn ? hyst : 0)) {
      this.onScreenAt.set(key, frameId);
      return false;
    }
    return true;
  }

  private hideAll(): void {
    for (const entry of this.icons.values()) {
      entry.gfx.visible = false;
      entry.lastVisible = false;
      entry.fade = 0;
    }
  }

  private clearAll(): void {
    for (const entry of this.icons.values()) {
      this.container.removeChild(entry.gfx);
      entry.gfx.destroy();
    }
    this.icons.clear();
  }

  /** Test-only — number of currently-visible icons. */
  getDebugVisibleArrowCount(): number {
    let k = 0;
    for (const entry of this.icons.values()) if (entry.gfx.visible) k++;
    return k;
  }

  /** Test-only (DEV hook `__eqxHaloDebug`, `?worker=0`) — the drawn icons. */
  getDebugIcons(): RadarDebugIcon[] {
    const out: RadarDebugIcon[] = [];
    for (const [key, e] of this.icons) {
      if (!e.gfx.visible) continue;
      out.push({
        key,
        cat: e.cat,
        wx: e.wx,
        wy: e.wy,
        x: e.gfx.x,
        y: e.gfx.y,
        size: e.gfx.scale.x * GLYPH_BASE_DIAMETER,
        alpha: e.gfx.alpha,
        grouped: key.startsWith('wedge:'),
      });
    }
    return out;
  }

  destroy(): void {
    this.clearAll();
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
    this.camera = null;
    this.lastUpdateMs = null;
  }
}
