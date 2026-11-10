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
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { countdownLabel } from './incoming/incomingFire.js';
import { INCOMING_COLOR, type IncomingGroups } from './incoming/IncomingFireWarning.js';
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
import { radarLockTint, LOCK_TINT_NONE } from './halo/lockMarks.js';
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
  trader: 3,
};

function compareCandidates(a: Candidate, b: Candidate): number {
  // Lock-marked contacts (locking you / your locked targets) are kept first.
  const ra = a.marked === true ? -1 : a.cat ? CATEGORY_RANK[a.cat] : 9;
  const rb = b.marked === true ? -1 : b.cat ? CATEGORY_RANK[b.cat] : 9;
  return ra !== rb ? ra - rb : a.dist - b.dist;
}

function writeCandidate(
  arr: Candidate[], i: number, key: string, x: number, y: number,
  cat: RadarCategory, color: number, dist: number, radius: number, tint: number,
): void {
  const slot = arr[i];
  const hostile = cat === 'hostile';
  const marked = tint !== LOCK_TINT_NONE;
  const c = marked ? tint : color;
  if (!slot) {
    arr[i] = { key, x, y, color: c, cat, dist, radius, hostile, grouped: false, marked };
    return;
  }
  slot.key = key; slot.x = x; slot.y = y; slot.color = c; slot.cat = cat;
  slot.dist = dist; slot.radius = radius; slot.hostile = hostile; slot.grouped = false;
  slot.marked = marked;
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
  /** Drawn colour (a lock mark overrides the category colour). */
  color: number;
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
  /** Fire-control lock keys (`s:<id>` / `p:<id>`), built once per id. */
  private readonly swarmLockKeys = new Map<number, string>();
  private readonly shipLockKeys = new Map<string, string>();
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

  /** Incoming naval fire (`IncomingFireWarning`): when the shells of the
   *  soonest group are off screen, one red chevron on the track points at
   *  them, with that group's countdown. */
  private incoming: IncomingGroups | null = null;
  private incomingGfx: Graphics | null = null;
  private incomingText: Text | null = null;
  private incomingLabel = '';
  /** Track param of the incoming chevron (debug), -1 when hidden. */
  private incomingParam = -1;
  setIncoming(src: IncomingGroups | null): void {
    this.incoming = src;
  }

  /** In transit / arriving → clear the radar (the mirror holds the OLD sector).
   *  Deliberately NOT during the spool-up: the player can still be attacked. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  /** HUD mode below `full` (showcase `?hud=`) → no radar at all. Kept apart
   *  from `suppressed` so a transit never turns it back on. */
  private hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  update(mirror: RenderMirror): void {
    const camera = this.camera;
    if (!camera) return;

    if (this.suppressed || this.hidden) {
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
    // Lock marks: own locked targets (group colour) + ships locking you (red).
    const lockGroups = mirror.localGroups;
    const lockedBy = mirror.localLockedBy;
    const anyLocks = (lockGroups !== undefined && lockGroups.length > 0)
      || (lockedBy !== undefined && lockedBy.length > 0);

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
          let tint = LOCK_TINT_NONE;
          if (anyLocks) {
            let lk = this.swarmLockKeys.get(id);
            if (lk === undefined) { lk = `s:${id}`; this.swarmLockKeys.set(id, lk); }
            tint = radarLockTint(lk, lockGroups, lockedBy);
          }
          writeCandidate(raw, n++, key, x, y, cat, cats[cat].color, dist, e.radius, tint);
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
          let tint = LOCK_TINT_NONE;
          if (anyLocks) {
            let lk = this.shipLockKeys.get(id);
            if (lk === undefined) { lk = `p:${id}`; this.shipLockKeys.set(id, lk); }
            tint = radarLockTint(lk, lockGroups, lockedBy);
          }
          writeCandidate(raw, n++, key, sh.x, sh.y, 'player', cats.player.color, dist, r, tint);
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
          writeCandidate(raw, n++, key, sh.x, sh.y, 'lingering', cats.lingering.color, dist, r, LOCK_TINT_NONE);
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
      if ((cat === 'hostile' || c.marked === true) && size < prefs.hostileMinSizePx) size = prefs.hostileMinSizePx;
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
      // A lock mark (`c.marked`) carries its tint in `c.color`; a wedge rep
      // inherits it from its nearest member only if that member is marked.
      const color = c.marked === true ? c.color : cp.color;
      trackPoint(this.param[k]!, track, this.pt);
      let entry = this.icons.get(c.key);
      if (!entry) {
        const gfx = buildRadarGlyph(cp.shape, color, glow);
        this.container.addChild(gfx);
        entry = {
          gfx, cat, wx: c.x, wy: c.y, shape: cp.shape, color, glow,
          sx: { x: this.pt.x, v: 0 }, sy: { x: this.pt.y, v: 0 },
          lastVisible: false, presentAtFrame: frameId, renderedAtFrame: 0, fade: 0,
        };
        this.icons.set(c.key, entry);
      } else if (entry.shape !== cp.shape || entry.color !== color || entry.glow !== glow) {
        paintRadarGlyph(entry.gfx, cp.shape, color, glow);
        entry.shape = cp.shape; entry.color = color; entry.glow = glow;
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

    this.drawIncoming(W, H, perimeter);

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

  /**
   * The incoming-fire chevron: the soonest group whose shells are off screen
   * (its fall point is beside the ship, so the ring is usually on screen; the
   * chevron shows where the fire is COMING FROM). On the same track, clear of
   * the same HUD blocks, as every other icon. Alloc-free once built.
   */
  private drawIncoming(W: number, H: number, perimeter: number): void {
    const src = this.incoming;
    const cam = this.camera!;
    let best = -1;
    let bestT = Infinity;
    if (src) {
      for (let i = 0; i < src.groupCount; i++) {
        const G = src.groups[i]!;
        if (G.t >= bestT) continue;
        cam.toScreenInto(G.sx, -G.sy, this.pt);
        if (pointViewportDistance(this.pt.x, this.pt.y, W, H) <= 0) continue;
        best = i;
        bestT = G.t;
      }
    }
    if (best < 0) { this.hideIncoming(); return; }
    const G = src!.groups[best]!;
    cam.toScreenInto(G.sx, -G.sy, this.pt);
    const track = this.track;
    placeOnTrack(this.pt.x, this.pt.y, W, H, track, this.pt2);
    let p = trackParam(this.pt2.x, this.pt2.y, track);
    if (this.blockedCount > 0) p = resolveBlocked(p, this.blocked, this.blockedCount, perimeter);
    trackPoint(p, track, this.pt2);
    if (!this.incomingGfx) {
      const g = new Graphics();
      // A chevron pointing +x (rotated to the bearing each frame).
      g.moveTo(-5, -7).lineTo(7, 0).lineTo(-5, 7).lineTo(-1, 0).closePath();
      g.fill({ color: INCOMING_COLOR, alpha: 1 });
      g.stroke({ color: 0x000000, width: 1, alpha: 0.6 });
      const t = new Text({
        text: '',
        style: new TextStyle({
          fontFamily: '"JetBrains Mono", "Roboto Mono", monospace',
          fontSize: 10,
          fontWeight: '700',
          fill: '#ff6a5a',
          stroke: { color: '#000000', width: 2, join: 'round' },
        }),
      });
      t.anchor.set(0.5, 0.5);
      this.container.addChild(g, t);
      this.incomingGfx = g;
      this.incomingText = t;
    }
    const g = this.incomingGfx;
    const text = this.incomingText!;
    // Bearing from the screen centre to the shells; the label sits inward.
    const ang = Math.atan2(this.pt.y - H * 0.5, this.pt.x - W * 0.5);
    g.x = this.pt2.x; g.y = this.pt2.y; g.rotation = ang; g.visible = true;
    const label = countdownLabel(G.t);
    if (label !== this.incomingLabel) { this.incomingLabel = label; text.text = label; }
    text.x = this.pt2.x - Math.cos(ang) * 20;
    text.y = this.pt2.y - Math.sin(ang) * 14;
    text.visible = true;
    this.incomingParam = p;
  }

  private hideIncoming(): void {
    if (this.incomingGfx) this.incomingGfx.visible = false;
    if (this.incomingText) this.incomingText.visible = false;
    this.incomingParam = -1;
  }

  /** Test-only — the incoming-fire chevron, or null when hidden. */
  getDebugIncoming(): { x: number; y: number; label: string; param: number } | null {
    const g = this.incomingGfx;
    if (!g || !g.visible) return null;
    return { x: g.x, y: g.y, label: this.incomingLabel, param: this.incomingParam };
  }

  private hideAll(): void {
    this.hideIncoming();
    for (const entry of this.icons.values()) {
      entry.gfx.visible = false;
      entry.lastVisible = false;
      entry.fade = 0;
    }
  }

  private clearAll(): void {
    this.hideIncoming();
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
        color: e.color,
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
