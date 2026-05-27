import { Container, Graphics } from 'pixi.js';
import type { Camera } from './worker/Camera';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import { useUIStore } from '../state/store';
import {
  projectArrow,
  type HaloProjectionParams,
} from './halo/projection.js';
import {
  partitionAndGroupCandidates,
  RADAR_GROUPING_DISTANCE,
  RADAR_MAX_DISTANCE,
  RADAR_WEDGE_COUNT,
  type Candidate,
} from './halo/wedgeGrouping.js';
import {
  paintArrowGfx,
  buildArrowGfx,
  ASTEROID_COLOR,
  DRONE_HOSTILE_COLOR,
  DRONE_IDLE_COLOR,
  REMOTE_SHIP_COLOR,
} from './halo/arrowGraphics.js';

// Re-export the surface the existing test suite imports from this file.
// `src/client/render/HaloRadar.test.ts` consumes these by name; the
// extraction is a pure refactor so the test signatures are preserved.
export {
  projectArrow,
  clamp,
  lerp,
  type HaloProjectionParams,
  type HaloProjection,
} from './halo/projection.js';
export {
  wedgeIndex,
  partitionAndGroupCandidates,
  type Candidate,
} from './halo/wedgeGrouping.js';

// Halo radii are specified as a fraction of the viewport's shorter screen
// dimension. Phase P — inner ring pushed out so it's no longer right next
// to the ship sprite. On a 375 px phone the inner ring now lands at
// 0.24 × 375 ≈ 90 px from centre (was ~52 px) and the outer ring stays
// ~7 px inside the screen edge — a ~90 px band still dominated by "at
// the edge" thanks to the exp-saturation curve.
const INNER_RADIUS_FRAC = 0.24;
const OUTER_RADIUS_FRAC = 0.48;
const INNER_RADIUS_MIN_PX = 70;
const INNER_RADIUS_MAX_PX = 240;
const OUTER_RADIUS_MIN_PX = 160;
const OUTER_RADIUS_MAX_PX = 400;
// Arrow scale at the near/far ends. Reverted in Phase G to big-near /
// small-far (the original pre-F.1 sense) — closer entities deserve the
// more attention-grabbing icon, while distant ones at the outer ring
// stay quieter dots. Polygons + transparency were shrunk independently,
// so the absolute sizes feel quite a bit subtler than pre-F.1 even at
// scaleNear.
const ARROW_SCALE_NEAR = 1.15;
const ARROW_SCALE_FAR = 0.65;
// World-unit distance band. Phase N — endpoints expanded so the curve has
// more breathing room. The reactive zone (close-end portion of the band
// where the arrow visibly moves with distance) now spans ~300 u of world
// distance instead of feeling like a hard jump from outer to inner.
//   - DIST_MIN doubles as the near-cutoff: entities closer than this
//     get no arrow at all (after the Phase N grace fade plays out).
const DIST_MIN = 1200;
const DIST_MAX = 7500;
// Hard cap so a swarm of 200 drones doesn't render 200 arrows. Closest first.
const MAX_ARROWS = 64;
// Cap on dead-reckoning extrapolation window. If a swarm entry hasn't
// updated for longer than this, freeze at the last-reported pose instead
// of letting the arrow fly off — a stale entity is more likely dead /
// out-of-bounds than continuing at constant velocity forever.
const ARROW_EXTRAP_CAP_MS = 400;
// Phase P — once the underlying entity has been continuously on-screen
// for this many millis, the arrow hides. A flyby that crosses the
// screen faster than this stays tracked the whole way (no vanish/
// reappear flicker). Resets the moment the entity goes back off-screen.
const ON_SCREEN_HIDE_MS = 500;
// Spring half-life for arrow screen-pixel position smoothing. Operates on
// the screen-space target (not world-space) so player movement no longer
// translates into apparent arrow lag — overtake is solved by the screen-
// space architecture, not by the spring. The spring's remaining role is
// purely cosmetic: smooth corrections when extrapolation snaps to a fresh
// packet, and the "fly-in" feel when a wedge's representative changes.
const ARROW_SMOOTH_HALF_LIFE_MS = 130;

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
  /** Phase P — wall-clock millis when the underlying entity first entered
   *  the viewport in an unbroken on-screen run. null while the entity is
   *  off-screen. The render loop hides the arrow once `now - onScreenSinceMs`
   *  exceeds ON_SCREEN_HIDE_MS, but keeps tracking bearing/position right
   *  up to that point so a high-speed flyby doesn't flicker. */
  onScreenSinceMs: number | null;
  /** Generation-counter stamps (invariant #14, R5). Replace the pre-
   *  Phase-4 per-frame `presentKeys` and `renderedKeys` Sets at the
   *  cleanup-loop seam below. `presentAtFrame === frameId` ⇒ the
   *  candidate list still contains this key; otherwise destroy.
   *  `renderedAtFrame === frameId` ⇒ the entry produced a visible
   *  render this frame; otherwise hide. */
  presentAtFrame: number;
  renderedAtFrame: number;
}

export class HaloRadar {
  private readonly container = new Container();
  private camera: Camera | null = null;
  private readonly arrows = new Map<string, ArrowEntry>();
  /** Monotonic per-`update()` counter for the generation-counter
   *  sweep over `arrows`. Bumped at the top of `update()`. */
  private _radarFrameId = 0;
  /** Wall-clock anchor for spring dt. Reset on transit cleanup so dt
   *  across a warp gap doesn't blow up the spring's first post-arrival
   *  step. */
  private lastUpdateMs: number | null = null;

