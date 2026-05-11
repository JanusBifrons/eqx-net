import { Container, Graphics } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import { useUIStore } from '../state/store';

const ASTEROID_COLOR = 0x886644;
const DRONE_HOSTILE_COLOR = 0xff3344;
const DRONE_IDLE_COLOR = 0xf0c040;
const REMOTE_SHIP_COLOR = 0x00aaff;
// Phase G — glow tokens. All arrows now get a soft glow under the
// triangle (was hostile-only); hostile drones still get a brighter,
// larger menace ring tinted toward red.
const GLOW_COLOR_HOSTILE = 0xff5566;
const GLOW_RADIUS_HOSTILE = 11;
const GLOW_ALPHA_HOSTILE = 0.40;
const GLOW_RADIUS_DEFAULT = 7;
const GLOW_ALPHA_DEFAULT = 0.18;
// Phase G — arrow fill transparency. Lower than the 0.95 pre-G default so
// arrows read as overlay markers, not solid sprites.
const ARROW_FILL_ALPHA = 0.70;
// Halo radii are specified as a fraction of the viewport's shorter screen
// dimension and converted to world units each frame using the viewport's
// current zoom. Phase G — widened spread (inner closer to player, outer
// closer to the screen edge) so distance reads more dynamically.
const INNER_RADIUS_FRAC = 0.14;
const OUTER_RADIUS_FRAC = 0.42;
const INNER_RADIUS_MIN_PX = 50;
const INNER_RADIUS_MAX_PX = 140;
const OUTER_RADIUS_MIN_PX = 90;
const OUTER_RADIUS_MAX_PX = 280;
// Arrow scale at the near/far ends. Reverted in Phase G to big-near /
// small-far (the original pre-F.1 sense) — closer entities deserve the
// more attention-grabbing icon, while distant ones at the outer ring
// stay quieter dots. Polygons + transparency were shrunk independently,
// so the absolute sizes feel quite a bit subtler than pre-F.1 even at
// scaleNear.
const ARROW_SCALE_NEAR = 1.15;
const ARROW_SCALE_FAR = 0.65;
// World-unit distance band used to lerp arrow radius and scale. Phase G:
// tightened to 300–4500 u — the useful "where is this entity" range —
// instead of spreading thinly across 200–5000. Each ring-pixel of travel
// now carries more world distance, so the position-on-ring reads more
// meaningfully.
const DIST_MIN = 300;
const DIST_MAX = 4500;
// Padded so arrows don't flicker when a POI sits exactly on a viewport edge.
const VISIBILITY_PADDING_WORLD = 16;
// Hard cap so a swarm of 200 drones doesn't render 200 arrows. Closest first.
const MAX_ARROWS = 64;
// Cap on dead-reckoning extrapolation window. If a swarm entry hasn't
// updated for longer than this, freeze at the last-reported pose instead
// of letting the arrow fly off — a stale entity is more likely dead /
// out-of-bounds than continuing at constant velocity forever.
const ARROW_EXTRAP_CAP_MS = 400;
// Spring half-life for arrow screen-pixel position smoothing. Operates on
// the screen-space target (not world-space) so player movement no longer
// translates into apparent arrow lag — overtake is solved by the screen-
// space architecture, not by the spring. The spring's remaining role is
// purely cosmetic: smooth corrections when extrapolation snaps to a fresh
// packet, and the "fly-in" feel when a wedge's representative changes.
const ARROW_SMOOTH_HALF_LIFE_MS = 130;
// Beyond this distance, entities collapse into angular-wedge
// representatives instead of each getting their own arrow. Phase G
// dropped this from 2500 → 1500 to reduce the visual clutter that
// landed phone-side: too many singleton arrows competed for screen
// space and made it hard to read individual positions.
const RADAR_GROUPING_DISTANCE = 1500;
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
  /** Inner ring radius in **screen pixels**. */
  innerRadiusPx: number;
  /** Outer ring radius in **screen pixels**. */
  outerRadiusPx: number;
  /** World-unit distances bracketing the ring radius lerp. */
  distMin: number;
  distMax: number;
  scaleNear: number;
  scaleFar: number;
  visiblePadding: number;
  /** Visible bounds in Pixi space (y-flipped from world) — same shape
   *  `viewport.getVisibleBounds()` returns. The visibility test still runs
   *  in world coordinates; only the arrow's final placement is screen-space. */
  visibleLeft: number;
  visibleRight: number;
  visibleTop: number;
  visibleBottom: number;
}

