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
  groupingDistanceForBand,
  RADAR_MAX_DISTANCE,
  RADAR_WEDGE_COUNT,
  type Candidate,
  type PartitionScratch,
} from './halo/wedgeGrouping.js';
import {
  paintHaloGlyph,
  buildHaloGlyph,
  haloContactKind,
} from './halo/arrowGraphics.js';
import {
  getVisibleBoundsWithDeadZone,
  isEntityOnScreen,
  DEAD_ZONE_PX_DESKTOP,
  DEAD_ZONE_PX_MOBILE,
  type WorldBounds,
} from './halo/visibility.js';
import { ENTITY_VISUALS, type EntityKind } from './entityVisuals.js';

// Re-export for the radar test suite (the include/exclude + classification lock).
export { haloContactKind } from './halo/arrowGraphics.js';

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

/** Module-scope comparator hoisted out of the per-call `.sort()` site
 *  (Phase 5f — invariant #14). An inline arrow `(a, b) => a.dist -
 *  b.dist` is recreated per call by V8 in some contexts; hoisting
 *  eliminates the uncertainty. */
function compareByDist(a: Candidate, b: Candidate): number {
  return a.dist - b.dist;
}

/** Mutable view of Candidate for slot-reuse writes. The Candidate
 *  interface is already non-readonly so this is a name-only cast. */
type MutableCandidate = Candidate;

function writeCandidateSlot(
  arr: MutableCandidate[], i: number,
  key: string, x: number, y: number, kind: EntityKind, dist: number,
  hostile: boolean,
): void {
  const color = ENTITY_VISUALS[kind].color;
  const slot = arr[i];
  if (!slot) {
    arr[i] = { key, x, y, color, kind, dist, hostile };
    return;
  }
  slot.key = key; slot.x = x; slot.y = y;
  slot.color = color; slot.kind = kind; slot.dist = dist; slot.hostile = hostile;
  // grouped is the partition-step's wedge marker; reset to undefined so
  // a stale `true` from a prior tick doesn't leak through.
  if (slot.grouped !== undefined) slot.grouped = false;
}
// Cap on dead-reckoning extrapolation window. If a swarm entry hasn't
// updated for longer than this, freeze at the last-reported pose instead
// of letting the arrow fly off — a stale entity is more likely dead /
// out-of-bounds than continuing at constant velocity forever.
const ARROW_EXTRAP_CAP_MS = 400;
// WS-B #2 — on-screen entities are excluded at CANDIDATE-BUILD time via a
// pure isEntityOnScreen test against the dead-zone-inset viewport bounds
// (visibility.ts), so a contact already visible on screen never gets a ring
// icon. This replaces the old Phase-P ON_SCREEN_HIDE_MS=500 timer, which
// let a just-placed on-screen structure's icon pop in, zoom, then vanish
// half a second later.
// Spring half-life for arrow screen-pixel position smoothing. Operates on
// the screen-space target (not world-space) so player movement no longer
// translates into apparent arrow lag — overtake is solved by the screen-
// space architecture, not by the spring. The spring's remaining role is
// purely cosmetic: smooth corrections when extrapolation snaps to a fresh
// packet, and the "fly-in" feel when a wedge's representative changes.
const ARROW_SMOOTH_HALF_LIFE_MS = 130;

interface ArrowEntry {
  gfx: Graphics;
  /** Current visual-language kind (hostile/neutral/ship/structure). Tracked so a
   *  wedge representative that changes type (or a drone flipping hostile↔neutral)
   *  detects the mismatch and repaints the glyph instead of leaving a stale one. */
  kind: EntityKind;
  /** Whether the entry uses the larger "grouped" glyph. Tracked alongside `kind`
   *  so a singleton↔wedge-rep transition triggers a glyph repaint. */
  grouped: boolean;
  /** Critically-damped spring state for the arrow's screen-pixel x. */
  sx: SpringState;
  /** Critically-damped spring state for the arrow's screen-pixel y. */
  sy: SpringState;
  /** True iff this arrow rendered on the previous frame. Used to snap the
   *  springs to-target on a hidden → visible transition instead of letting
   *  them spring in from the previous hidden position. WS-B #2: an entity
   *  going on-screen now drops OUT of the candidate list, so its arrow is
   *  swept (lastVisible → false); when it goes back off-screen it re-enters
   *  the candidate list and springs in from off-screen via the
   *  `!entry.lastVisible` branch — the off↔on-screen fly-in is preserved. */
  lastVisible: boolean;
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
  /** WS-B #3/#4 — true on touch devices: glyphs scale down (#3) and the
   *  dead-zone band uses the tighter mobile inset (#4). Threaded from the
   *  renderer (PixiRenderer already holds `_isTouch`). */
  private readonly _isTouch: boolean;