  init(camera: Camera): void {
    this.camera = camera;
    // Phase E — attach to the camera's PARENT (the renderer's app.stage)
    // so the container lives in screen-pixel space rather than world space.
    // This is what makes the arrows orbit the player's screen position
    // exactly, with no camera-follow transform pipeline in between.
    const stage = camera.parent;
    if (stage) {
      stage.addChild(this.container);
    }
  }

  update(mirror: RenderMirror): void {
    const camera = this.camera;
    if (!camera) return;

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

    // Phase E — adaptive screen-space radii. Compute against the shorter
    // viewport dimension so the ring stays comfortably inside the screen in
    // any orientation, then clamp to a sane min/max so arrows aren't tiny
    // on a phone or absurdly far out on a 4K monitor.
    const screenMin = Math.min(camera.screenWidth, camera.screenHeight);
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
    };

    // Phase P — viewport bounds for the on-screen hide timer. The hide is
    // renderer-side (not in projectArrow) so the bearing/scale/radius
    // continue updating right up to the 500 ms cutoff — no bearing freeze
    // like Phase N's grace fade.
    const bounds = camera.getVisibleBounds();

    // Phase E — player's actual SCREEN position. Arrows orbit this point at
    // a fixed pixel offset, so they always sit at the right place on the
    // halo regardless of camera state (follow lag, zoom, etc.).
    const playerScreen = camera.toScreen(local.x, -local.y);
    // Phase H — radius for the "come in from off-screen" spawn point. A
    // circle of `screenCornerRadius + 30` px from playerScreen sits just
    // outside any corner of the visible viewport at any bearing, so a
    // fresh arrow's spring starts genuinely off-screen and flies inward
    // to its halo ring target instead of popping into existence on the
    // ring.
    const screenCornerRadius = Math.hypot(camera.screenWidth, camera.screenHeight) / 2;
    const offScreenSpawnPx = screenCornerRadius + 30;

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

    // Generation-counter sweep (invariant #14, R5). Pre-Phase-4 this
    // tick allocated `presentKeys` + `renderedKeys` Sets every RAF; the
    // two stamp fields on each ArrowEntry now carry the same signal
    // with zero allocation. Entry resolution stamps `presentAtFrame`
    // unconditionally at the head; the render-tail stamps
    // `renderedAtFrame`; the cleanup compares both at frameId.
    const frameId = ++this._radarFrameId;

    for (const c of candidates) {
      const proj = projectArrow({ x: local.x, y: local.y }, { x: c.x, y: c.y }, params);
      let entry = this.arrows.get(c.key);
      if (entry) entry.presentAtFrame = frameId;
      if (proj.hidden) {
        // Degenerate POI-overlaps-player case only. Phase O removed the
        // on-screen visibility hide and the near-cutoff: every in-range
        // entity tracks continuously, including on-screen flybys.
        if (entry) {
          entry.gfx.visible = false;
          entry.lastVisible = false;
          entry.onScreenSinceMs = null;
        }
        continue;
      }

      // Phase P — on-screen hide timer. While the entity is on-screen we
      // keep updating the arrow's bearing/position so a flyby tracks
      // smoothly; once it's been continuously on-screen for
      // ON_SCREEN_HIDE_MS the arrow hides. Coming back off-screen resets
      // the timer (the entry will re-spring from off-screen on the next
      // visible frame because `lastVisible` is reset on hide).
      const poiPixiY = -c.y;
      // Camera.getVisibleBounds() returns `{ x, y, width, height }` —
      // derive left/right/top/bottom from that shape.
      const isInside =
        c.x >= bounds.x
        && c.x <= bounds.x + bounds.width
        && poiPixiY >= bounds.y
        && poiPixiY <= bounds.y + bounds.height;
      if (entry) {
        if (isInside) {
          if (entry.onScreenSinceMs === null) entry.onScreenSinceMs = now;
          if (now - entry.onScreenSinceMs >= ON_SCREEN_HIDE_MS) {
            entry.gfx.visible = false;
            entry.lastVisible = false;
            // keep onScreenSinceMs set — entity has to fully leave the
            // viewport before the next visible frame is allowed to spring
            // in from off-screen.
            continue;
          }
        } else {
          entry.onScreenSinceMs = null;
        }
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
          onScreenSinceMs: isInside ? now : null,
          presentAtFrame: frameId,
          renderedAtFrame: 0, // stamped a few lines below at the render tail
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
      entry.renderedAtFrame = frameId;

      // Phase H — first-visible: snap the spring to a point just outside
      // the screen edge along the arrow's bearing, then let the spring
      // carry it to the halo ring target. Produces the "come in from
      // off-screen" feel the user asked for. Within the same arrow,
      // `lastVisible` stays true and the spring smoothly "flies" between
      // successive targets — that's the wedge-handoff cosmetic kept from
      // Phase D.
      if (!entry.lastVisible) {
        entry.sx.x = playerScreen.x + Math.cos(proj.theta) * offScreenSpawnPx;
        entry.sx.v = 0;
        entry.sy.x = playerScreen.y - Math.sin(proj.theta) * offScreenSpawnPx;
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
      if (entry.renderedAtFrame !== frameId) {
        entry.gfx.visible = false;
        entry.lastVisible = false;
      }
      if (entry.presentAtFrame !== frameId) {
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
    this.camera = null;
    this.lastUpdateMs = null;
  }
}