export interface HaloProjection {
  hidden: boolean;
  /** Bearing from the player to the POI in **world space** (atan2
   *  convention: 0 = east, +π/2 = north, −π/2 = south). Caller composes the
   *  arrow's screen position via `playerScreenX + cos(theta) * radiusPx` and
   *  `playerScreenY − sin(theta) * radiusPx` (screen y points down, so y is
   *  negated). */
  theta: number;
  /** Screen-space radius from the player, in pixels. */
  radiusPx: number;
  /** Arrow scale factor (1.0 = built size). */
  scale: number;
}

export function clamp(t: number, lo: number, hi: number): number {
  return t < lo ? lo : t > hi ? hi : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Pure helper. Computes the bearing, screen-pixel ring radius, and arrow
 * scale for a POI relative to the player. Both positions are in world
 * coordinates; visibility bounds are in Pixi space because that's what
 * `viewport.getVisibleBounds()` returns. Returns `hidden: true` if the POI
 * is on-screen and no arrow is needed.
 *
 * Pre-Phase E the function returned a Pixi-coord arrow position (world
 * coords with y flipped). The radar drew into the viewport, so the arrow
 * went through the viewport's camera-follow transform each frame — making
 * arrows drift behind the player during fast motion. Now the function
 * returns only the bearing + radius; the caller composes a screen-space
 * position using the player's current screen-pixel coordinates.
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

  if (inside) return { hidden: true, theta: 0, radiusPx: 0, scale: 0 };

  const dx = poi.x - local.x;
  const dy = poi.y - local.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { hidden: true, theta: 0, radiusPx: 0, scale: 0 };

  const theta = Math.atan2(dy, dx);
  const t = clamp((dist - params.distMin) / (params.distMax - params.distMin), 0, 1);
  const radiusPx = lerp(params.innerRadiusPx, params.outerRadiusPx, t);
  const scale = lerp(params.scaleNear, params.scaleFar, t);

  return { hidden: false, theta, radiusPx, scale };
}

// Two arrow silhouettes — pointier for singleton entities (precise
// direction signal), wider/blunter for wedge representatives (aggregated-
// area signal). After `rotation = -theta` the nose points along the
// world bearing to the POI.
const ARROW_POLY_SINGLETON = [
  { x: 8, y: 0 },
  { x: -4, y: -3 },
  { x: -4, y: 3 },
];
const ARROW_POLY_GROUPED = [
  { x: 6, y: 0 },
  { x: -3, y: -6 },
  { x: -3, y: 6 },
];

function paintArrowGfx(g: Graphics, color: number, hostile: boolean, grouped: boolean): void {
  g.clear();
  // Phase G — every arrow gets a soft glow under the triangle. Hostile
  // entries take a larger menace ring tinted red; everything else gets a
  // subtle ring tinted by the arrow's own colour.
  const glowColor = hostile ? GLOW_COLOR_HOSTILE : color;
  const glowRadius = hostile ? GLOW_RADIUS_HOSTILE : GLOW_RADIUS_DEFAULT;
  const glowAlpha = hostile ? GLOW_ALPHA_HOSTILE : GLOW_ALPHA_DEFAULT;
  g.circle(0, 0, glowRadius);
  g.fill({ color: glowColor, alpha: glowAlpha });

  const poly = grouped ? ARROW_POLY_GROUPED : ARROW_POLY_SINGLETON;
  g.poly(poly);
  g.fill({ color, alpha: ARROW_FILL_ALPHA });
  g.poly(poly);
  g.stroke({
    color: 0xffffff,
    width: hostile ? 1.4 : 1,
    alpha: hostile ? 0.75 : 0.35,
  });
}

