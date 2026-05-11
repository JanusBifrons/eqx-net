import { Container, Graphics } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import { useUIStore } from '../state/store';

const ASTEROID_COLOR = 0x886644;
const DRONE_COLOR = 0xff3366;
const REMOTE_SHIP_COLOR = 0x00aaff;
// Halo radii are specified in screen pixels and converted to world units each
// frame using the viewport's current zoom — keeps the halo visually consistent
// regardless of zoom level.
const INNER_RADIUS_PX = 90;
const OUTER_RADIUS_PX = 220;
const ARROW_SCALE_NEAR = 1.4;
const ARROW_SCALE_FAR = 0.6;
// World-unit distance band used to lerp arrow radius and scale.
const DIST_MIN = 200;
const DIST_MAX = 5000;
// Padded so arrows don't flicker when a POI sits exactly on a viewport edge.
const VISIBILITY_PADDING_WORLD = 16;
// Hard cap so a swarm of 200 drones doesn't render 200 arrows. Closest first.
const MAX_ARROWS = 64;
// Critically-damped spring half-life for arrow position smoothing. Tuned to
// dampen the ~100 ms position-update gap from interest-grid edge entities
// (out-of-interest drones ship pose at 6 Hz instead of 20 Hz) without
// making arrows feel laggy when the underlying entity is moving fast.
const ARROW_SMOOTH_HALF_LIFE_MS = 100;
// Phase D: beyond this distance, entities collapse into angular-wedge
// representatives instead of each getting their own arrow.
const RADAR_GROUPING_DISTANCE = 2500;
// Phase D: beyond this distance, no arrow at all (distinct from `DIST_MAX`,
// which is just the lerp-finish point for radius/scale). Between
// `DIST_MAX` and `RADAR_MAX_DISTANCE` the arrow sits at the outer ring at
// the far scale, then disappears past the cutoff.
const RADAR_MAX_DISTANCE = 8000;
// Phase D: angular bucket size for wedge grouping. 24 wedges around the
// full ring at 15° each.
const RADAR_WEDGE_DEG = 15;
const RADAR_WEDGE_COUNT = Math.round(360 / RADAR_WEDGE_DEG);

export interface HaloProjectionParams {
  innerRadius: number;
  outerRadius: number;
  distMin: number;
  distMax: number;
  scaleNear: number;
  scaleFar: number;
  visiblePadding: number;
  visibleLeft: number;
  visibleRight: number;
  visibleTop: number;
  visibleBottom: number;
}

export interface HaloProjection {
  hidden: boolean;
  /** Pixi-space x (= world x). */
  x: number;
  /** Pixi-space y (= -world y). */
  y: number;
  /** Pixi-space rotation (= -world theta). */
  rotation: number;
  scale: number;
}

