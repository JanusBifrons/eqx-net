import { Application, Graphics, Container } from 'pixi.js';
import { ShockwaveFilter, ZoomBlurFilter, BloomFilter } from 'pixi-filters';
import { Camera } from './worker/Camera';
import type { IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { DEFAULT_WARP_PARAMS, type WarpParams, type WarpCenter, type FrameMarkers } from './worker/protocol';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';
import { resolveDroneDisplayPose } from '../net/swarmDisplayPose';
import { HaloRadar } from './HaloRadar';
import { DamageNumberManager } from './DamageNumbers';
import { HealthBarManager } from './HealthBars';
import { LabelManager } from './Labels';
import { decideLingeringSpriteAction, decideExplosionPosition } from './spriteUpdateDecisions';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { StarfieldBackground } from './StarfieldBackground';
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { getShipKind, type ShipShape, type WeaponMount } from '../../shared-types/shipKinds';

const SERVER_GHOST_COLOR = 0xff4400;
const ASTEROID_COLOR = 0x886644;
const ASTEROID_OUTLINE = 0xbb9966;
const DRONE_FILL_COLOR = 0xff3366;
const DRONE_OUTLINE_COLOR = 0xffaacc;
const DRONE_CORE_COLOR = 0xffeeaa;
const HITBOX_COLOR = 0xff0066;
const BACKGROUND_COLOR = 0x05070f;
const SHIP_HITBOX_RADIUS = 12; // must match World.ts SHIP_RADIUS
// Soft pink tint — multiplied with each ship's base colour, this gives a
// legible "I just got hit" flash without crushing the green/blue hull tone.
// (0xff2222 was the original but tinted local-ship green nearly black.)
const DAMAGE_FLASH_COLOR = 0xffaaaa;
const PROJECTILE_COLOR = 0xffdd44;
const GHOST_PROJECTILE_COLOR = 0xff8800;
const LASER_BEAM_COLOR = 0x00eeff;
const LASER_CORE_COLOR = 0xffffff;
const REMOTE_LASER_COLOR = 0xff6600;
const LASER_BOLT_OUTER = 0xff2244;
const LASER_BOLT_CORE  = 0xffffff;

/**
 * Load-curtain tween constants. The curtain rises quickly (so the
 * canvas doesn't briefly leak through during the transition into
 * loading) and fades over the same window as `flashDurationMs` so the
 * arrival flash can hide the curtain fade.
 */
const CURTAIN_PEAK_ALPHA = 0.97;
const CURTAIN_RISE_MS = 200;
const CURTAIN_FADE_MS = 380;

/**
 * Decision: should the warp filter chain be detached from `app.stage`?
 *
 * Returns `true` only when every warp visual element is idle:
 *   - the burst + flash one-shot has finished (`burstStartedAt === 0`),
 *   - the fade-out tween is not in progress (`fadeStartedAt === 0`),
 *   - the fade scalar has reached zero (`intensity <= 0`).
 *
 * Called from two paths in `tickWarpShockwaves`: the fade-completion
 * branch (the burst might still be playing when fade ends) AND the
 * burst-completion branch (the fade might have ended earlier). If
 * either path forgets to tear down, the shockwaves / burst / zoom-blur /
 * bloom chain stays attached and burns 4+ no-op shader passes per
 * frame. On mid-range Android that's the difference between 60 fps
 * and a 100–200 ms raf_gap storm — see the 2026-05-15 mobile lag
 * report. Regression-locked by `PixiRenderer.warpDetach.test.ts`.
 */
export function shouldDetachWarpVisual(state: {
  burstStartedAt: number;
  fadeStartedAt: number;
  intensity: number;
}): boolean {
  return state.burstStartedAt === 0
    && state.fadeStartedAt === 0
    && state.intensity <= 0;
}

/**
 * Single source of truth for WHEN the warp burst+flash fires.
 *
 * Post Phase-G the load curtain rises at `transit_ready` (the
 * join-readiness re-arm flips `!gameReady` → loading=true) — BEFORE
 * the SPOOLING→IN_TRANSIT transition. So a burst fired from
 * `setWarpMode(false)` (the old spool-exit "climax") now ALWAYS fires
 * under the already-raised curtain: never a visible climax, and the
 * ~200 ms curtain-rise tween vs the fast room-swap lets it BLEED
 * through as a leaky flash, then the 5 s minimum-display floor, then
 * `triggerWarpIn`'s real arrival flash — a reordered double-flash with
 * a blackout between (on-device 2026-05-16, user smoke test). The
 * earlier theoretical "keep the climax, mask it" (Phase-G Option B)
 * was falsified on-device: a climax that is *always* occluded is pure
 * downside. Policy (Option A): exactly ONE warp flash per inter-sector
 * transit — the arrival reveal (`triggerWarpIn`, `'warp-in'`). The
 * warp-OUT (`setWarpMode(false)`, `'warp-mode-off'`) only fades the
 * filter chain out; the spool start (`setWarpMode(true)`,
 * `'warp-mode-on'`) ramps amplitude, no pulse.
 *
 * Both `PixiRenderer` `fireBurst()` call-sites defer to this (mirrors
 * `shouldDetachWarpVisual` — the extracted, unit-tested tear-down
 * decision). Regression-locked by `PixiRenderer.warpBurst.test.ts`.
 */
export type WarpBurstEvent = 'warp-in' | 'warp-mode-on' | 'warp-mode-off';
export function warpEventFiresBurst(event: WarpBurstEvent): boolean {
  return event === 'warp-in';
}

/**
 * Resolve the warp filter centre, in the renderer's screen-pixel
 * frame (the same frame `world.toGlobal` / `camera.screenWidth`
 * report — NO resolution rescale; see history note below).
 *
 * Coordinate-frame contract — the bug this encodes:
 *
 *   A `{kind:'world'}` warp anchor carries GAME-space coords (App.tsx
 *   reads them straight from `mirror.ships`, which is game-space, the
 *   same source the HUD grid readout uses). Game space is Y-UP. The
 *   renderer's `world` container is Pixi-space, Y-DOWN: every entity
 *   is drawn at `sprite.y = -ship.y`, and the camera follows the
 *   already-flipped sprite. So projecting a game-space anchor MUST
 *   negate Y first (`projectWorld(worldX, -worldY)`) — exactly the
 *   `-ship.y` flip every sprite gets. Without it the ripple lands at
 *   the *vertical mirror* of the ship (offset 2·shipY·scale); at a
 *   non-zero spawn Y it flings the pulse off-screen. The sandbox
 *   looked perfect because it only ever used screen-space / null
 *   anchors, which never hit the world projection (and so never the
 *   flip). 2026-05-15 smoke-test: "spawned in and it was off screen
 *   to the bottom right".
 *
 *   History: an earlier fix multiplied the result by
 *   `renderer.resolution`, theorising a HiDPI `uInputSize` mismatch.
 *   That was WRONG — the on-device evidence is decisive: the sandbox
 *   screen-centre warp was confirmed pixel-correct on the user's
 *   actual phone (DPR 3) with NO scaling, so the renderer's screen
 *   frame already matches the filter's `uInputSize` frame. The real
 *   defect was always the game→Pixi Y flip on the world-anchor path.
 *   Do not re-add a resolution multiply.
 *
 *   `entity` is the PRIMARY fix for the 2026-05-15 follow-up ("did
 *   the effect at the point when I started charging instead of where
 *   I actually was", and the user's architectural point: "what if a
 *   remote or bot ship is warping?"). The renderer re-resolves the
 *   anchor's `entityId` to that ship's LIVE sprite global position
 *   every frame and passes it as `entityGlobal`; the centre tracks
 *   the ship through the whole spool→climax→burst instead of freezing
 *   at the App.tsx capture instant. It is NOT local-specific — any
 *   ship id (local, remote, bot) resolves the same way. Because the
 *   live sprite is already correctly placed (`sprite.y = -ship.y`),
 *   this path needs no Y flip.
 *
 * `world` is now only for a genuinely point-anchored burst with NO
 * live entity to track — currently remote warp-OUT broadcasts, where
 * the ship has already despawned so a fixed "where it left from"
 * point IS correct (`pendingWarpEvents`). `screen` (sandbox click)
 * and `null` → screen-centre are already in Pixi screen space — no
 * flip, no scale.
 *
 * Pure + Pixi-free (mirrors the `shouldDetachWarpVisual` pattern):
 * `projectWorld` injects `world.toGlobal` and `entityGlobal` is
 * pre-resolved by the renderer (scene-graph access stays out of this
 * helper). Regression-locked by `PixiRenderer.warpCenter.test.ts`.
 */
export function resolveWarpFilterCenter(args: {
  warpCenter: WarpCenter | null;
  /** Pixi-space `world.toGlobal`. Called with ALREADY Y-flipped coords. */
  projectWorld: (pixiX: number, pixiY: number) => { x: number; y: number };
  /** Live screen-px position of the anchored entity's sprite, or null
   *  if it has no live sprite (despawned mid-warp / not spawned yet). */
  entityGlobal: { x: number; y: number } | null;
  screenW: number;
  screenH: number;
}): { x: number; y: number } {
  const screenCentre = { x: args.screenW * 0.5, y: args.screenH * 0.5 };
  if (args.warpCenter === null) return screenCentre;
  switch (args.warpCenter.kind) {
    case 'entity':
      // Live every frame — the renderer re-resolves `entityId` to that
      // ship's current sprite position before calling this. Works for
      // ANY ship (local, remote, bot), so there's no local special-
      // case. Falls back to screen centre if the entity has no live
      // sprite (despawned mid-warp / not spawned yet) so the effect
      // never vanishes.
      return args.entityGlobal ?? screenCentre;
    case 'world':
      // Game space (Y-up) → Pixi space (Y-down): negate Y, exactly as
      // every sprite is placed (`sprite.y = -ship.y`).
      return args.projectWorld(args.warpCenter.worldX, -args.warpCenter.worldY);
    case 'screen':
      return { x: args.warpCenter.screenX, y: args.warpCenter.screenY };
  }
}

/**
 * Convert a `ShipShape` from the catalogue into a Pixi `Graphics`. The polygon
 * is drawn from the shape's points (entity-local space, nose at -y, tail at
 * +y) scaled by `shape.scale`. `tintOverride` lets the caller apply the
 * legacy "local = green, remote = blue" colour scheme on top of the kind's
 * native colour (the local tint is applied as a fill colour override; the
 * kind colour is used otherwise so all three kinds remain visually distinct).
 *
 * The dashed hitbox circle stays kind-agnostic — it always traces the
 * collider radius, which the catalogue keeps in sync with the polygon's
 * visual extent so collisions feel honest.
 */
function buildShipGfxFromShape(shape: ShipShape, tintOverride?: number): Graphics {
  const g = new Graphics();
  const scale = shape.scale;
  g.poly(shape.points.map(([x, y]) => ({ x: x * scale, y: y * scale })));
  g.fill({ color: tintOverride ?? shape.color });
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

/** Resolve `ShipRenderState.kind` to a concrete shape, with fallback. */
function shapeForKind(kindId: string | undefined): ShipShape {
  return getShipKind(kindId).shape;
}

/** Drain colour and tilt it grey for the Phase 4 wreck silhouette. Take
 *  ~30 % of the original RGB and mix in a desaturated grey so the wreck
 *  reads as "broken ship of that kind" without screaming the kind's
 *  brand colour. */
function desaturate(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8)  & 0xff;
  const b =  color        & 0xff;
  const grey = Math.round((r + g + b) / 3);
  // 30% original, 70% grey — gives a smoky, drained tone.
  const mix = (c: number) => Math.round(c * 0.30 + grey * 0.70);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * Baseline thrust flame — shown whenever a ship is accelerating, regardless
 * of boost. Two concentric tapered triangles (outer orange, inner yellow-white
 * core). Aligned to the ship's local frame; the renderer inherits the ship's
 * rotation by adding the flame as a child of the sprite.
 */
const THRUST_FLAME_COLOR_OUTER = 0xff7733;
const THRUST_FLAME_COLOR_CORE  = 0xffee99;
function buildThrustFlameGfx(): Graphics {
  const g = new Graphics();
  // Outer plume — tapered triangle pointing astern (local +y in pixi).
  // Ship body extends from y=-16 (nose) to y=10 (tail); flame starts at y=10.
  g.poly([
    { x: -7, y: 10 },
    { x:  7, y: 10 },
    { x:  0, y: 36 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Inner core — brighter, narrower.
  g.poly([
    { x: -3, y: 10 },
    { x:  3, y: 10 },
    { x:  0, y: 24 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_CORE, alpha: 0.95 });
  return g;
}

/**
 * Boost exhaust flame — layered ON TOP of the thrust flame while a ship is
 * boosting. Longer, wider, with a bluish-white plasma core to read as
 * "hotter / more energetic" than the baseline thrust flame.
 */
const BOOST_FLAME_COLOR_OUTER  = 0xff5511;
const BOOST_FLAME_COLOR_CORE   = 0xffee99;
const BOOST_FLAME_COLOR_PLASMA = 0x88ccff;
function buildBoostFlameGfx(): Graphics {
  const g = new Graphics();
  // Extended outer plume — wider base, longer tail.
  g.poly([
    { x: -10, y: 10 },
    { x:  10, y: 10 },
    { x:   0, y: 54 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Mid yellow-white layer — bridges outer orange to plasma core.
  g.poly([
    { x: -5, y: 10 },
    { x:  5, y: 10 },
    { x:  0, y: 40 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_CORE, alpha: 0.95 });
  // Plasma core — bluish-white spike to suggest extreme heat.
  g.poly([
    { x: -2, y: 10 },
    { x:  2, y: 10 },
    { x:  0, y: 28 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_PLASMA, alpha: 0.9 });
  return g;
}

function buildAsteroidGfx(entityId: number, radius: number): Graphics {
  const g = new Graphics();
  // Same generator the server uses to build the convex-hull collider — both
  // sides seed from the same entityId, so the rendered silhouette matches the
  // physics shape exactly. Vertices are emitted in math-space (Y-up); the
  // sprite is rendered in Pixi screen space (Y-down) and rotated by `-angle`.
  // For symmetric polygons (ship/drone) the y-flip is invisible, but an
  // asymmetric polygon mismatches its collision hull as it rotates unless
  // every vertex's y is negated for drawing only.
  const mathVerts = generateAsteroidVertices(entityId, radius);
  const screenVerts = mathVerts.map((v) => ({ x: v.x, y: -v.y }));
  g.poly(screenVerts);
  g.fill({ color: ASTEROID_COLOR });
  g.poly(screenVerts);
  g.stroke({ color: ASTEROID_OUTLINE, width: 1.5 });
  return g;
}

/**
 * Drone visual — angular dart pointing along the body's forward direction
 * (`(-sin θ, cos θ)` per the World forward convention; renderer rotates by
 * `-angle` so the dart's local +y nose maps to world forward). Distinct
 * magenta-pink so drones never read as asteroids.
 */
function buildDroneGfx(radius: number): Graphics {
  const g = new Graphics();
  // Outer dart silhouette, nose pointing local up (-y in pixi).
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.fill({ color: DRONE_FILL_COLOR });
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.stroke({ color: DRONE_OUTLINE_COLOR, width: 1.5 });
  // Glowing core dot so they remain visible at small radii.
  g.circle(0, 0, Math.max(2, radius * 0.25));
  g.fill({ color: DRONE_CORE_COLOR });
  return g;
}

function buildGhostGfx(): Graphics {
  const g = new Graphics();
  g.poly([{ x: 0, y: -14 }, { x: 10, y: 0 }, { x: 0, y: 14 }, { x: -10, y: 0 }]);
  g.fill({ color: SERVER_GHOST_COLOR, alpha: 0.55 });
  g.circle(0, 0, 12);
  g.stroke({ color: SERVER_GHOST_COLOR, width: 1.5, alpha: 0.9 });
  return g;
}

function buildProjectileGfx(isGhost: boolean): Graphics {
  const g = new Graphics();
  const color = isGhost ? GHOST_PROJECTILE_COLOR : PROJECTILE_COLOR;
  g.circle(0, 0, 4);
  g.fill({ color, alpha: isGhost ? 0.7 : 1 });
  return g;
}

function buildLaserBoltGfx(): Graphics {
  const g = new Graphics();
  // Outer glow — short bright line
  g.moveTo(0, -12).lineTo(0, 12);
  g.stroke({ color: LASER_BOLT_OUTER, width: 5, alpha: 0.5 });
  // Inner white core
  g.moveTo(0, -10).lineTo(0, 10);
  g.stroke({ color: LASER_BOLT_CORE, width: 2, alpha: 1 });
  return g;
}

function buildBeamGfx(dx: number, dy: number): Graphics {
  const g = new Graphics();
  // Outer glow
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
  // Bright core
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
  return g;
}

/** Compute the world position of a mount's pivot given the host ship's pose.
 *  Multi-mount/turret refactor (Phase 2c). For legacy single-mount ships
 *  mount.localX/Y = (0, 0), so the result is just (shipX, shipY) — same as
 *  the pre-refactor "fire from ship centre" path. `mount` may be undefined
 *  when a pre-2c server omits `mountId` from a `laser_fired` event; in that
 *  case we fall back to ship centre (no offset). */
function applyMountOffset(
  shipX: number,
  shipY: number,
  shipAngle: number,
  mount: WeaponMount | undefined,
): { x: number; y: number } {
  if (!mount) return { x: shipX, y: shipY };
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  return {
    x: shipX + (mount.localX * cosA - mount.localY * sinA),
    y: shipY + (mount.localX * sinA + mount.localY * cosA),
  };
}

function buildExplosionGfx(): Graphics {
  const g = new Graphics();
  // Simple starburst: 8 lines radiating from center.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const r = 20;
    g.moveTo(0, 0).lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  g.stroke({ color: 0xff6600, width: 2, alpha: 0.9 });
  g.circle(0, 0, 8);
  g.fill({ color: 0xffaa00, alpha: 0.8 });
  return g;
}

export class PixiRenderer implements IRenderer {
  private app!: Application;
  /**
   * World Container — replaces `pixi-viewport`'s `Viewport`. Holds all
   * gameplay sprites (ships, swarm, projectiles, beams, wrecks,
   * lingering hulls, background grid, etc.). Pan / zoom / momentum are
   * driven by the `Camera` controller below.
   */
  private world!: Container;
  /** Camera controller — owns world's transform via pointer/wheel events. */
  private camera!: Camera;
  private shipContainer!: Container;
  /**
   * Warp-mode render state — the "loading screen" rendered ON the same
   * canvas as gameplay (no separate Pixi Application). When `warpActive`
   * is true the renderer attaches a stack of `ShockwaveFilter` instances
   * to `app.stage`. Each filter advances its `time` uniform on a phase
   * offset so multiple concentric ripples expand from screen centre
   * simultaneously, growing in amplitude as warp progress ramps up.
   *
   * `warpIntensity` ∈ [0, 1] is the **fade-out scalar** — 1 while warp
   * is armed and steady, ramping to 0 over `fadeOutMs` after
   * `setWarpMode(false)`. The amplitude **ramp-up** is separately driven
   * by `warpStartedAt` over `warpParams.rampMs`.
   *
   * Filter array is built lazily on first `setWarpMode(true)` and
   * preserved across re-entry. Tunable params live in `warpParams`
   * (defaults from `DEFAULT_WARP_PARAMS`); the visual-effects sandbox
   * spike posts `SET_WARP_PARAMS` to mutate them live for iteration.
   *
   * Why ShockwaveFilter-only: prior 3-filter chain (OldFilm + Shockwave
   * + RGBSplit) was expensive on mobile because OldFilm regenerates
   * procedural noise + scratches per-frame. ShockwaveFilter is a single
   * radial-displacement pass (cheap), so stacking 4 of them costs less
   * than the prior chain while producing the rippling effect more
   * directly. GlitchFilter remains unusable in worker context — see
   * `WarpParams` doc in `worker/protocol.ts`.
   */
  private warpActive = false;
  private warpStage: Container | null = null;
  private warpShockwaves: ShockwaveFilter[] | null = null;
  /** Radial motion-blur layered on top of the shockwave stack at the same
   *  centre. Cheap pure-shader filter (no DOM, worker-safe). */
  private warpZoomBlur: ZoomBlurFilter | null = null;
  /** Current params for the warp visual. Defaults from `DEFAULT_WARP_PARAMS`;
   *  mutated by `setWarpParams(partial)` (sandbox-only). */
  private warpParams: WarpParams = { ...DEFAULT_WARP_PARAMS };
  /** Anchor for the warp centre. World-space anchors are projected to
   *  screen via `world.toGlobal` each frame; screen-space anchors are
   *  used as-is. `null` = use screen centre. See `WarpCenter` in
   *  `worker/protocol.ts`. */
  private warpCenter: WarpCenter | null = null;
  /** Wall-clock ms when warp was last armed. Drives the two-phase ramp. */
  private warpStartedAt = 0;
  /** Fade-out scalar 0..1 — 1 while armed, ramps to 0 over fadeOutMs after disarm. */
  private warpIntensity = 0;
  /** Wall-clock ms when fade-out started, or 0 if not fading. */
  private warpFadeStartedAt = 0;
  /** Current warp phase. Drives count + radius selection in the tick. */
  private warpPhase: 'idle' | 'spool' | 'climax' = 'idle';
  /** Wall-clock ms when the current phase began. Used to compute each
   *  ShockwaveFilter's `time` uniform RELATIVE to phase start, so the
   *  wave is always at radius 0 at phase entry rather than at whatever
   *  random radius `(performance.now() / 1000) % cycleSec` happens to
   *  produce. Without this the climax wave can spawn mid-cycle and be
   *  invisibly far off-centre for the first ~second of climax. */
  private warpPhaseStartedAt = 0;
  /** Count + radius the current `warpShockwaves` array was built for.
   *  When `warpPhase` transitions, the tick rebuilds the array if these
   *  no longer match the desired (phase-derived) values. */
  private warpStackCount = 0;
  private warpStackRadius = -1;
  /** One-shot ShockwaveFilter that fires at the exit moment (when
   *  `setWarpMode(false)` is called) and at warp-in. Lives in the
   *  filter chain at amplitude 0 most of the time. */
  private warpBurst: ShockwaveFilter | null = null;
  /** Wall-clock ms when the burst was last triggered, or 0 if inactive. */
  private warpBurstStartedAt = 0;
  /** Full-canvas white overlay that fires alongside the burst — hides
   *  the ship's despawn / cushions the arrival. Lives on `warpStage`
   *  (above world, NOT inside the warp filter chain). */
  private warpFlash: Graphics | null = null;
  /** Full-canvas dark overlay used as a "loading curtain" during the
   *  join + transit load periods — hides the canvas while the mirror
   *  is empty / partial / pre-snapshot so the user doesn't see ship-
   *  at-(0,0) ghost frames or rippled-asteroid bleed-through. Lives on
   *  `warpStage` BELOW `warpFlash` so the flash can pop on top during
   *  the arrival reveal. Pure alpha-tween animation. */
  private loadCurtain: Graphics | null = null;
  /** Target alpha for the curtain — set by `setLoadCurtain`. Tweened
   *  toward this each frame in `tickWarpShockwaves`. */
  private loadCurtainTargetAlpha = 0;
  /** Wall-clock ms when the current curtain tween started. */
  private loadCurtainTweenStartedAt = 0;
  /** Curtain alpha at the moment the current tween started. */
  private loadCurtainTweenFromAlpha = 0;
  /** BloomFilter applied last in the warp chain so the bright wavefront
   *  glows. Strength ramps with climax progress + fade-out intensity;
   *  amplifies the burst's `brightness` uniform so distant viewers
   *  catch the wavefront as a luminous line even before displacement
   *  reaches their screen. */
  private warpBloom: BloomFilter | null = null;
  /** When a `triggerWarpIn` call was the SOLE trigger (no spool/climax /
   *  fade was active), this flag lets the tick tear down the filter
   *  attachment after the burst completes. */
  private warpStandaloneBurst = false;
  private sprites = new Map<string, Graphics>();
  /** Phase 4 — sprites for abandoned-ship wrecks. Keyed by shipInstanceId.
   *  Drawn with a desaturated kind colour; updated each frame from
   *  `mirror.wrecks`. Removed when the wreck disappears from the mirror. */
  private wreckSprites = new Map<string, Graphics>();
  /** Per-ship boost-exhaust flame, parented to the ship sprite. Visible only
   *  while the ship is in `mirror.boostingShips`. Pooled — created on first
   *  boost, hidden when not active, destroyed with the ship sprite. */
  private boostFlames = new Map<string, Graphics>();
  /** Per-ship turret sprites + aim lines (multi-mount/turret refactor,
   *  Phase 3). Parented to each ship's main `sprite` so the cluster inherits
   *  the ship's world transform; the cluster's own children sit at their
   *  mount-local offset and baseAngle rotation. */
  private mountVisuals = new MountVisualManager();
  /** Per-ship baseline thrust flame, parented to the ship sprite. Visible
   *  while the ship is in `mirror.thrustingShips` (any acceleration). Boost
   *  flame layers on top. Pooled — same lifecycle as `boostFlames`. */
  private thrustFlames = new Map<string, Graphics>();
  private serverGhost: Graphics | null = null;
  private projectileSprites = new Map<string, Graphics>();
  private explosionSprites: Array<{ gfx: Graphics; framesLeft: number }> = [];
  private liveBeamGfx: Graphics | null = null;
  private remoteBeamGfx: Graphics | null = null;
  private initialized = false;
  /** Reused per-frame so swarm interpolation doesn't allocate. */
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  private readonly halo = new HaloRadar();
  private damageNumbers: DamageNumberManager | null = null;
  private healthBars: HealthBarManager | null = null;
  private labels: LabelManager | null = null;
  private backgroundGrid: BackgroundGrid | null = null;
  private starfield: StarfieldBackground | null = null;
  /**
   * Renderer → main-thread feedback (see `RendererFeedback`). Populated
   * at the tail of every `update()` call; consumers read via
   * `getFeedback()` after `update()` returns.
   *
   * Mutated in place each frame rather than reallocated — avoids
   * per-frame GC pressure. The Map is cleared + repopulated; the outer
   * object identity is stable.
   */
  private readonly feedback: RendererFeedback = {
    mountCounts: new Map<string, number>(),
    haloArrowCount: 0,
    damageNumberActiveCount: 0,
    wreckSpriteCount: 0,
    firstFrameRendered: false,
  };

  /**
   * F1 instrumentation — per-frame worker-side sub-costs (warp-spool
   * perf investigation, `docs/HANDOFF-warp-spool-perf-followup.md`).
   * Mutated in place at the tail of `update()` (no per-frame alloc); the
   * worker reads it via `getFrameMarkers()` after `update()` returns and
   * posts a `FRAME_MARKERS` message ONLY when diagnostics are enabled.
   * `warpTickMs` / `filterCount` are written by the `tickWarpShockwaves`
   * ticker callback (a separate Pixi ticker, not part of `update()`), so
   * each `FRAME_MARKERS` carries the most recent warp-tick cost.
   *
   * This is deliberately NOT on `RendererFeedback` — that's a
   * phase-gated closed-set DI contract (see `IRenderer.ts` /
   * `src/client/CLAUDE.md`); a separate gated channel keeps the
   * contract untouched and the production cost at zero.
   */
  private readonly frameMarkers: FrameMarkers = {
    rendererUpdateMs: 0,
    spriteCount: 0,
    warpTickMs: 0,
    filterCount: 0,
    warpFiltersAttached: false,
    warpBurstAgeMs: -1,
    gridLabelSpecMs: 0,
    gridTextCreateMs: 0,
    gridCleanupMs: 0,
    gridLabelCount: 0,
  };

  /** Read the most recent per-frame sub-cost markers. See `FrameMarkers`
   *  + `getFeedback()` for the parallel (but contract-gated) channel. */
  getFrameMarkers(): FrameMarkers {
    return this.frameMarkers;
  }

  async init(rawContainer: unknown): Promise<void> {
    // Two init modes:
    //   - DOM context (main thread): rawContainer is an HTMLElement —
    //     we create a <canvas>, append it, size from clientWidth/Height.
    //     Install window resize + canvas event listeners.
    //   - Worker context (OffscreenCanvas): rawContainer is a
    //     `{ canvas: OffscreenCanvas; width; height; dpr }` bag — use
    //     the transferred canvas, size from the bag, no DOM listeners.
    //
    // The selector below is structural — checks for `transferControlToOffscreen`
    // on the host (DOM canvas has it; OffscreenCanvas itself does not).
    const isDom = typeof window !== 'undefined' && rawContainer instanceof HTMLElement;
    let initialW: number;
    let initialH: number;
    let initialDpr: number;
    let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
    let domContainer: HTMLElement | null = null;

    if (isDom) {
      domContainer = rawContainer as HTMLElement;
      initialW = domContainer.clientWidth || window.innerWidth;
      initialH = domContainer.clientHeight || window.innerHeight;
      initialDpr = window.devicePixelRatio ?? 1;
      // No `canvas:` option — Pixi creates one and we append it.
    } else {
      const bag = rawContainer as { canvas: OffscreenCanvas; width: number; height: number; dpr: number };
      canvas = bag.canvas;
      initialW = bag.width;
      initialH = bag.height;
      initialDpr = bag.dpr;
    }

    this.app = new Application();
    await this.app.init({
      ...(canvas ? { canvas: canvas as unknown as HTMLCanvasElement } : {}),
      width: initialW,
      height: initialH,
      background: BACKGROUND_COLOR,
      antialias: true,
      resolution: initialDpr,
      autoDensity: isDom,
    });
    if (domContainer) {
      domContainer.appendChild(this.app.canvas);
    }
    this.initialized = true;

    // Pixi v8 perf: disable per-sprite hit-test traversal on every
    // native pointer move (pixijs/pixijs#6515). Pre-refactor with
    // pixi-viewport, this was a major contention source. Skip in worker
    // context — `events.features` isn't initialised without a DOM event
    // source and the call would throw.
    if (isDom && this.app.renderer.events) {
      Object.assign(this.app.renderer.events.features, { globalMove: false });
    }

    // Starfield attached to app.stage BEFORE the world so it z-orders
    // below all gameplay (Pixi insertion-order z).
    this.starfield = new StarfieldBackground();
    this.starfield.attach(this.app);

    // World container hosts all camera-tracked gameplay. Pixi's
    // event-system traversal is opt-out (`eventMode='none'`) for the
    // gameplay subtree — see pixijs/pixijs#6515. Game-side taps are
    // routed via the Camera (which the App.tsx forwards canvas events
    // into), not Pixi's event system.
    this.world = new Container();
    this.world.eventMode = 'none';
    this.app.stage.addChild(this.world);

    // followLerpFactor=1 → instant follow each Pixi tick (60 Hz). This
    // matches pre-migration pixi-viewport's `viewport.moveCenter(x, y)`
    // every frame, but driven by the Pixi ticker rather than the per-
    // `update(mirror)` cadence. Decoupling from MIRROR_UPDATE eliminates
    // the wheel-zoom vibration that throttled mirror updates introduced
    // (camera was snapping between zoom-target and centered position
    // every other frame).
    this.camera = new Camera(this.world, {
      minScale: 0.4,
      maxScale: 3,
      followLerpFactor: 1,
    });
    this.camera.setScreenSize(initialW, initialH);

    this.backgroundGrid = new BackgroundGrid();
    this.backgroundGrid.attach(this.camera);

    this.shipContainer = new Container();
    this.camera.addChild(this.shipContainer);

    this.halo.init(this.camera);
    // Damage numbers attach to the world (pan with camera, anchored at
    // impact world coord) but counter-scale per frame so they stay
    // legible at any zoom — Camera ref needed for the per-frame
    // counter-scale.
    this.damageNumbers = new DamageNumberManager(this.world, this.camera);
    this.healthBars = new HealthBarManager(this.world);
    this.labels = new LabelManager(this.world);

    // Drive Camera momentum + follow each frame (works in both contexts).
    this.app.ticker.add(() => {
      this.camera.tick();
    });

    if (isDom && domContainer) {
      // Install canvas pointer/wheel listeners → camera state machine.
      // Camera replaces pixi-viewport's automatic event subscription.
      // Worker context: events arrive via postMessage and the worker
      // scaffolding (renderer.worker.ts) calls forwardPointerEvent /
      // forwardWheelEvent directly — no DOM listener path.
      this.installCanvasEventListeners(this.app.canvas);

      const measureSize = (): { w: number; h: number } => {
        const vv = window.visualViewport;
        const w = domContainer.clientWidth || vv?.width || window.innerWidth;
        const h = domContainer.clientHeight || vv?.height || window.innerHeight;
        return { w, h };
      };

      const resize = (): void => {
        // Late-fire guard: a queued `requestAnimationFrame(resize)` and the
        // ResizeObserver can both fire AFTER dispose() has destroyed the Pixi
        // application, leaving `this.app.renderer` null. Bailing on
        // !this.initialized is enough — dispose() flips that flag.
        if (!this.initialized || !this.app?.renderer) return;
        const { w, h } = measureSize();
        this.app.renderer.resize(w, h);
        this.camera.setScreenSize(w, h);
        this.starfield?.resize(w, h);
      };
      window.addEventListener('resize', resize);
      window.addEventListener('orientationchange', resize);
      window.visualViewport?.addEventListener('resize', resize);

      // Container-driven resize: catches layout settling on mobile (URL bar,
      // safe-area insets, dvh recalculation) that don't always fire window resize.
      const ro = new ResizeObserver(resize);
      ro.observe(domContainer);

      (this.app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
      (this.app as unknown as Record<string, unknown>)['_resizeObserver'] = ro;

      // Force one resize after the next frame to capture post-mount layout.
      requestAnimationFrame(resize);
    }
  }

  /**
   * Worker-context entry point. The renderer worker calls this when it
   * receives a RESIZE message — replicates the DOM resize() handler for
   * the OffscreenCanvas path.
   */
  resize(width: number, height: number): void {
    if (!this.initialized || !this.app?.renderer) return;
    this.app.renderer.resize(width, height);
    this.camera.setScreenSize(width, height);
    this.starfield?.resize(width, height);
  }

  /**
   * Worker-context entry point for synthesised pointer events forwarded
   * from the main thread. The Camera consumes via its state machine.
   */
  forwardPointerEvent(e: { type: string; pointerId: number; offsetX: number; offsetY: number; stamp: number }): void {
    switch (e.type) {
      case 'pointerdown':
        this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        break;
      case 'pointermove':
        this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
        break;
      case 'pointerup': {
        const result = this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        // Confirmed tap (single pointer, short duration, small distance):
        // route to the registered tap-handler. The worker uses this to
        // hit-test the GalaxyMapLayer (since Pixi's event subsystem
        // isn't initialised without a DOM event source).
        if (result.wasTap && this.onTap) {
          this.onTap(e.offsetX, e.offsetY);
        }
        break;
      }
      case 'pointercancel':
      case 'pointerleave':
        this.camera.onPointerCancel(e.pointerId);
        break;
    }
  }

  /**
   * Register a confirmed-tap handler. Fired by `forwardPointerEvent`
   * when Camera resolves a tap (short, low-distance pointer cycle).
   * Coords passed in are the canvas-local pixel position of the tap
   * (DPR-scaled per `WorkerRendererClient.serialisePointer`).
   *
   * Worker-only — DOM-mode Pixi uses its native event system instead.
   */
  private onTap: ((screenX: number, screenY: number) => void) | null = null;
  setOnTap(handler: ((screenX: number, screenY: number) => void) | null): void {
    this.onTap = handler;
  }

  /**
   * Add a screen-space galaxy-map overlay to the stage and register a
   * tap handler. Convenience wrapper for the worker path: the worker
   * constructs the layer, hands it here, and supplies the
   * "what to do on tap" lambda (which posts OVERLAY_TAPPED back to
   * main thread).
   */
  addGalaxyOverlay(layer: Container, onTapInside: (screenX: number, screenY: number) => void): void {
    if (!this.initialized) return;
    this.app.stage.addChild(layer);
    this.setOnTap(onTapInside);
  }

  /** Worker-context wheel forwarding. */
  forwardWheelEvent(deltaY: number, offsetX: number, offsetY: number): void {
    this.camera.onWheel(deltaY, offsetX, offsetY);
  }

  /**
   * Install pointer/wheel/touch listeners on the canvas and forward
   * them into the Camera. Replaces pixi-viewport's automatic
   * `events: app.renderer.events` subscription. Touch hijacking is
   * suppressed via `{ passive: false }` + `preventDefault`.
   */
  private readonly canvasListeners: Array<{ type: string; handler: EventListener; options?: AddEventListenerOptions }> = [];
  private installCanvasEventListeners(canvas: HTMLCanvasElement): void {
    const onPointer = (e: PointerEvent): void => {
      const stamp = Date.now();
      switch (e.type) {
        case 'pointerdown':
          this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, stamp);
          break;
        case 'pointermove':
          this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
          break;
        case 'pointerup':
          this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, stamp);
          break;
        case 'pointercancel':
        case 'pointerleave':
          this.camera.onPointerCancel(e.pointerId);
          break;
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.camera.onWheel(e.deltaY, e.offsetX, e.offsetY);
    };
    const onTouchMove = (e: TouchEvent): void => {
      e.preventDefault();
    };
    const add = (type: string, handler: EventListener, options?: AddEventListenerOptions): void => {
      canvas.addEventListener(type, handler, options);
      this.canvasListeners.push({ type, handler, options });
    };
    add('pointerdown', onPointer as EventListener);
    add('pointermove', onPointer as EventListener);
    add('pointerup', onPointer as EventListener);
    add('pointercancel', onPointer as EventListener);
    add('pointerleave', onPointer as EventListener);
    add('wheel', onWheel as EventListener, { passive: false });
    add('touchmove', onTouchMove as EventListener, { passive: false });
  }

  update(mirror: RenderMirror): void {
    // F1 — bracket the whole update() for `rendererUpdateMs`. Single
    // exit point (the method has no early `return`), so a start-stamp +
    // tail-write is exact. Sub-µs, unconditional (markers-off baseline =
    // production cost). See `frameMarkers` / `FrameMarkers`.
    const updateStart = performance.now();
    const seen = new Set<string>();

    // Precompute the sets of entities hit by any active beam this frame —
    // remote (other shooters' beams) and local (any mount on the local
    // player's ship). Multi-mount/turret refactor (Phase 2c): both
    // `mirror.remoteLasers` and `mirror.liveBeams` are now per-mount, so we
    // flatten across all mounts to drive the damage-flash tint logic.
    const remoteHitTargets = new Set<string>();
    if (mirror.remoteLasers) {
      for (const perShooter of mirror.remoteLasers.values()) {
        for (const laser of perShooter.values()) {
          if (laser.targetId) remoteHitTargets.add(laser.targetId);
        }
      }
    }
    const localHitTargets = new Set<string>();
    if (mirror.liveBeams) {
      for (const beam of mirror.liveBeams.values()) {
        if (beam.hitId) localHitTargets.add(beam.hitId);
      }
    }

    for (const [playerId, ship] of mirror.ships) {
      seen.add(playerId);

      let sprite = this.sprites.get(playerId);
      if (!sprite) {
        // Sprite is built once per ship from the catalogue's polygon + colour.
        // Local-vs-remote is communicated by the camera-follow rather than a
        // colour override, so all three kinds stay visually distinct.
        sprite = buildShipGfxFromShape(shapeForKind(ship.kind));
        this.shipContainer.addChild(sprite);
        this.sprites.set(playerId, sprite);
      }
      // Multi-mount/turret refactor (Phase 3): attach turret sprites + aim
      // lines per mount in this ship's catalogue entry. Idempotent — re-uses
      // the existing cluster if `ship.kind` hasn't changed. Legacy single-
      // mount ships render an invisible 0-offset 0-baseAngle stub that sits
      // beneath the body silhouette.
      this.mountVisuals.ensureForShip(playerId, ship.kind, sprite);
      // Phase 4b.2: apply this ship's current mount-rotation angles. The
      // local player's `tickLocalMountAim` populated `mirror.ships
      // .get(localId).mountAngles` last tick; remote players leave it
      // undefined (until Phase 4b.3 ships the snapshot anchor) and the
      // helper falls back to baseAngle, i.e. static barrels.
      const shipKind = getShipKind(ship.kind ?? null);
      const shipMounts = shipKind.mounts ?? [];
      if (shipMounts.length > 0) {
        this.mountVisuals.applyMountAngles(playerId, shipMounts, ship.mountAngles);
      }

      sprite.x = ship.x;
      sprite.y = -ship.y;
      sprite.rotation = -ship.angle;

      // Damage flash takes priority; beam hit tint is secondary.
      if (mirror.damagedShips?.has(playerId)) {
        sprite.tint = DAMAGE_FLASH_COLOR;
      } else if (localHitTargets.has(playerId) || remoteHitTargets.has(playerId)) {
        sprite.tint = 0xff2222;
      } else {
        sprite.tint = 0xffffff;
      }

      // Thrust flame — baseline, shown for ANY acceleration. Child of the
      // ship sprite so it inherits rotation. Lazy-created on first thrust.
      // Added BEFORE the boost flame so the boost plume layers visually on top.
      const isThrusting = mirror.thrustingShips?.has(playerId) ?? false;
      let thrustFlame = this.thrustFlames.get(playerId);
      if (isThrusting) {
        if (!thrustFlame) {
          thrustFlame = buildThrustFlameGfx();
          sprite.addChild(thrustFlame);
          this.thrustFlames.set(playerId, thrustFlame);
        }
        thrustFlame.visible = true;
        // Per-frame flicker so the plume reads as fire, not a static arrow.
        thrustFlame.scale.y = 0.85 + Math.random() * 0.4;
        thrustFlame.alpha   = 0.75 + Math.random() * 0.25;
      } else if (thrustFlame) {
        thrustFlame.visible = false;
      }

      // Boost flame — layered ON TOP of thrust when both are active. Lazily
      // created on first boost; left as a hidden child afterwards so toggling
      // shift doesn't churn the scene graph.
      const isBoosting = mirror.boostingShips?.has(playerId) ?? false;
      let flame = this.boostFlames.get(playerId);
      if (isBoosting) {
        if (!flame) {
          flame = buildBoostFlameGfx();
          sprite.addChild(flame);
          this.boostFlames.set(playerId, flame);
        }
        flame.visible = true;
        // Slightly stronger flicker range than baseline thrust for "intensity".
        flame.scale.y = 0.9 + Math.random() * 0.5;
        flame.alpha   = 0.8 + Math.random() * 0.2;
      } else if (flame) {
        flame.visible = false;
      }
    }

    // Explosion sprites spawned this frame for destroyed ships.
    // 2026-05-13 — look up the targetId across ALL three sprite maps
    // (active ships by playerId, lingering hulls + wrecks by
    // shipInstanceId). Previously this only checked `this.sprites`
    // (active-only) and defaulted to (0,0) when a lingering hull or
    // wreck was destroyed — the user's "explosion appeared at zero
    // zero" bug. Helper is in `spriteUpdateDecisions.ts` and is
    // unit-tested there.
    if (mirror.explodingShips) {
      // Wrap the lingering-sprite cache to expose just the {x, y}
      // pose the helper expects. The cache value also carries `kind`
      // which the helper doesn't need.
      const lingeringPosesView = new Map<string, { x: number; y: number }>();
      for (const [id, entry] of this.lingeringSprites) {
        lingeringPosesView.set(id, { x: entry.sprite.x, y: entry.sprite.y });
      }
      for (const targetId of mirror.explodingShips) {
        const pose = decideExplosionPosition({
          targetId,
          activeShipsByPlayerId: this.sprites,
          lingeringShipsByShipInstanceId: lingeringPosesView,
          wrecksByShipInstanceId: this.wreckSprites,
        });
        if (!pose) continue; // ship not in any map — skip the VFX
        const expl = buildExplosionGfx();
        expl.x = pose.x;
        expl.y = pose.y;
        this.shipContainer.addChild(expl);
        this.explosionSprites.push({ gfx: expl, framesLeft: 30 });
      }
    }

    // Advance and remove expired explosion sprites.
    for (let i = this.explosionSprites.length - 1; i >= 0; i--) {
      const e = this.explosionSprites[i]!;
      e.framesLeft--;
      e.gfx.alpha = e.framesLeft / 30;
      e.gfx.scale.set(1 + (1 - e.framesLeft / 30) * 1.5);
      if (e.framesLeft <= 0) {
        this.shipContainer.removeChild(e.gfx);
        e.gfx.destroy();
        this.explosionSprites.splice(i, 1);
      }
    }

    // Phase 5c: swarm entities (asteroids + drones) — keyed by `swarm-${entityId}`
    // in the sprite map so they can't collide with playerIds. Sleeping entries
    // simply stop receiving pose updates; the sprite stays parked at the last
    // server-shipped pose (no client-side dead reckoning).
    if (mirror.swarm) {
      const now = performance.now();
      for (const [entityId, entry] of mirror.swarm) {
        const spriteKey = `swarm-${entityId}`;
        seen.add(spriteKey);
        let sprite = this.sprites.get(spriteKey);
        if (!sprite) {
          if (entry.kind === 1) {
            // Drones use the same procedural shape as player ships of that
            // kind, so a Heavy drone visibly reads as a Heavy. Falls back to
            // the legacy magenta dart silhouette when the wire didn't carry a
            // kind (older snapshots / pre-v2 packets).
            sprite = entry.shipKind
              ? buildShipGfxFromShape(shapeForKind(entry.shipKind))
              : buildDroneGfx(entry.radius);
          } else {
            sprite = buildAsteroidGfx(entityId, entry.radius);
          }
          this.shipContainer.addChild(sprite);
          this.sprites.set(spriteKey, sprite);
        }
        // DRONES (kind=1): read the SINGLE per-frame display pose that
        // `ColyseusClient.updateMirror` already resolved (one
        // `interpolateSwarmPose` per frame, written into `entry.x/y/angle`
        // — the same value the predWorld collision body + turret aim +
        // laser beam use). Re-interpolating here at render-`now` (which
        // differs from updateMirror's now by a variable, raf-jitter-
        // amplified amount — a whole frame under the 30 Hz worker gate)
        // made the sprite occupy a different pose than the collision
        // body/beam every frame: drones "jittered like two things
        // fighting" and the laser jittered against the sprite (on-device
        // 2026-05-19, capture jfagww; the drone-snapshot pivot's stated
        // "one pose per frame, every reader sees it" rule, now enforced).
        // ASTEROIDS (kind=0): keep render-now interpolation off the
        // poseRing — they are locked/static server-side, were never the
        // jitter complaint, and `syncSwarmIntoPredWorld` still poses their
        // bodies from the raw decoded `entry.x/y` (decoder unchanged).
        const lerped = entry.kind === 1
          ? resolveDroneDisplayPose(entry, this.swarmPoseScratch)
          : interpolateSwarmPose(entry, now, this.swarmPoseScratch);
        sprite.x = lerped.x;
        sprite.y = -lerped.y;
        sprite.rotation = -lerped.angle;
        if (entry.kind === 1 && entry.shipKind) {
          // Phase 4c (2026-05-11) — drones get the same mount cluster
          // treatment as player ships: turret sprites parented to the
          // drone body, rotated per-mount via `entry.mountAngles` (the
          // authoritative slim `snap.drones[]` slice). Legacy single-mount
          // drone kinds have zero-arc mounts so applyMountAngles is
          // essentially a no-op (rotation = -baseAngle); multi-mount kinds
          // (interceptor / gunship drones) visibly slew their wing/rear
          // turrets to track players.
          this.mountVisuals.ensureForShip(spriteKey, entry.shipKind, sprite);
          const swarmKind = getShipKind(entry.shipKind);
          const swarmMounts = swarmKind.mounts ?? [];
          if (swarmMounts.length > 0) {
            this.mountVisuals.applyMountAngles(spriteKey, swarmMounts, entry.mountAngles);
          }
        }
        // Damage flash takes priority over the active-beam hit tint so a
        // drone clearly registers a hit even when no beam is currently on it.
        if (mirror.damagedShips?.has(spriteKey)) {
          sprite.tint = DAMAGE_FLASH_COLOR;
        } else if (localHitTargets.has(spriteKey) || remoteHitTargets.has(spriteKey)) {
          sprite.tint = DAMAGE_FLASH_COLOR;
        } else {
          sprite.tint = 0xffffff;
        }
        // Sleeping entries stop interpolating; their pose is whatever the
        // server last shipped. (Mark visually muted in 5d if needed.)
      }
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.shipContainer.removeChild(sprite);
        // Boost flame and mount-visual cluster are children — destroy({
        // children: true }) frees them too, but we still drop the map
        // entries so a respawn rebuilds cleanly.
        this.mountVisuals.removeShip(id);
        sprite.destroy({ children: true });
        this.sprites.delete(id);
        this.boostFlames.delete(id);
        this.thrustFlames.delete(id);
      }
    }

    // Projectiles and ghost projectiles.
    if (mirror.projectiles) {
      const projSeen = new Set<string>();
      for (const [projId, proj] of mirror.projectiles) {
        projSeen.add(projId);
        let ps = this.projectileSprites.get(projId);
        if (!ps) {
          if (proj.beam) {
            const dx = proj.beam.toX - proj.x;
            const dy = -(proj.beam.toY - proj.y); // Y-flip for Pixi
            ps = buildBeamGfx(dx, dy);
          } else if (proj.weaponId === 'laser') {
            ps = buildLaserBoltGfx();
          } else {
            ps = buildProjectileGfx(proj.isGhost ?? false);
          }
          this.shipContainer.addChild(ps);
          this.projectileSprites.set(projId, ps);
        }
        ps.x = proj.x;
        ps.y = -proj.y;
        ps.alpha = proj.alpha ?? 1;
        // Rotate laser bolts to face their velocity heading.
        if (proj.weaponId === 'laser' && !proj.beam) {
          ps.rotation = -Math.atan2(proj.vy, proj.vx) + Math.PI / 2;
        }
      }
      for (const [projId, ps] of this.projectileSprites) {
        if (!projSeen.has(projId)) {
          this.shipContainer.removeChild(ps);
          ps.destroy();
          this.projectileSprites.delete(projId);
        }
      }
    }

    // Server ghost: orange diamond showing where the server's last snapshot
    // put the ship, before any client-side prediction replay.
    // `showServerGhost` defaults to true when undefined so older mirrors and
    // the LocalGameClient diagnostic surface keep working.
    const ghostEnabled = mirror.showServerGhost !== false;
    if (ghostEnabled && mirror.serverGhostPos) {
      if (!this.serverGhost) {
        this.serverGhost = buildGhostGfx();
        this.shipContainer.addChild(this.serverGhost);
      }
      this.serverGhost.visible = true;
      this.serverGhost.x = mirror.serverGhostPos.x;
      this.serverGhost.y = -mirror.serverGhostPos.y;
    } else if (this.serverGhost) {
      this.serverGhost.visible = false;
    }

    // Remote beams from other players — orange, continuously tracking shooter rotation.
    // Uses shooter's current angle from mirror.ships so the beam sweeps smoothly between
    // server-acked shot events (every ~167ms).
    //
    // Multi-mount/turret refactor (Phase 2c): `mirror.remoteLasers` is now
    // `Map<shooterId, Map<mountId, laser>>`. We iterate the nested map and
    // resolve each mount's local offset from the shooter's ship-kind catalogue
    // entry, so multi-mount ships emit beams from the correct barrel positions
    // (not all stacked at the ship centre). Legacy single-mount ships have
    // mount.localX/Y = (0, 0) and baseAngle = 0, so the geometry collapses to
    // the pre-refactor "ship.pos + 20 u forward" path.
    if (mirror.remoteLasers && mirror.remoteLasers.size > 0) {
      if (!this.remoteBeamGfx) {
        this.remoteBeamGfx = new Graphics();
        this.shipContainer.addChild(this.remoteBeamGfx);
      }
      this.remoteBeamGfx.clear();
      const now = performance.now();
      for (const [shooterId, perShooter] of mirror.remoteLasers) {
        // Player shooters track their live ship pose; the beam sweeps with the
        // ship's rotation between fire events. AI shooters track their
        // mirror.swarm pose for the same reason — drones move every tick, so
        // a wire-frozen beam origin would re-anchor on each fire (visible
        // jump). Falls back to the wire endpoints if the shooter isn't found
        // (defensive — e.g. ID mapping mismatch).
        const shooter = mirror.ships.get(shooterId);
        let swarmShooter: { x: number; y: number; angle: number; radius: number; shipKind?: string } | null = null;
        if (!shooter && shooterId.startsWith('swarm-')) {
          const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
          if (!Number.isNaN(entityId)) {
            const sw = mirror.swarm?.get(entityId);
            if (sw) {
              // Use the SAME pose the sprite is drawn at — drones (kind=1)
              // render from `entry.x/y/angle` directly post-2026-05-09 reset
              // (predWorld pose synced into the mirror each frame). Asteroids
              // stay on the lerp path for parity with their sprite render.
              if (sw.kind === 1) {
                swarmShooter = { x: sw.x, y: sw.y, angle: sw.angle, radius: sw.radius, shipKind: sw.shipKind };
              } else {
                const lerped = interpolateSwarmPose(sw, now, this.swarmPoseScratch);
                swarmShooter = { x: lerped.x, y: lerped.y, angle: lerped.angle, radius: sw.radius, shipKind: sw.shipKind };
              }
            }
          }
        }

        const shooterKindId = shooter?.kind ?? swarmShooter?.shipKind ?? null;
        const shooterKind = getShipKind(shooterKindId);

        for (const [mountId, laser] of perShooter) {
          // Hold full brightness while shooter is actively firing; fade only
          // in the last 150 ms of TTL (i.e. after they stop shooting). With
          // WEAPON_COOLDOWN = 167 ms and TTL = 400 ms, each new shot resets
          // expiresAt well before the fade window, so the beam is solid-on
          // while space is held.
          const ttlRemaining = laser.expiresAt - now;
          const alpha = ttlRemaining > 150 ? 1.0 : Math.max(0, ttlRemaining / 150);

          // Resolve the mount's ship-local offset from the catalogue. Falls
          // back to a zero-offset zero-baseAngle stub for unknown mount ids
          // so a pre-2c server (no mountId in the wire) still renders.
          // Phase 4b.2: pick up the shooter's per-mount slewed angle from
          // `mirror.ships.get(id).mountAngles` (player shooters); Phase 4c
          // adds the same for drone shooters via `mirror.swarm.get(id).
          // mountAngles` (snapshot-anchored, in-interest drones only).
          const mount = shooterKind.mounts?.find((m) => m.id === mountId);
          const mountIdx = shooterKind.mounts?.findIndex((m) => m.id === mountId) ?? -1;
          let currentMountAngle = 0;
          if (shooter && mount && mountIdx >= 0) {
            currentMountAngle = shooter.mountAngles?.[mountIdx] ?? 0;
          } else if (swarmShooter && mount && mountIdx >= 0) {
            // Pull the drone's per-mount angle out of the swarm mirror —
            // ColyseusClient writes it from `snap.drones[].mountAngles`
            // when the drone is in-interest. Out-of-interest → undefined
            // → currentMountAngle stays 0 (barrel at baseAngle, no rotation).
            const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
            if (!Number.isNaN(entityId)) {
              const sw = mirror.swarm?.get(entityId);
              currentMountAngle = sw?.mountAngles?.[mountIdx] ?? 0;
            }
          }

          let fromX: number;
          let fromY: number;
          let toX: number;
          let toY: number;
          if (shooter) {
            const origin = applyMountOffset(shooter.x, shooter.y, shooter.angle, mount);
            const fireAngle = shooter.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
            const fwdX = -Math.sin(fireAngle);
            const fwdY =  Math.cos(fireAngle);
            fromX = origin.x + fwdX * 20;
            fromY = origin.y + fwdY * 20;
            toX = fromX + fwdX * laser.range;
            toY = fromY + fwdY * laser.range;
          } else if (swarmShooter) {
            const origin = applyMountOffset(swarmShooter.x, swarmShooter.y, swarmShooter.angle, mount);
            const fireAngle = swarmShooter.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
            const fwdX = -Math.sin(fireAngle);
            const fwdY =  Math.cos(fireAngle);
            // Drone barrel offset is `radius + 2` along the mount's fire
            // direction (no mount → centre of drone). Matches the
            // pre-refactor visual where the beam clears the drone hull.
            const barrelOffset = mount ? 20 : swarmShooter.radius + 2;
            fromX = origin.x + fwdX * barrelOffset;
            fromY = origin.y + fwdY * barrelOffset;
            toX = fromX + fwdX * laser.range;
            toY = fromY + fwdY * laser.range;
          } else {
            fromX = laser.fromX;
            fromY = laser.fromY;
            toX = laser.toX;
            toY = laser.toY;
          }
          // Outer glow
          this.remoteBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
          this.remoteBeamGfx.stroke({ color: REMOTE_LASER_COLOR, width: 3, alpha: alpha * 0.4 });
          // Bright core
          this.remoteBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
          this.remoteBeamGfx.stroke({ color: 0xffaa44, width: 1, alpha });
        }
      }
      this.remoteBeamGfx.visible = true;
    } else if (this.remoteBeamGfx) {
      this.remoteBeamGfx.visible = false;
    }

    // Live hitscan beams — one per mount in the local ship's active slot.
    // Derive geometry from the local ship's lerped pose in mirror.ships each
    // frame so beams stay glued to the ship sprite even during a server-
    // correction lerp. (Mirrors the remote-beam pattern above — single source
    // of truth: "where the ship is visually right now".)
    //
    // Multi-mount/turret refactor (Phase 2c): `mirror.liveBeams` is now a
    // per-mount map. Legacy single-mount fighter/scout/heavy has exactly one
    // entry keyed by `'forward'`; multi-mount kinds (Phase 3) get one entry
    // per barrel and each draws independently.
    const localShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : null;
    if (mirror.liveBeams && mirror.liveBeams.size > 0 && localShip) {
      if (!this.liveBeamGfx) {
        this.liveBeamGfx = new Graphics();
        this.shipContainer.addChild(this.liveBeamGfx);
      }
      this.liveBeamGfx.clear();
      const localKind = getShipKind(localShip.kind ?? null);
      const localMounts = localKind.mounts ?? [];
      for (const [mountId, beam] of mirror.liveBeams) {
        const mountIdx = localMounts.findIndex((m) => m.id === mountId);
        const mount = mountIdx >= 0 ? localMounts[mountIdx] : undefined;
        // Phase 4b.2: add the per-mount slewed angle so the beam emerges
        // in the same direction as the visibly-rotated barrel sprite.
        const currentMountAngle = mountIdx >= 0 ? (localShip.mountAngles?.[mountIdx] ?? 0) : 0;
        const origin = applyMountOffset(localShip.x, localShip.y, localShip.angle, mount);
        const fireAngle = localShip.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
        const fwdX = -Math.sin(fireAngle);
        const fwdY =  Math.cos(fireAngle);
        const fromX = origin.x + fwdX * 20;
        const fromY = origin.y + fwdY * 20;
        const toX = fromX + fwdX * beam.dist;
        const toY = fromY + fwdY * beam.dist;
        // Outer glow
        this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.liveBeamGfx.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
        // Bright core
        this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.liveBeamGfx.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
      }
      this.liveBeamGfx.visible = true;
    } else {
      if (this.liveBeamGfx) this.liveBeamGfx.visible = false;
    }

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    if (local) {
      // `follow` (not `moveCenter`) — the camera's per-tick interpolator
      // applies this target every Pixi frame (60 Hz), independent of
      // `update()` cadence. With `followLerpFactor: 1` the follow is
      // instant — matches the original every-frame `moveCenter` feel
      // but runs at ticker speed not MIRROR_UPDATE speed. See Camera
      // construction in init() for the rationale.
      this.camera.follow({ x: local.x, y: local.y });
    }

    // Background layers — run AFTER moveCenter so they use this frame's
    // camera position (otherwise stars and grid lag by one frame).
    this.starfield?.update(this.camera);
    this.backgroundGrid?.update(this.camera);

    // Drain pending damage numbers and spawn floating text. update()
    // must be OUTSIDE the spawn-drain block — sub-managers need to
    // tick every frame to advance lifetime + counter-scale.
    if (this.damageNumbers && mirror.pendingDamageNumbers) {
      for (const dn of mirror.pendingDamageNumbers) {
        this.damageNumbers.spawn(dn.x, dn.y, dn.damage, dn.tag);
      }
      mirror.pendingDamageNumbers.length = 0;
    }
    // weapon-hit-prediction Phase 2 — hard-cancel mispredicted / TTL-expired
    // predicted numbers by tag. Drained AFTER the spawn pass (a predict +
    // rollback in the same frame nets to nothing) and BEFORE update() (a
    // cancelled number gets zero frames of life).
    if (this.damageNumbers && mirror.pendingDamageNumberCancels) {
      for (const tag of mirror.pendingDamageNumberCancels) {
        this.damageNumbers.cancelByTag(tag);
      }
      mirror.pendingDamageNumberCancels.length = 0;
    }
    this.damageNumbers?.update();

    if (this.healthBars && mirror.pendingHealthBarHits) {
      for (const hb of mirror.pendingHealthBarHits) {
        this.healthBars.onHit(hb.entityId, hb.healthPct);
      }
      mirror.pendingHealthBarHits.length = 0;
    }
    this.healthBars?.update(mirror);

    // Drain remote-warp events (warp_in / warp_out broadcasts from the
    // server). Each entry fires the same direction-agnostic one-shot
    // flash + burst ripple at the world point so observers see where
    // the remote ship arrived / departed. Local-player warps are never
    // here (server filters with `except: client`).
    //
    // Render-jitter-fix Phase 1b (2026-05-21) — only fire ONE warp
    // visual per RAF, AND only when a burst is not already in flight.
    // Each `triggerWarpIn` attaches the warp filter chain (shockwave +
    // bloom + zoom-blur) to `app.stage.filters` and resets
    // `warpBurstStartedAt`. The 1.5 s burst duration only tears those
    // filters down via `shouldDetachWarpVisual` IF `warpBurstStartedAt`
    // ages past `burstDurationMs`. Without this guard, Living World
    // bot migrations push 1-2 warp events per second; each restarts
    // the burst timer; filters stay attached indefinitely; GPU runs
    // the multi-pass filter chain every frame → frame rate collapses
    // (the late-onset spiral pattern in captures `af742v` / `ecat41`).
    if (mirror.pendingWarpEvents && mirror.pendingWarpEvents.length > 0) {
      const burstInFlight = this.warpBurstStartedAt > 0;
      if (!burstInFlight) {
        // Fire ONLY the first queued event this frame. Subsequent
        // events get visually skipped — at 1-2 warps/sec from drones
        // plus a 1.5 s burst window, the visible duty cycle is close
        // to 100 % anyway, so dropping 1-2 visuals is invisible to the
        // player but bounds GPU cost.
        const first = mirror.pendingWarpEvents[0]!;
        this.triggerWarpIn({ kind: 'world', worldX: first.x, worldY: first.y });
      }
      mirror.pendingWarpEvents.length = 0;
    }

    // Phase 1 — name labels above remote ships and drones (skip self).
    this.labels?.update(mirror);

    // Phase 4 — render / update / sweep wrecks. Wrecks are drawn with
    // the ship-kind silhouette desaturated and slightly transparent to
    // sell "broken hull, no pilot". No mount aim lines, no name label,
    // no exhaust. Y-flip matches the rest of the renderer.
    this.updateWrecks(mirror);
    this.updateLingeringShips(mirror);

    // Halo arrows for off-screen POIs. Runs after moveCenter so the visibility
    // test uses this frame's viewport bounds, not last frame's.
    this.halo.update(mirror);

    // ---------- RendererFeedback (end-of-frame, main-thread readable) ----------
    // Populate the feedback struct that main reads after update() returns.
    // Today this is sync-mutate (renderer and main share a process).
    // Phase 4 of the worker migration will replace this with a FEEDBACK
    // postMessage from the renderer worker; the contract surface stays
    // the same (caller does `renderer.getFeedback()`).
    this.feedback.mountCounts.clear();
    for (const shipId of mirror.ships.keys()) {
      const count = this.mountVisuals.mountCountForShip(shipId);
      if (count > 0) this.feedback.mountCounts.set(shipId, count);
    }
    this.feedback.haloArrowCount = this.halo.getDebugVisibleArrowCount();
    this.feedback.damageNumberActiveCount = this.damageNumbers?.getActiveCount() ?? 0;
    this.feedback.wreckSpriteCount = this.wreckSprites.size;
    // Join-render readiness signal: latch true once we've painted at
    // least one frame that includes the LOCAL player's mirror entry
    // (not just any ship). The main thread reads this via
    // `getFeedback()`, fires the `pixi_first_frame` diagnostic, and
    // drives `gameReady`/`<WarpScreen>` off it. Requiring `mirror.
    // ships.has(localPlayerId)` (not just `size > 0`) is what makes
    // this a true "the player can see themselves" signal — strict
    // enough that idle sectors with only remote ships visible don't
    // flip the gate early.
    if (!this.feedback.firstFrameRendered
        && mirror.localPlayerId !== null
        && mirror.ships.has(mirror.localPlayerId)) {
      this.feedback.firstFrameRendered = true;
    }

    // ---------- F1 frame markers (end-of-frame, worker→main diag) ----------
    // Fold in the grid label-churn split that `BackgroundGrid.update()`
    // recorded earlier this frame (called at ~L1310 via
    // `this.backgroundGrid?.update(this.camera)`). `warpTickMs` /
    // `filterCount` are written by the separate `tickWarpShockwaves`
    // ticker callback. `rendererUpdateMs` closes the bracket opened at
    // method entry. The worker posts these only when diagnostics are on.
    const grid = this.backgroundGrid?.lastFrameMarkers;
    if (grid) {
      this.frameMarkers.gridLabelSpecMs = grid.labelSpecMs;
      this.frameMarkers.gridTextCreateMs = grid.textCreateMs;
      this.frameMarkers.gridCleanupMs = grid.cleanupMs;
      this.frameMarkers.gridLabelCount = grid.labelCount;
    } else {
      this.frameMarkers.gridLabelSpecMs = 0;
      this.frameMarkers.gridTextCreateMs = 0;
      this.frameMarkers.gridCleanupMs = 0;
      this.frameMarkers.gridLabelCount = 0;
    }
    this.frameMarkers.spriteCount = this.sprites.size;
    this.frameMarkers.rendererUpdateMs = performance.now() - updateStart;
  }

  /** Phase 6b — parallel to `updateWrecks`. Lingering hulls (players who
   *  disconnected within the 15-min linger window OR whose ships have
   *  been displaced from `playerToSlot` by a fresh spawn) are drawn with
   *  the SAME silhouette + colour as the live ship (NOT the desaturated
   *  wreck tint — they still belong to a real player), with a slight
   *  alpha drop (0.75) as a visual cue for "this hull is parked, the
   *  pilot isn't currently flying it".
   *
   *  Phase A3: the create-vs-rebuild-vs-reposition decision is delegated
   *  to `decideLingeringSpriteAction` (pure, unit-tested). The previous
   *  inline version's `if (!ship.kind) continue` skip left lingering
   *  hulls permanently invisible when the schema diff was late; the
   *  extracted helper makes the fallback-kind behaviour an explicit
   *  contract and prevents regression. */
  private readonly lingeringSprites = new Map<string, { sprite: Container; kind: string }>();
  private updateLingeringShips(mirror: RenderMirror): void {
    if (!mirror.lingeringShips || mirror.lingeringShips.size === 0) {
      if (this.lingeringSprites.size > 0) {
        for (const entry of this.lingeringSprites.values()) entry.sprite.destroy();
        this.lingeringSprites.clear();
      }
      return;
    }
    const seen = new Set<string>();
    for (const [shipInstanceId, ship] of mirror.lingeringShips) {
      seen.add(shipInstanceId);
      const decision = decideLingeringSpriteAction({
        cached: this.lingeringSprites.get(shipInstanceId),
        currentKind: ship.kind,
        fallbackKind: 'fighter',
      });
      let entry = this.lingeringSprites.get(shipInstanceId);
      if (decision.action === 'rebuild') {
        entry!.sprite.destroy();
        this.lingeringSprites.delete(shipInstanceId);
        entry = undefined;
      }
      if (decision.action === 'create' || decision.action === 'rebuild') {
        const shape = shapeForKind(decision.kind);
        const sprite = buildShipGfxFromShape(shape, shape.color);
        sprite.alpha = 0.75;
        this.shipContainer.addChild(sprite);
        entry = { sprite, kind: decision.kind };
        this.lingeringSprites.set(shipInstanceId, entry);
      }
      // 'skip' is reserved for wreck-kind-missing diagnostics; not
      // produced by the lingering decision today. Be defensive anyway.
      if (decision.action === 'skip' || !entry) continue;
      entry.sprite.x = ship.x;
      entry.sprite.y = -ship.y;
      entry.sprite.rotation = -ship.angle;
    }
    for (const [id, entry] of this.lingeringSprites) {
      if (!seen.has(id)) {
        entry.sprite.destroy();
        this.lingeringSprites.delete(id);
      }
    }
  }

  private updateWrecks(mirror: RenderMirror): void {
    if (!mirror.wrecks) {
      for (const g of this.wreckSprites.values()) g.destroy();
      this.wreckSprites.clear();
      return;
    }
    const seen = new Set<string>();
    for (const [shipInstanceId, w] of mirror.wrecks) {
      seen.add(shipInstanceId);
      let sprite = this.wreckSprites.get(shipInstanceId);
      if (!sprite) {
        const shape = shapeForKind(w.kind);
        sprite = buildShipGfxFromShape(shape, desaturate(shape.color));
        sprite.alpha = 0.55;
        this.shipContainer.addChild(sprite);
        this.wreckSprites.set(shipInstanceId, sprite);
      }
      sprite.x = w.x;
      sprite.y = -w.y;
      sprite.rotation = -w.angle;

      // Phase 4 — wreck visual feedback when taking damage. The
      // damage-flash machinery is keyed by the wire targetId (which is
      // `wreck-${shipInstanceId}` for wrecks); `mirror.damagedShips`
      // gets that id from handleDamage so we can flash here too.
      const wreckEntityId = `wreck-${shipInstanceId}`;
      const flashing = mirror.damagedShips?.has(wreckEntityId) ?? false;
      sprite.tint = flashing ? DAMAGE_FLASH_COLOR : 0xffffff;
    }
    for (const [id, sprite] of this.wreckSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.wreckSprites.delete(id);
      }
    }
  }

  /**
   * Attach a screen-space overlay container to the stage, **above** the
   * viewport. Used by the in-game galaxy-map overlay (Map B): the consumer
   * constructs a `GalaxyMapLayer` (a Pixi `Container`) and hands it here.
   * Layered above `viewport` so it doesn't pan/zoom with the world camera.
   */
  addOverlayContainer(overlay: unknown): void {
    if (!this.initialized) return;
    this.app.stage.addChild(overlay as Container);
  }

  /**
   * Cap the Pixi ticker. Three modes:
   *   - `undefined` → remove any cap (Pixi default — uncapped vsync).
   *   - `number` (e.g. 30) → throttle to that max FPS.
   *   - `null` → **pause the ticker entirely** (no callbacks fire).
   *
   * Used by `GameSurface` to manage CPU contention while the
   * AdvancedDrawer / GalaxyOverviewScreen is open:
   *   - For real users: throttle to 30 fps so the gameplay underneath
   *     the drawer remains visible/animated. Drawer is partial-width;
   *     the canvas is still on-screen.
   *   - Under Playwright automation (`navigator.webdriver === true`):
   *     pause entirely. CDP roundtrip otherwise climbs to ~500 ms
   *     median (measured 2026-05-14 via
   *     `tests/e2e/drawer-cdp-starvation-probe.spec.ts`), which makes
   *     interactive drawer specs flake at the boundary of 120 s test
   *     budgets. Pausing frees the main thread entirely; gameplay
   *     state still updates via the React rAF loop / Colyseus apply,
   *     just the Pixi draw is suspended. Invisible to a focused user;
   *     test-only behavior.
   *
   * See `docs/LESSONS.md` 2026-05-13 §6 carry-forward.
   */
  setTickerMaxFPS(fps: number | null | undefined): void {
    if (!this.initialized) return;
    if (fps === null) {
      this.app.ticker.stop();
      return;
    }
    if (!this.app.ticker.started) this.app.ticker.start();
    this.app.ticker.maxFPS = fps ?? 0;
  }

  /**
   * Toggle warp-mode render state. See `IRenderer.setWarpMode`.
   *
   * On `active === true`: lazily build a stack of `ShockwaveFilter`
   * instances and attach to `app.stage`. Records `warpStartedAt` so
   * the per-frame tick can ramp amplitude from `amplitudeMin` →
   * `amplitudeMax` over `warpParams.rampMs`. Snaps `warpIntensity` to
   * 1 (the fade-out scalar).
   *
   * On `active === false`: starts the fade-out — `warpIntensity` ramps
   * to 0 over `warpParams.fadeOutMs`, scaling every filter's amplitude
   * down in lockstep. When intensity hits 0, filters are detached and
   * the warp stage hidden (kept around for re-entry).
   *
   * Cheap re-entry: subsequent `setWarpMode(true)` calls reuse the
   * same `ShockwaveFilter` instances.
   */
  setWarpMode(active: boolean): void {
    if (!this.initialized) return;
    this.warpActive = active;
    if (active) {
      this.ensureWarpStage();
      this.warpIntensity = 1;
      this.warpFadeStartedAt = 0;
      const now = performance.now();
      this.warpStartedAt = now;
      this.warpPhaseStartedAt = now;
      this.warpPhase = 'spool';
      if (this.warpStage) this.warpStage.visible = true;
      this.attachWarpFilters();
    } else if (this.warpFadeStartedAt === 0 && this.warpStage) {
      this.warpFadeStartedAt = performance.now();
      // Spool-exit: fade the filter chain out ONLY — no burst here.
      // Post Phase-G the load curtain is already raised by this point
      // (re-arm at `transit_ready` → !gameReady → loading=true before
      // SPOOLING→IN_TRANSIT), so the old "climax" burst was an
      // occluded, curtain-bleeding second flash on every inter-sector
      // transit (on-device 2026-05-16, user smoke test). The single
      // warp flash is the arrival reveal in `triggerWarpIn`. Gated via
      // the `warpEventFiresBurst` policy so a future re-introduction
      // trips `PixiRenderer.warpBurst.test.ts`.
      if (warpEventFiresBurst('warp-mode-off')) this.fireBurst();
    }
  }

  /**
   * Fire the "warp-in" companion effect — a flash + single big ripple
   * at the supplied centre. No preceding spool/climax. Used when a
   * ship arrives at a sector (the receiving end of a warp).
   */
  triggerWarpIn(center: WarpCenter | null): void {
    if (!this.initialized) return;
    this.ensureWarpStage();
    if (center !== null) this.warpCenter = center;
    if (this.warpStage) this.warpStage.visible = true;
    // Re-attach filters if they're not currently attached. The curtain
    // (a Graphics on warpStage) does NOT require filters, so warpStage
    // being visible alone isn't a guarantee that filters are live — we
    // check `app.stage.filters` directly. Mark standalone so the tick
    // tears the filter chain down again after the burst completes.
    const filtersAttached = Array.isArray(this.app.stage.filters)
      && (this.app.stage.filters as unknown[]).length > 0;
    if (!filtersAttached) {
      this.warpStandaloneBurst = true;
      this.attachWarpFilters();
    }
    // The single visible warp flash per inter-sector transit — the
    // arrival reveal. Always fires; routed through the policy so the
    // burst's one legitimate trigger is the documented, locked path.
    if (warpEventFiresBurst('warp-in')) this.fireBurst();
  }

  /** Internal: trigger the burst ShockwaveFilter pulse + flash overlay.
   *  Called from `setWarpMode(false)` (exit moment) AND
   *  `triggerWarpIn` (arrival). The tick animates the decay. */
  private fireBurst(): void {
    if (!this.warpBurst) return;
    this.warpBurstStartedAt = performance.now();
    this.warpBurst.time = 0;
  }

  /**
   * Live-tune warp params. Sandbox-only — production code calls
   * `setWarpMode` with the defaults baked into `DEFAULT_WARP_PARAMS`.
   * Mutates `this.warpParams`. The per-frame tick reads from
   * `warpParams` and rebuilds the filter array on phase transitions
   * (spool↔climax) so changing `spoolCount` / `spoolRadius` during
   * spool, or vice versa, takes effect on the next phase entry.
   */
  setWarpParams(partial: Partial<WarpParams>): void {
    Object.assign(this.warpParams, partial);
    // Clamp count so a slider going weird can't crash the renderer.
    this.warpParams.spoolCount = Math.max(1, Math.min(8, Math.floor(this.warpParams.spoolCount)));
  }

  /**
   * Set an anchor for the warp centre. World-space anchors are
   * projected to screen via `world.toGlobal` each frame so the ripple
   * stays glued to the world point as the camera moves; screen-space
   * anchors are used as-is. Pass `null` to revert to screen-centre.
   */
  setWarpCenter(center: WarpCenter | null): void {
    this.warpCenter = center;
  }

  /**
   * Show or hide the load curtain — an opaque dark overlay on
   * `warpStage` that hides the canvas during the join + transit load
   * periods. Independent of the warp filter chain: the curtain can be
   * up while filters are detached (initial join, no spool/climax) and
   * while filters are attached (transit hand-off, where the curtain
   * rises right as the burst+flash peaks). Tween durations are
   * asymmetric (200 ms rise, 380 ms fade) so the fade aligns with the
   * arrival flash for a single perceived pulse.
   */
  setLoadCurtain(active: boolean): void {
    if (!this.initialized) return;
    this.ensureWarpStage();
    const target = active ? CURTAIN_PEAK_ALPHA : 0;
    if (target === this.loadCurtainTargetAlpha) return;
    this.loadCurtainTargetAlpha = target;
    this.loadCurtainTweenFromAlpha = this.loadCurtain?.alpha ?? 0;
    this.loadCurtainTweenStartedAt = performance.now();
  }

  /**
   * Move the camera so the given world point sits at screen centre.
   * Used by the visual-effects sandbox to anchor world (0, 0) without
   * needing a local-player ship to follow. Production code uses the
   * `Camera.follow` path against the local ship instead.
   */
  setCameraCenter(worldX: number, worldY: number): void {
    if (!this.initialized) return;
    this.camera.moveCenter(worldX, worldY);
  }

  /** Lazy-construct the warp surface. Idempotent — subsequent calls
   *  return immediately if already built. Built lazily so renderers
   *  that never enter warp mode don't pay the construction cost. */
  private ensureWarpStage(): void {
    if (this.warpStage) return;
    this.warpStage = new Container();
    this.warpStage.eventMode = 'none';
    this.app.stage.addChild(this.warpStage);

    // Filter chain applied to `this.world` (NOT `app.stage`) so the
    // flash overlay on `warpStage` stays UNFILTERED — the flash needs
    // to be a clean white pulse, not rippled by the shockwaves.
    //   - `ShockwaveFilter` × `count` (concentric expanding rings — spool/climax)
    //   - `warpBurst` (one-shot burst ripple at exit / arrival)
    //   - `ZoomBlurFilter` (radial motion blur from the same centre)
    // The shockwave stack is rebuilt at each spool↔climax phase
    // transition; burst + zoom blur are single instances with per-frame
    // uniforms.
    this.warpShockwaves = this.buildShockwaveStack(this.warpParams.spoolCount, this.warpParams.spoolRadius);
    this.warpStackCount = this.warpParams.spoolCount;
    this.warpStackRadius = this.warpParams.spoolRadius;
    this.warpZoomBlur = new ZoomBlurFilter({
      strength: 0,
      center: { x: this.camera.screenWidth * 0.5, y: this.camera.screenHeight * 0.5 },
      innerRadius: this.warpParams.zoomBlurInnerRadius,
      radius: -1,
    });
    this.warpBurst = new ShockwaveFilter({
      center: { x: this.camera.screenWidth * 0.5, y: this.camera.screenHeight * 0.5 },
      speed: this.warpParams.burstSpeed,
      amplitude: 0,
      wavelength: this.warpParams.burstWavelength,
      brightness: 1,
      radius: -1,
      time: 0,
    });
    // `quality: 2` and `kernelSize: 5` keep the multi-pass blur cheap
    // enough for mobile — we only need a soft glow, not film-grade
    // bloom. Strength is modulated per frame in the tick.
    this.warpBloom = new BloomFilter({
      strength: 0,
      quality: 2,
      kernelSize: 5,
    });
    // Load-curtain overlay — full-canvas dark rect that hides the
    // canvas during the join / transit load period. Added BEFORE the
    // flash so the flash renders ON TOP of the curtain (the arrival
    // reveal: flash spikes white at the moment the curtain fades).
    // Colour matches BACKGROUND_COLOR so the cinch transition feels
    // continuous with the empty stage.
    this.loadCurtain = new Graphics();
    this.loadCurtain.rect(-2048, -2048, 8192, 8192);
    this.loadCurtain.fill({ color: BACKGROUND_COLOR, alpha: 1 });
    this.loadCurtain.alpha = 0;
    this.warpStage.addChild(this.loadCurtain);

    // Flash overlay — full-canvas white rect on `warpStage` (above
    // world, no filter chain). Sized generous so it covers any
    // reasonable resize without re-drawing each frame.
    this.warpFlash = new Graphics();
    this.warpFlash.rect(-2048, -2048, 8192, 8192);
    this.warpFlash.fill({ color: 0xffffff, alpha: 1 });
    this.warpFlash.alpha = 0;
    this.warpStage.addChild(this.warpFlash);
    this.app.ticker.add(this.tickWarpShockwaves);
  }

  /** Construct a fresh array of `count` ShockwaveFilters centred on
   *  screen (centre is updated per-frame in the tick). Per-frame
   *  uniforms (time, amplitude, brightness) are set by the tick; this
   *  just provides the initial shape and `radius` (which can't be
   *  changed without a fresh filter on Pixi v8 in practice). */
  private buildShockwaveStack(count: number, radius: number): ShockwaveFilter[] {
    const { speed, wavelength } = this.warpParams;
    const cx = this.camera.screenWidth * 0.5;
    const cy = this.camera.screenHeight * 0.5;
    const filters: ShockwaveFilter[] = [];
    for (let i = 0; i < count; i++) {
      filters.push(new ShockwaveFilter({
        center: { x: cx, y: cy },
        speed,
        amplitude: 0,
        wavelength,
        brightness: 1,
        radius,
        time: 0,
      }));
    }
    return filters;
  }

  /** Attach the current filter stack to `app.stage` so EVERY visible
   *  layer ripples — starfield (attached to `app.stage` directly),
   *  world (grid + ships), and the flash overlay all pass through the
   *  chain. The flash being slightly rippled is acceptable: it's solid
   *  white, so bending it is invisible, and bloom passing over it just
   *  amplifies the pulse. Without this the shockwave only bends the
   *  sparse grid lines and is barely perceptible — the starfield is
   *  what makes the ripple legible.
   *
   *  Order: shockwaves (ripple) → burst (extra ripple) → zoom blur
   *  (radial smear) → bloom (glow on the rippled, blurred bright
   *  wavefronts). Bloom last so it amplifies the final composited image. */
  private attachWarpFilters(): void {
    if (!this.warpShockwaves || !this.warpZoomBlur || !this.warpBurst || !this.warpBloom) return;
    // Render-jitter-fix Phase 1b (2026-05-21) — warp filter chain
    // DISABLED. Captures `wivf9n` (filters on, throttled) and
    // `q4wtht` (filters off) both spiraled, definitively ruling out
    // filters as the cause. Capture `d3cprl` (filters off, phone at
    // steady 60Hz battery-saver) was smooth, confirming filters are
    // not load-bearing for playability. The shockwave + bloom + zoom-
    // blur chain is a visual nice-to-have, not core gameplay; keeping
    // them off avoids any duty-cycle cost on mobile. Re-enable by
    // uncommenting the assignment below.
    // this.app.stage.filters = [...this.warpShockwaves, this.warpBurst, this.warpZoomBlur, this.warpBloom];
  }

  /**
   * F1 bracket wrapper for the warp tick. `runWarpShockwavesTick` has
   * six early `return`s (all "warp inactive / nothing to do" paths), so
   * a single tail-stamp inside it would miss most frames. Wrapping the
   * call brackets EVERY path exactly. This is a pure extraction — the
   * body is verbatim the old `tickWarpShockwaves`, behaviour unchanged.
   * `filterCount` is read AFTER the tick so it reflects any in-tick
   * stack rebuild (`buildShockwaveStack` on a phase change). Sub-µs,
   * unconditional (markers-off baseline = production cost).
   */
  private tickWarpShockwaves = (): void => {
    const warpStart = performance.now();
    this.runWarpShockwavesTick();
    this.frameMarkers.warpTickMs = performance.now() - warpStart;
    this.frameMarkers.filterCount = this.warpShockwaves?.length ?? 0;
    // Render-jitter-fix Phase 1b — surface the filter-attach state into
    // the capture stream so a stuck-attached filter chain is visible
    // (the bot-warp queue drain bug, fixed in the same plan).
    this.frameMarkers.warpFiltersAttached = Array.isArray(this.app.stage.filters)
      && (this.app.stage.filters as unknown[]).length > 0;
    this.frameMarkers.warpBurstAgeMs = this.warpBurstStartedAt > 0
      ? Math.round(performance.now() - this.warpBurstStartedAt)
      : -1;
  };

  /** Per-frame warp tick — two-phase envelope (spool → climax), fade-out
   *  tween, burst + flash decay, centre projection from world space.
   *  Also drives the load-curtain alpha tween (which is independent of
   *  the warp filter envelope — runs every frame as long as the stage
   *  has been built). */
  private runWarpShockwavesTick = (): void => {
    if (!this.warpStage || !this.warpShockwaves || !this.warpZoomBlur || !this.warpBurst || !this.warpFlash || !this.loadCurtain) return;
    const now = performance.now();
    const p = this.warpParams;

    // ---- Load curtain alpha tween (runs unconditionally) ----
    // The curtain is a Graphics on warpStage with no filter cost. When
    // its alpha is 0 Pixi skips the draw, so idle cost is zero.
    if (this.loadCurtainTargetAlpha !== this.loadCurtain.alpha) {
      const rising = this.loadCurtainTargetAlpha > this.loadCurtainTweenFromAlpha;
      const dur = rising ? CURTAIN_RISE_MS : CURTAIN_FADE_MS;
      const elapsed = now - this.loadCurtainTweenStartedAt;
      if (elapsed >= dur) {
        this.loadCurtain.alpha = this.loadCurtainTargetAlpha;
      } else {
        const t = elapsed / Math.max(1, dur);
        this.loadCurtain.alpha = this.loadCurtainTweenFromAlpha
          + (this.loadCurtainTargetAlpha - this.loadCurtainTweenFromAlpha) * t;
      }
    }

    // ---- Burst + flash decay (independent of warp main envelope) ----
    let burstActive = false;
    let burstFalloff = 0;
    if (this.warpBurstStartedAt > 0) {
      const elapsed = now - this.warpBurstStartedAt;
      if (elapsed >= p.burstDurationMs && elapsed >= p.flashDurationMs) {
        this.warpBurstStartedAt = 0;
        this.warpBurst.amplitude = 0;
        this.warpFlash.alpha = 0;
        // Tear down the filter chain if nothing else is using it — the
        // fade-out completion path can't tear down while the burst is
        // still playing, so this is the second chance. See
        // `shouldDetachWarpVisual` doc for the perf consequence.
        if (shouldDetachWarpVisual({
          burstStartedAt: this.warpBurstStartedAt,
          fadeStartedAt: this.warpFadeStartedAt,
          intensity: this.warpIntensity,
        })) {
          this.app.stage.filters = [];
          this.warpStandaloneBurst = false;
          // Only hide warpStage if the load curtain isn't using it —
          // otherwise the curtain (its child) freezes from view mid-tween.
          if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
            this.warpStage.visible = false;
          }
          return;
        }
      } else {
        burstActive = true;
        // Burst amplitude + brightness decay with a √(1-t) curve —
        // peaks at burst start then falls off slowly so the
        // wavefront stays visible at the perimeter (drive-by viewers
        // still see the tail end). Linear decay collapses too fast.
        const burstT = Math.min(1, elapsed / Math.max(1, p.burstDurationMs));
        burstFalloff = Math.sqrt(Math.max(0, 1 - burstT));
        this.warpBurst.amplitude = p.burstAmplitude * burstFalloff;
        this.warpBurst.brightness = 1 + (p.burstBrightness - 1) * burstFalloff;
        this.warpBurst.time = elapsed / 1000;
        this.warpBurst.speed = p.burstSpeed;
        this.warpBurst.wavelength = p.burstWavelength;

        // Distance-attenuate the flash. The flash represents the
        // light-pulse a viewer perceives from a warp event — it
        // shouldn't blanket the entire sector for every warp. Only the
        // local viewer (camera world centre = local ship in production)
        // within `flashRangeMax` world units sees it, with linear
        // falloff. Non-world centres (sandbox screen-space click or
        // null) get full intensity (no concept of "distance").
        let distanceFactor = 1;
        if (this.warpCenter?.kind === 'world' && p.flashRangeMax > 0) {
          const cam = this.camera.center;
          const dx = this.warpCenter.worldX - cam.x;
          const dy = this.warpCenter.worldY - cam.y;
          const dist = Math.hypot(dx, dy);
          distanceFactor = Math.max(0, 1 - dist / p.flashRangeMax);
        }

        // Flash alpha: instant ramp-up (8% of duration), then linear decay.
        const flashT = elapsed / Math.max(1, p.flashDurationMs);
        let flashAlpha: number;
        if (flashT < 0.08) flashAlpha = p.flashAlphaMax * (flashT / 0.08);
        else if (flashT < 1) flashAlpha = p.flashAlphaMax * (1 - (flashT - 0.08) / (1 - 0.08));
        else flashAlpha = 0;
        this.warpFlash.alpha = Math.max(0, flashAlpha * distanceFactor);
      }
    }

    // Fade-out tween. Linear interp from intensity 1 → 0 over fadeOutMs.
    if (this.warpFadeStartedAt > 0) {
      const elapsed = now - this.warpFadeStartedAt;
      this.warpIntensity = Math.max(0, 1 - elapsed / Math.max(1, p.fadeOutMs));
      if (this.warpIntensity <= 0) {
        // Main envelope is done. If the burst is still playing, keep
        // filters attached so it can finish; otherwise tear down.
        this.warpFadeStartedAt = 0;
        this.warpPhase = 'idle';
        if (!burstActive) {
          this.app.stage.filters = [];
          this.warpStandaloneBurst = false;
          // Curtain might be rising (transit hand-off) — keep warpStage
          // visible so the curtain Graphics renders.
          if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
            this.warpStage.visible = false;
          }
        }
        return;
      }
    }

    // If we're in standalone-burst mode (triggerWarpIn called when no
    // spool/climax was running) and the burst has just completed, tear
    // down filters now.
    if (this.warpStandaloneBurst && !burstActive && this.warpFadeStartedAt === 0 && this.warpIntensity <= 0) {
      this.app.stage.filters = [];
      this.warpStandaloneBurst = false;
      if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
        this.warpStage.visible = false;
      }
      return;
    }

    if (this.warpIntensity <= 0 && !burstActive) return;

    // Resolve the warp centre EVERY frame. An `entity` anchor re-reads
    // THAT ship's live sprite (by id — local, remote or bot, no
    // special-case) so the ripple tracks it through the whole spool
    // instead of freezing where charging began. The sprite is already
    // Pixi-placed (`sprite.y = -ship.y`) so its global pos needs no
    // flip. `world` (remote warp-out, ship gone) negates Y in the
    // helper; `screen`/`null` pass through.
    let entityGlobal: { x: number; y: number } | null = null;
    if (this.warpCenter?.kind === 'entity') {
      const s = this.sprites.get(this.warpCenter.entityId);
      if (s) entityGlobal = this.world.toGlobal({ x: s.x, y: s.y });
    }
    const { x: cx, y: cy } = resolveWarpFilterCenter({
      warpCenter: this.warpCenter,
      projectWorld: (px, py) => this.world.toGlobal({ x: px, y: py }),
      entityGlobal,
      screenW: this.camera.screenWidth,
      screenH: this.camera.screenHeight,
    });

    // Burst follows the resolved centre regardless of spool/climax
    // state. Standalone warp-in: only the burst is active, skip the
    // spool/climax block entirely.
    if (burstActive) {
      this.warpBurst.center = { x: cx, y: cy };
    }
    if (this.warpIntensity <= 0) return;

    // Resolve phase + per-phase config. The amplitude/brightness/blur
    // envelope is continuous across the spool→climax boundary — spool
    // peak feeds into climax start so there's no visual discontinuity.
    const elapsed = now - this.warpStartedAt;
    let phase: 'spool' | 'climax';
    let phaseProgress: number;     // 0..1 within the current phase
    let targetCount: number;
    let targetRadius: number;
    let wavePeriodMs: number;
    let amplitudeFrom: number;
    let amplitudeTo: number;
    let brightnessFrom: number;
    let brightnessTo: number;
    let blurFrom: number;
    let blurTo: number;

    if (this.warpFadeStartedAt === 0 && elapsed < p.spoolDurationMs) {
      // Spool: count = spoolCount, finite radius, fast cycle, ramp 0 → spool peak.
      phase = 'spool';
      phaseProgress = elapsed / Math.max(1, p.spoolDurationMs);
      targetCount = p.spoolCount;
      targetRadius = p.spoolRadius;
      wavePeriodMs = p.spoolWavePeriodMs;
      amplitudeFrom = 0;
      amplitudeTo = p.spoolAmplitude;
      brightnessFrom = 1;
      brightnessTo = p.spoolBrightness;
      blurFrom = 0;
      blurTo = p.spoolZoomBlur;
    } else {
      // Climax (or fade-out — climax params still apply during fade):
      // count = 1, infinite radius, slow cycle, ramp spool-peak → climax peak.
      phase = 'climax';
      const climaxElapsed = Math.max(0, elapsed - p.spoolDurationMs);
      phaseProgress = Math.min(1, climaxElapsed / Math.max(1, p.climaxDurationMs));
      targetCount = 1;
      targetRadius = -1;
      wavePeriodMs = p.climaxWavePeriodMs;
      amplitudeFrom = p.spoolAmplitude;
      amplitudeTo = p.climaxAmplitude;
      brightnessFrom = p.spoolBrightness;
      brightnessTo = p.climaxBrightness;
      blurFrom = p.spoolZoomBlur;
      blurTo = p.climaxZoomBlur;
    }

    // Phase transition: rebuild the shockwave stack if count or radius
    // changed (count is structural in pixi-filters; radius is a
    // construction-time uniform). Cheap — one allocation per transition,
    // not per frame. Also reset `warpPhaseStartedAt` so the new phase's
    // shockwave time starts at 0 — otherwise the climax wave can spawn
    // mid-cycle and be invisibly far off-centre for ~1 s.
    if (
      this.warpPhase !== phase ||
      this.warpStackCount !== targetCount ||
      this.warpStackRadius !== targetRadius
    ) {
      this.warpShockwaves = this.buildShockwaveStack(targetCount, targetRadius);
      this.warpStackCount = targetCount;
      this.warpStackRadius = targetRadius;
      this.warpPhase = phase;
      this.warpPhaseStartedAt = now;
      this.attachWarpFilters();
    }

    const k = this.warpIntensity;
    const amplitude = (amplitudeFrom + (amplitudeTo - amplitudeFrom) * phaseProgress) * k;
    const brightness = 1 + ((brightnessFrom - 1) + ((brightnessTo - 1) - (brightnessFrom - 1)) * phaseProgress) * k;
    const blurStrength = (blurFrom + (blurTo - blurFrom) * phaseProgress) * k;

    // Shared time phase across the stack; each filter is offset by
    // i/count. `tSec` is measured RELATIVE TO PHASE START so the
    // wave is at radius 0 (centre) at phase entry, then expands. Using
    // wall-clock time mod cycleSec would put the wave at a random
    // radius at phase entry, often off-screen.
    const cycleSec = Math.max(0.001, wavePeriodMs / 1000);
    const tSec = ((now - this.warpPhaseStartedAt) / 1000) % cycleSec;
    const filters = this.warpShockwaves;
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (!f) continue;
      f.time = (tSec + (i / filters.length) * cycleSec) % cycleSec;
      f.amplitude = amplitude;
      f.brightness = brightness;
      f.center = { x: cx, y: cy };
      f.speed = p.speed;
      f.wavelength = p.wavelength;
    }

    this.warpZoomBlur.center = { x: cx, y: cy };
    this.warpZoomBlur.strength = blurStrength;
    this.warpZoomBlur.innerRadius = p.zoomBlurInnerRadius;

    // Bloom strength: silent during spool, ramps with climax progress,
    // takes max(climaxProgress * k, burstFalloff) so once the burst
    // fires the bloom rides on the burst's slow sqrt decay instead of
    // collapsing with the (shorter) fade-out tween. That keeps the
    // wavefront glowing through its whole flight, which is what makes
    // distant viewers spot it.
    if (this.warpBloom) {
      const climaxBloom = phase === 'climax' ? phaseProgress * k : 0;
      const bloomFactor = Math.max(climaxBloom, burstFalloff);
      this.warpBloom.strength = p.bloomStrengthMax * bloomFactor;
    }
  };

  /**
   * Read the most recent feedback the renderer wrote at the tail of its
   * last `update()` call. See `IRenderer.getFeedback` / `RendererFeedback`
   * — the contract surface for both today (sync mutate) and the future
   * worker-renderer path (postMessage cache).
   */
  getFeedback(): RendererFeedback {
    return this.feedback;
  }

  /**
   * Test-only — number of currently-visible halo arrows.
   * @deprecated Read `getFeedback().haloArrowCount` instead. Kept for
   * backward-compat with any external consumer; the production read
   * site (`App.tsx`) uses `getFeedback()`.
   */
  getDebugHaloArrowCount(): number {
    return this.feedback.haloArrowCount;
  }

  /**
   * Multi-mount/turret refactor (Phase 3) — number of mount sprites
   * currently parented to the given ship's main Pixi sprite. Test-only;
   * exposed via the `data-mount-count` attribute in `App.tsx` so E2E
   * specs can assert that multi-mount ship kinds wire visible turrets.
   * @deprecated Read `getFeedback().mountCounts.get(shipId) ?? 0` instead.
   */
  mountCountForShip(shipId: string): number {
    return this.feedback.mountCounts.get(shipId) ?? 0;
  }

  dispose(): void {
    if (!this.initialized) return;
    // Flip the flag FIRST so any rAF / ResizeObserver callback that fires
    // between here and the actual destroy() short-circuits cleanly. Without
    // this, the queued requestAnimationFrame(resize) at the end of init()
    // could land post-destroy and read a null renderer.
    this.initialized = false;
    // Remove canvas pointer / wheel / touch listeners so an in-flight
    // event doesn't reach a destroyed Camera.
    const canvas = this.app?.canvas;
    if (canvas) {
      for (const { type, handler, options } of this.canvasListeners) {
        canvas.removeEventListener(type, handler, options);
      }
    }
    this.canvasListeners.length = 0;
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) ro.disconnect();
    this.damageNumbers?.destroy();
    this.healthBars?.destroy();
    this.labels?.destroy();
    this.mountVisuals.disposeAll();
    this.halo.destroy();
    this.backgroundGrid?.destroy();
    this.starfield?.destroy();
    // Warp stage + filters live on app.stage so `app.destroy({ children: true })`
    // tears them down. Just drop our references so a stale rAF callback
    // post-destroy can't reach into the freed Graphics.
    this.app.ticker.remove(this.tickWarpShockwaves);
    this.warpStage = null;
    this.warpShockwaves = null;
    this.warpZoomBlur = null;
    this.warpBurst = null;
    this.warpFlash = null;
    this.warpBloom = null;
    this.loadCurtain = null;
    this.app.destroy(true, { children: true });
  }
}