function buildArrowGfx(color: number, hostile: boolean, grouped: boolean): Graphics {
  const g = new Graphics();
  paintArrowGfx(g, color, hostile, grouped);
  return g;
}

interface ArrowEntry {
  gfx: Graphics;
  /** Current fill colour. Tracked so wedge representatives that change
   *  type (drone → asteroid → ship) can detect mismatch and repaint
   *  geometry instead of leaving stale colour on the pooled graphic. */
  color: number;
  /** Whether the entry currently renders the hostile glow + bright stroke.
   *  Tracked alongside `color` so a hostility flip also triggers a
   *  geometry repaint. */
  hostile: boolean;
  /** Whether the entry uses the wider "grouped" arrow silhouette. Tracked
   *  alongside `color`/`hostile` so a near→far transition (singleton to
   *  wedge rep, or vice-versa) triggers a polygon repaint. */
  grouped: boolean;
  /** Critically-damped spring state for the arrow's screen-pixel x. */
  sx: SpringState;
  /** Critically-damped spring state for the arrow's screen-pixel y. */
  sy: SpringState;
  /** True iff this arrow rendered on the previous frame. Used to snap the
   *  springs to-target on a hidden → visible transition instead of letting
   *  them spring in from the previous hidden position. */
  lastVisible: boolean;
}

export interface Candidate {
  key: string;
  x: number;
  y: number;
  color: number;
  dist: number;
  /** Whether this entry should render with the hostile glow + bright
   *  stroke. Defaults to false; set true by the radar for drones the
   *  client AI currently treats as hostile to the local player. */
  hostile?: boolean;
  /** Whether this entry represents a wedge (one arrow standing in for
   *  N grouped entities at the same bearing). Drives the wider/blunter
   *  silhouette so the player can distinguish a single off-screen target
   *  from an aggregated group at a glance. */
  grouped?: boolean;
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
      hostile: c.hostile,
      grouped: true,
    });
  }
  return result;
}

export class HaloRadar {
  private readonly container = new Container();
  private viewport: Viewport | null = null;
  private readonly arrows = new Map<string, ArrowEntry>();
  /** Wall-clock anchor for spring dt. Reset on transit cleanup so dt
   *  across a warp gap doesn't blow up the spring's first post-arrival
   *  step. */
  private lastUpdateMs: number | null = null;