export function clamp(t: number, lo: number, hi: number): number {
  return t < lo ? lo : t > hi ? hi : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Pure helper. Given the player position, a POI position (both in world
 * coordinates) and visibility bounds expressed in Pixi space (y-flipped), it
 * returns where the arrow should sit on the halo and how big it should be —
 * or `hidden: true` if the POI is on-screen.
 *
 * Visibility test uses Pixi space because that's what `viewport.getVisibleBounds()`
 * returns. The renderer mirrors world Y to Pixi `-y` consistently elsewhere.
 */
export function projectArrow(
  local: { x: number; y: number },
  poi: { x: number; y: number },
  params: HaloProjectionParams,
): HaloProjection {
  const poiPixiY = -poi.y;
  const inside =
    poi.x >= params.visibleLeft - params.visiblePadding &&
    poi.x <= params.visibleRight + params.visiblePadding &&
    poiPixiY >= params.visibleTop - params.visiblePadding &&
    poiPixiY <= params.visibleBottom + params.visiblePadding;

  if (inside) return { hidden: true, x: 0, y: 0, rotation: 0, scale: 0 };

  const dx = poi.x - local.x;
  const dy = poi.y - local.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { hidden: true, x: 0, y: 0, rotation: 0, scale: 0 };

  const theta = Math.atan2(dy, dx);
  const t = clamp((dist - params.distMin) / (params.distMax - params.distMin), 0, 1);
  const r = lerp(params.innerRadius, params.outerRadius, t);
  const scale = lerp(params.scaleNear, params.scaleFar, t);

  return {
    hidden: false,
    x: local.x + Math.cos(theta) * r,
    y: -(local.y + Math.sin(theta) * r),
    rotation: -theta,
    scale,
  };
}

// Phase C/D — triangle nose along local +x. After `rotation = -theta` it
// points along the world bearing to the POI. Defined once so the build +
// repaint paths stay in sync (wedge representatives can change colour
// frame-to-frame and need to redraw).
const ARROW_POLY = [
  { x: 8, y: 0 },
  { x: -5, y: -5 },
  { x: -5, y: 5 },
];

function paintArrowGfx(g: Graphics, color: number): void {
  g.clear();
  g.poly(ARROW_POLY);
  g.fill({ color, alpha: 0.95 });
  g.poly(ARROW_POLY);
  g.stroke({ color: 0xffffff, width: 1, alpha: 0.5 });
}

function buildArrowGfx(color: number): Graphics {
  const g = new Graphics();
  paintArrowGfx(g, color);
  return g;
}

interface ArrowEntry {
  gfx: Graphics;
  /** Current fill colour. Tracked so wedge representatives that change
   *  type (drone → asteroid → ship) can detect mismatch and repaint
   *  geometry instead of leaving stale colour on the pooled graphic. */
  color: number;
  /** Critically-damped spring state for x (Pixi-space). */
  sx: SpringState;
  /** Critically-damped spring state for y (Pixi-space). */
  sy: SpringState;
  /** True iff this arrow rendered on the previous frame. Used to snap the
   *  springs to-target on a hidden → visible transition instead of letting
   *  them spring in from the last position. */
  lastVisible: boolean;
}

export interface Candidate {
  key: string;
  x: number;
  y: number;
  color: number;
  dist: number;
}

/**
 * Pure helper. Maps a world-space offset `(dx, dy)` to a wedge index in
 * `[0, wedgeCount)`. Wedge 0 starts at theta = -π (due west) and increases
 * counter-clockwise. atan2's east-zero / +π-edge convention is handled by
 * clamping the maximum index, so theta = π lands in the last wedge instead
 * of wrapping to 0.
 */
export function wedgeIndex(dx: number, dy: number, wedgeCount: number = RADAR_WEDGE_COUNT): number {
  const theta = Math.atan2(dy, dx);
  const t = (theta + Math.PI) / (2 * Math.PI);
  const raw = Math.floor(t * wedgeCount);
  if (raw < 0) return 0;
  if (raw >= wedgeCount) return wedgeCount - 1;
  return raw;
}

/**
 * Pure helper. Drops candidates past `maxDistance`, keeps every candidate
 * within `groupingDistance` as-is, and collapses the rest into angular
 * wedge representatives — the closest entity per wedge wins. The
 * representative inherits all member fields except `key`, which becomes
 * `wedge:${idx}` so the renderer can pool a single Graphics across whatever
 * entity currently leads that wedge.
 */
export function partitionAndGroupCandidates(
  local: { x: number; y: number },
  candidates: ReadonlyArray<Candidate>,
  groupingDistance: number = RADAR_GROUPING_DISTANCE,
  maxDistance: number = RADAR_MAX_DISTANCE,
  wedgeCount: number = RADAR_WEDGE_COUNT,
): Candidate[] {
  const result: Candidate[] = [];
  const wedges = new Map<number, Candidate>();
  for (const c of candidates) {
    if (c.dist > maxDistance) continue;
    if (c.dist <= groupingDistance) {
      result.push(c);
      continue;
    }
    const idx = wedgeIndex(c.x - local.x, c.y - local.y, wedgeCount);
    const existing = wedges.get(idx);
    if (!existing || c.dist < existing.dist) {
      wedges.set(idx, c);
    }
  }
  for (const [idx, c] of wedges) {
    result.push({
      key: `wedge:${idx}`,
      x: c.x,
      y: c.y,
      color: c.color,
      dist: c.dist,
    });
  }
  return result;
}

export class HaloRadar {
  private readonly container = new Container();
  private viewport: Viewport | null = null;
  private readonly arrows = new Map<string, ArrowEntry>();
  /** Wall-clock anchor for spring dt. Reset on first update + on transit
   *  cleanup so dt across a warp gap doesn't blow up the spring. */
  private lastUpdateMs: number | null = null;

  init(viewport: Viewport): void {
    this.viewport = viewport;
    viewport.addChild(this.container);
  }

  update(mirror: RenderMirror): void {
    const viewport = this.viewport;
    if (!viewport) return;

    // During SPOOLING / IN_TRANSIT / ARRIVED the player is between rooms; the
    // mirror may still hold the old sector's swarm/ships while the local ship
    // moves to the new spawn. Drawing arrows for cross-sector ghosts is just
    // visual noise — and the warp overlay covers the screen anyway. Destroy
    // any pooled arrows so a fresh sector starts clean.
    const transitState = useUIStore.getState().transitState;
    if (transitState !== 'DOCKED') {
      for (const entry of this.arrows.values()) {
        this.container.removeChild(entry.gfx);
        entry.gfx.destroy();
      }
      this.arrows.clear();
      this.lastUpdateMs = null;
      return;
    }

    const now = performance.now();
    const dtMs = this.lastUpdateMs === null ? 0 : Math.max(0, Math.min(100, now - this.lastUpdateMs));
    this.lastUpdateMs = now;

    const localId = mirror.localPlayerId;
    const local = localId ? mirror.ships.get(localId) : null;
    if (!local) {
      for (const entry of this.arrows.values()) {
        entry.gfx.visible = false;
        entry.lastVisible = false;
      }
      return;
    }

    const bounds = viewport.getVisibleBounds();
    const scaleX = viewport.scale.x || 1;

    const params: HaloProjectionParams = {
      innerRadius: INNER_RADIUS_PX / scaleX,
      outerRadius: OUTER_RADIUS_PX / scaleX,
      distMin: DIST_MIN,
      distMax: DIST_MAX,
      scaleNear: ARROW_SCALE_NEAR,
      scaleFar: ARROW_SCALE_FAR,
      visiblePadding: VISIBILITY_PADDING_WORLD,
      visibleLeft: bounds.left,
      visibleRight: bounds.right,
      visibleTop: bounds.top,
      visibleBottom: bounds.bottom,
    };

    const rawCandidates: Candidate[] = [];

    if (mirror.swarm) {
      for (const [id, e] of mirror.swarm) {
        const dist = Math.hypot(e.x - local.x, e.y - local.y);
        rawCandidates.push({
          key: `swarm:${id}`,
          x: e.x,
          y: e.y,
          color: e.kind === 1 ? DRONE_COLOR : ASTEROID_COLOR,
          dist,
        });
      }
    }
    for (const [id, s] of mirror.ships) {
      if (id === localId) continue;
      const dist = Math.hypot(s.x - local.x, s.y - local.y);
      rawCandidates.push({ key: `ship:${id}`, x: s.x, y: s.y, color: REMOTE_SHIP_COLOR, dist });
    }

    // Closest-first so MAX_ARROWS truncation drops the farthest entities and
    // wedge-grouping receives a deterministic input order.
    rawCandidates.sort((a, b) => a.dist - b.dist);
    if (rawCandidates.length > MAX_ARROWS) {
      rawCandidates.length = MAX_ARROWS;
    }

    const candidates = partitionAndGroupCandidates(
      { x: local.x, y: local.y },
      rawCandidates,
      RADAR_GROUPING_DISTANCE,
      RADAR_MAX_DISTANCE,
      RADAR_WEDGE_COUNT,
    );

    // After partitioning, `presentKeys` is derived from the post-grouping
    // candidate set: each near-band entity keeps its own key; each wedge
    // representative carries `wedge:N`. Pool entries not in this set are
    // destroyed at the tail of the loop.
    const presentKeys = new Set<string>();
    for (const c of candidates) presentKeys.add(c.key);

    const renderedKeys = new Set<string>();
    for (const c of candidates) {
      const proj = projectArrow({ x: local.x, y: local.y }, { x: c.x, y: c.y }, params);
      let entry = this.arrows.get(c.key);
      if (proj.hidden) {
        if (entry) {
          entry.gfx.visible = false;
          entry.lastVisible = false;
        }
        continue;
      }
      if (!entry) {
        const gfx = buildArrowGfx(c.color);
        this.container.addChild(gfx);
        entry = {
          gfx,
          color: c.color,
          sx: { x: proj.x, v: 0 },
          sy: { x: proj.y, v: 0 },
          lastVisible: false,
        };
        this.arrows.set(c.key, entry);
      } else if (entry.color !== c.color) {
        // Wedge representative changed type — repaint geometry with the new
        // colour. Cost is bounded by RADAR_WEDGE_COUNT per frame and only
        // fires on type-flip frames.
        paintArrowGfx(entry.gfx, c.color);
        entry.color = c.color;
      }
      renderedKeys.add(c.key);

      // Hidden → visible: snap the springs to-target so the arrow appears
      // at its projected position instead of springing in from the last
      // hidden state. Otherwise step both springs toward the new target.
      if (!entry.lastVisible) {
        entry.sx.x = proj.x;
        entry.sx.v = 0;
        entry.sy.x = proj.y;
        entry.sy.v = 0;
      } else {
        springStep(entry.sx, proj.x, ARROW_SMOOTH_HALF_LIFE_MS, dtMs);
        springStep(entry.sy, proj.y, ARROW_SMOOTH_HALF_LIFE_MS, dtMs);
      }

      entry.gfx.visible = true;
      entry.gfx.x = entry.sx.x;
      entry.gfx.y = entry.sy.x;
      entry.gfx.rotation = proj.rotation;
      entry.gfx.scale.set(proj.scale);
      entry.lastVisible = true;
    }

    for (const [key, entry] of this.arrows) {
      if (!renderedKeys.has(key)) {
        entry.gfx.visible = false;
        entry.lastVisible = false;
      }
      if (!presentKeys.has(key)) {
        this.container.removeChild(entry.gfx);
        entry.gfx.destroy();
        this.arrows.delete(key);
      }
    }
  }

  /** Test-only — number of currently-visible arrows in the scene graph. */
  getDebugVisibleArrowCount(): number {
    let n = 0;
    for (const entry of this.arrows.values()) if (entry.gfx.visible) n++;
    return n;
  }

  destroy(): void {
    for (const entry of this.arrows.values()) entry.gfx.destroy();
    this.arrows.clear();
    this.container.destroy({ children: true });
    this.viewport = null;
    this.lastUpdateMs = null;
  }
}