  constructor(isTouch = false) {
    this._isTouch = isTouch;
  }

  private readonly container = new Container();
  private camera: Camera | null = null;
  private readonly arrows = new Map<string, ArrowEntry>();
  /** WS-B #2/#4 — caller-owned scratch for the dead-zone-inset viewport
   *  bounds. Reused every update() (invariant #14): the on-screen-exclusion
   *  test reads it during candidate build. */
  private readonly _deadZoneBounds: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
  /** Monotonic per-`update()` counter for the generation-counter
   *  sweep over `arrows`. Bumped at the top of `update()`. */
  private _radarFrameId = 0;
  /** Per-call scratch for the rawCandidates build (Phase 5f). Reused
   *  across update() calls; entries are mutated in place via
   *  `writeCandidateSlot`. `arr.length = i` truncates the logical view;
   *  slot instances persist. */
  private readonly _rawCandidatesScratch: MutableCandidate[] = [];
  /** Cache of `swarm:${id}` / `ship:${id}` key strings keyed by entity
   *  id. Each lookup-or-create on a stable id is allocation-free after
   *  the first observation. */
  private readonly _swarmKeyCache = new Map<number, string>();
  private readonly _shipKeyCache = new Map<string, string>();
  /** Caller-owned scratch for `partitionAndGroupCandidates` (Phase 5c).
   *  Reused across update() calls so the radar tick doesn't allocate
   *  `result`, `wedges`, or per-wedge representative literals. */
  private readonly _partitionScratch: PartitionScratch = {
    result: [],
    wedges: new Map<number, Candidate>(),
    wedgeReps: [],
  };
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

    // WS-B #2/#4 — viewport bounds for the candidate-build on-screen
    // exclusion, INSET by the dead-zone band so an entity hovering at the
    // exact viewport edge keeps its ring indicator (no on/off flicker as it
    // jitters across the precise boundary). The inset is the touch-vs-desktop
    // dead-zone px converted to world units (worldPerPx = 1 / camera.scale.x).
    const rawBounds = camera.getVisibleBounds();
    const worldPerPx = camera.scale.x > 0 ? 1 / camera.scale.x : 1;
    const deadZonePx = this._isTouch ? DEAD_ZONE_PX_MOBILE : DEAD_ZONE_PX_DESKTOP;
    const onScreenBounds = getVisibleBoundsWithDeadZone(
      rawBounds,
      deadZonePx,
      worldPerPx,
      this._deadZoneBounds,
    );

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

    // Pooled scratch — slot-reuse pattern (Phase 5f, invariant #14).
    const rawCandidates = this._rawCandidatesScratch;
    let rawCount = 0;
    // WS-B #2 — track the nearest off-screen contact so the grouping
    // distance can be banded (close ⇒ tighter grouping). Updated in both
    // candidate loops; seeded to +Inf so an empty frame yields the band
    // floor.
    let closestDist = Infinity;