  init(viewport: Viewport): void {
    this.viewport = viewport;
    // Phase E — attach to the viewport's PARENT (the renderer's app.stage)
    // so the container lives in screen-pixel space rather than world space.
    // This is what makes the arrows orbit the player's screen position
    // exactly, with no camera-follow transform pipeline in between.
    const stage = viewport.parent;
    if (stage) {
      stage.addChild(this.container);
    }
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

    // Phase E — adaptive screen-space radii. Compute against the shorter
    // viewport dimension so the ring stays comfortably inside the screen in
    // any orientation, then clamp to a sane min/max so arrows aren't tiny
    // on a phone or absurdly far out on a 4K monitor.
    const screenMin = Math.min(viewport.screenWidth, viewport.screenHeight);
    const innerRadiusPx = Math.max(
      INNER_RADIUS_MIN_PX,
      Math.min(INNER_RADIUS_MAX_PX, INNER_RADIUS_FRAC * screenMin),
    );
    const outerRadiusPx = Math.max(
      OUTER_RADIUS_MIN_PX,
      Math.min(OUTER_RADIUS_MAX_PX, OUTER_RADIUS_FRAC * screenMin),
    );

    const params: HaloProjectionParams = {
      innerRadiusPx,
      outerRadiusPx,
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

    // Phase E — player's actual SCREEN position. Arrows orbit this point at
    // a fixed pixel offset, so they always sit at the right place on the
    // halo regardless of camera state (follow lag, zoom, etc.).
    const playerScreen = viewport.toScreen(local.x, -local.y);

    const rawCandidates: Candidate[] = [];

    if (mirror.swarm) {
      for (const [id, e] of mirror.swarm) {
        // Velocity-extrapolate the swarm entry forward from its last-known
        // pose. Out-of-interest drones ship at 6 Hz (167 ms between
        // updates) and at-interest drones at 20 Hz (50 ms); without
        // extrapolation the arrow lags behind the drone by up to one
        // packet interval, which is enough for a fast-moving player to
        // visibly overtake an arrow tracking a slower drone.
        const sinceMs = Math.min(
          ARROW_EXTRAP_CAP_MS,
          Math.max(0, now - e.latestArrivalMs),
        );
        const dtSec = sinceMs / 1000;
        const xExtrap = e.x + e.vx * dtSec;
        const yExtrap = e.y + e.vy * dtSec;
        const dist = Math.hypot(xExtrap - local.x, yExtrap - local.y);
        const isDrone = e.kind === 1;
        const hostile = isDrone && (e.isHostileToLocal ?? false);
        const color = isDrone
          ? (hostile ? DRONE_HOSTILE_COLOR : DRONE_IDLE_COLOR)
          : ASTEROID_COLOR;
        rawCandidates.push({
          key: `swarm:${id}`,
          x: xExtrap,
          y: yExtrap,
          color,
          dist,
          hostile,
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
      // Compose the target screen position from the player's screen pos +
      // the bearing/radius the projection returned. Screen y points down,
      // so the world-bearing's sin component is negated. The arrow's
      // rotation is also negated for the same y-flip — its triangular nose
      // (local +x) ends up pointing along the screen-space bearing to the
      // POI.
      const targetX = playerScreen.x + Math.cos(proj.theta) * proj.radiusPx;
      const targetY = playerScreen.y - Math.sin(proj.theta) * proj.radiusPx;

      const wantHostile = c.hostile === true;
      const wantGrouped = c.grouped === true;
      if (!entry) {
        const gfx = buildArrowGfx(c.color, wantHostile, wantGrouped);
        this.container.addChild(gfx);
        entry = {
          gfx,
          color: c.color,
          hostile: wantHostile,
          grouped: wantGrouped,
          sx: { x: targetX, v: 0 },
          sy: { x: targetY, v: 0 },
          lastVisible: false,
        };
        this.arrows.set(c.key, entry);
      } else if (
        entry.color !== c.color
        || entry.hostile !== wantHostile
        || entry.grouped !== wantGrouped
      ) {
        // Wedge representative type / hostility / group-state flipped — repaint
        // geometry with the new colour, glow, and silhouette. Bounded cost: at
        // most RADAR_WEDGE_COUNT + active hostile-flip count per frame.
        paintArrowGfx(entry.gfx, c.color, wantHostile, wantGrouped);
        entry.color = c.color;
        entry.hostile = wantHostile;
        entry.grouped = wantGrouped;
      }
      renderedKeys.add(c.key);

      // Hidden → visible: snap the springs so the arrow appears at-target
      // instead of springing in from a stale hidden position. Within the
      // same wedge representative changing membership, `lastVisible` stays
      // true and the spring smoothly "flies in" toward the new target —
      // that's the cosmetic effect we want to preserve.
      if (!entry.lastVisible) {
        entry.sx.x = targetX;
        entry.sx.v = 0;
        entry.sy.x = targetY;
        entry.sy.v = 0;
      } else {
        springStep(entry.sx, targetX, ARROW_SMOOTH_HALF_LIFE_MS, dtMs);
        springStep(entry.sy, targetY, ARROW_SMOOTH_HALF_LIFE_MS, dtMs);
      }

      entry.gfx.visible = true;
      entry.gfx.x = entry.sx.x;
      entry.gfx.y = entry.sy.x;
      entry.gfx.rotation = -proj.theta;
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
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
    this.viewport = null;
    this.lastUpdateMs = null;
  }
}