    if (mirror.swarm) {
      for (const [id, e] of mirror.swarm) {
        // Equinox Tweaks Phase 2 (#4) — the ring shows THREATS + bases, not
        // clutter: asteroids (kind 0) and scrap (kind 3) are excluded entirely
        // (the user: "asteroids, scrap and lingering ships shouldn't even show").
        // Only drones (kind 1) and structures (kind 2) pass.
        const isDrone = e.kind === 1;
        const hostile = isDrone && (e.isHostileToLocal ?? false);
        // Map to the shared visual language (hostile ★ / neutral ◆ / structure ⬢)
        // — null EXCLUDES the contact (asteroids kind 0, scrap kind 3) per the
        // user's "asteroids, scrap and lingering ships shouldn't even show".
        const kind = haloContactKind(e.kind, hostile);
        if (kind === null) continue;
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
        // WS-B #2 — exclude on-screen contacts at CANDIDATE-BUILD time. A
        // contact already visible in the (dead-zone-inset) viewport needs no
        // off-screen indicator, so it never becomes a ring icon.
        if (isEntityOnScreen(xExtrap, yExtrap, onScreenBounds)) continue;
        const dist = Math.hypot(xExtrap - local.x, yExtrap - local.y);
        if (dist < closestDist) closestDist = dist;
        // Cache the template-literal key so subsequent observations of
        // the same id are allocation-free.
        let key = this._swarmKeyCache.get(id);
        if (key === undefined) {
          key = `swarm:${id}`;
          this._swarmKeyCache.set(id, key);
        }
        writeCandidateSlot(rawCandidates, rawCount, key, xExtrap, yExtrap, kind, dist, hostile);
        rawCount++;
      }
    }
    // Remote PLAYER ships → ▲ green. (mirror.ships holds only active remote
    // players; lingering hulls live in mirror.lingeringShips and are NOT
    // iterated, so they never show on the ring — per the user's request.)
    for (const [id, s] of mirror.ships) {
      if (id === localId) continue;
      // WS-B #2 — exclude on-screen remote ships at candidate-build time.
      if (isEntityOnScreen(s.x, s.y, onScreenBounds)) continue;
      const dist = Math.hypot(s.x - local.x, s.y - local.y);
      if (dist < closestDist) closestDist = dist;
      let key = this._shipKeyCache.get(id);
      if (key === undefined) {
        key = `ship:${id}`;
        this._shipKeyCache.set(id, key);
      }
      writeCandidateSlot(rawCandidates, rawCount, key, s.x, s.y, 'ship', dist, false);
      rawCount++;
    }
    rawCandidates.length = rawCount;

    // Closest-first so MAX_ARROWS truncation drops the farthest entities and
    // wedge-grouping receives a deterministic input order.
    rawCandidates.sort(compareByDist);
    if (rawCandidates.length > MAX_ARROWS) {
      rawCandidates.length = MAX_ARROWS;
    }

    // WS-B #2 — distance-banded grouping. The flat 2000 u grouping distance
    // kept every close contact ungrouped, so a tight cluster at close range
    // each got its own ring icon. Band the grouping distance by the nearest
    // contact: close ⇒ tighter grouping (close clusters collapse to one
    // wedge representative), far ⇒ the legacy flat distance (spread-out
    // mid/long-range targets keep singleton arrows).
    const groupingDistance = groupingDistanceForBand(closestDist);
    const candidates = partitionAndGroupCandidates(
      { x: local.x, y: local.y },
      rawCandidates,
      groupingDistance,
      RADAR_MAX_DISTANCE,
      RADAR_WEDGE_COUNT,
      this._partitionScratch,
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
        // Degenerate POI-overlaps-player case only. WS-B #2 moved the
        // on-screen hide to candidate-build (an on-screen contact is never
        // in `candidates`), so the only "hide me" case left here is the
        // divide-by-zero one.
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

      const wantKind: EntityKind = c.kind ?? 'neutral';
      const wantGrouped = c.grouped === true;
      if (!entry) {
        const gfx = buildHaloGlyph(wantKind, wantGrouped, this._isTouch);
        this.container.addChild(gfx);
        entry = {
          gfx,
          kind: wantKind,
          grouped: wantGrouped,
          sx: { x: targetX, v: 0 },
          sy: { x: targetY, v: 0 },
          lastVisible: false,
          presentAtFrame: frameId,
          renderedAtFrame: 0, // stamped a few lines below at the render tail
        };
        this.arrows.set(c.key, entry);
      } else if (entry.kind !== wantKind || entry.grouped !== wantGrouped) {
        // Wedge representative type changed (or a drone flipped hostile↔neutral,
        // or singleton↔group) — repaint the glyph. Bounded cost: at most
        // RADAR_WEDGE_COUNT + active hostility-flip count per frame.
        paintHaloGlyph(entry.gfx, wantKind, wantGrouped, this._isTouch);
        entry.kind = wantKind;
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
      // Glyphs are UPRIGHT (Phase 2 #4) — the bearing is conveyed by the
      // marker's POSITION on the ring, not by rotating a needle (a rotated
      // ★/⬢ reads as broken). The old code set `rotation = -proj.theta`.
      entry.gfx.rotation = 0;
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
