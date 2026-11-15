/**
 * Named beam-pool styles (WS-4 Phase 4 follow-up). Hoisted out of
 * `PixiRenderer.init` so the deliberate visual DISTINCTION between the combat
 * laser beam and the Miner's drill beam is a greppable, unit-lockable contract
 * — not two inline literals a copy-paste could quietly equalise (which would
 * make the mining beam indistinguishable from a combat laser, defeating the
 * dedicated-pool point).
 *
 * Type-only import of `BeamSpriteStyle` keeps this module free of any Pixi
 * runtime dependency, so the lock test (`beamStyles.test.ts`) needs no renderer.
 */
import type { BeamSpriteStyle } from './BeamSpritePool.js';
import type { BeamCrossSection } from './beamCrossSection.js';
import { HEAVY_BEAM_WIDTH, MINING_LASER_WIDTH } from '../../core/combat/WeaponCatalogue.js';

/** Remote players' / drones' / turrets' combat hitscan beam — thin warm amber.
 *  `taper` (P3.13) — combat beams fade toward the tip of their range. */
export const REMOTE_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffaa44, width: 2, alpha: 1, taper: true };

/** The pilot's own hitscan beams (`mirror.liveBeams`): a white core that
 *  `LaserGlow` haloes cyan, tapering to the tip of its range. */
export const LIVE_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffffff, width: 2, alpha: 1, taper: true };

/** The Miner's mining (drill) beam — deliberately DISTINCT from the combat
 *  beam: a fatter, warmer amber at lower alpha so a player reads "mining laser",
 *  not "someone is shooting". */
export const MINING_BEAM_STYLE: BeamSpriteStyle = { tint: 0xffb24d, width: 3.5, alpha: 0.9 };

/**
 * The capital heavy beam's colour (plan beam-slices §8): a hot violet, distinct
 * from the amber fighter beams, the cyan own-ship beam and the amber drill. The
 * glow on a wreck's slice-cut edges reuses it, so a slice reads as "cut by that
 * beam" — import this, never re-type the literal.
 */
export const HEAVY_BEAM_COLOR = 0xb46cff;

/** Fewest screen px the heavy beam's core is drawn wide (`minScreenPx`): at
 *  capital zoom its 10 u core is under a px, thinner on screen than a fighter
 *  beam's glow; 12 px keeps it reading as the heaviest beam in the fight (6 px
 *  filmed as a laser pointer next to a 120 px hull). */
export const HEAVY_BEAM_MIN_SCREEN_PX = 12;

/** The heavy beam's deep, saturated violet: the body of its cross-section
 *  and the colour it lights hulls with (`addBeamLights`). Deeper than
 *  `HEAVY_BEAM_COLOR` (owner 2026-11-15: the flat bar "looks a bit too
 *  pastel"). */
export const HEAVY_BEAM_DEEP_COLOR = 0x8c2cff;

/**
 * The heavy beam across its width (owner 2026-11-15: "could use some gradient";
 * it was a flat lavender bar): a white-hot core, through hot violet, to the
 * deep saturated violet body, opaque out to the core width (`at` 1 / span),
 * then a soft glowing edge fading to nothing. Baked once into a tiny texture
 * every heavy beam shares (`BeamSpritePool`); no filter.
 */
export const HEAVY_BEAM_CROSS_SECTION: BeamCrossSection = {
  span: 1.6,
  stops: [
    { at: 0, color: 0xffffff, alpha: 1 },
    { at: 0.1, color: 0xfbefff, alpha: 1 },
    { at: 0.26, color: 0xd59cff, alpha: 1 },
    { at: 0.45, color: 0xa040ff, alpha: 1 },
    { at: 0.625, color: HEAVY_BEAM_DEEP_COLOR, alpha: 0.95 },
    { at: 0.8, color: 0x7020e6, alpha: 0.4 },
    { at: 1, color: 0x5a14c8, alpha: 0 },
  ],
};

/**
 * A beam that is a light source along its length (the capital heavy beam;
 * owner 2026-11-15: "could use lighting so it gives a purple glow on ships
 * nearby, it's a light source"): point lights at FIXED distances from the
 * muzzle (`spacing` apart, the first on the muzzle, so the shooter's own hull
 * glows), each reaching past the next, plus a tight spot at the hit point.
 * Nothing depends on the beam's total length: a follow-through beam running on
 * past a dead target to full range moves only its end light and never changes
 * the light on the shooter (hostile review 2026-11-15: lights spaced as shares
 * of the length spread to 4 km apart with 4.4 km reach on the kill frame, and
 * the shooter's whole hull went flat violet). The lit pass has no line light;
 * a hull picks the strongest few scene lights at its own rectangle.
 */
export interface BeamLineLight {
  /** Light colour (0xRRGGBB). */
  readonly color: number;
  /** Hit-point light intensity (the lit shader's scale; a blast is 3). */
  readonly hitIntensity: number;
  /** Hit-point light reach (world u): a spot, so the target is lit from the
   *  point it is hit and its far side stays dark (at the line reach, 450 u
   *  up, it was a flat lilac wash over ~60 % of a cruiser). */
  readonly hitReach: number;
  /** Hit-point light height above the hull top (world u): low, so the deck
   *  beside the hit faces it and the deck farther off meets it at a glance. */
  readonly hitZ: number;
  /** Each line light's intensity. */
  readonly intensity: number;
  /** World u between line lights, from the muzzle. */
  readonly spacing: number;
  /** World u a line light reaches (> spacing / 2: they overlap, so the glow
   *  runs unbroken along the lit stretch). A line light stops short of the
   *  hit by at least this, so it never washes over the target. */
  readonly reach: number;
  /** Height (world u) above the hull top: higher lights a deck more head-on
   *  (at 120 u a light 700 u off met a flat deck at ~10°: filmed, barely any
   *  violet on either hull). */
  readonly z: number;
}

/** The heavy beam as a light: deep violet at the muzzle, along the beam and
 *  as a spot at the hit. */
export const HEAVY_BEAM_LINE_LIGHT: BeamLineLight = {
  color: HEAVY_BEAM_DEEP_COLOR, hitIntensity: 5, hitReach: 700, hitZ: 150,
  intensity: 4, spacing: 900, reach: 1000, z: 450,
};

/** The capital heavy beam (`heavy_beam` mounts): a thick, capital-scale beam —
 *  core `HEAVY_BEAM_WIDTH` wide, the width of the strip its slice erases on a
 *  kill. It does NOT taper: full width and brightness all the way to its hit
 *  point (filmed review 2026-11-15: on the fighter taper gradient it thinned
 *  and dimmed over its last third, right at the impact); only a miss fades,
 *  over its last `HEAVY_BEAM_MISS_FADE_FRAC` (`remoteBeamSolidLen`). Drawn by
 *  the SAME remote pool as fighter beams (a per-beam style override), in the
 *  pool's unfiltered `styledContainer`: the remote container's one orange glow
 *  filter would swamp the violet. The core is never under `minScreenPx` wide,
 *  so it reads heavier than a glowing fighter beam at capital zoom (where even
 *  60 u can be only a few px). It draws with `HEAVY_BEAM_CROSS_SECTION` (its
 *  colours, untinted); `tint` colours the `?fx=new` glow, which `glowScale`
 *  widens (halo / flow / flare). */
export const HEAVY_BEAM_STYLE: BeamSpriteStyle = {
  tint: HEAVY_BEAM_COLOR, width: HEAVY_BEAM_WIDTH, alpha: 1, taper: false, glowScale: 3, minScreenPx: HEAVY_BEAM_MIN_SCREEN_PX,
  crossSection: HEAVY_BEAM_CROSS_SECTION, lineLight: HEAVY_BEAM_LINE_LIGHT,
};

/** Fewest screen px the mining laser's core is drawn wide (`minScreenPx`):
 *  thinner than the heavy beam's 12, still visible at capital zoom. */
export const MINING_LASER_MIN_SCREEN_PX = 5;

/** The mining laser (`mining_laser` mounts; plan partitioned-chasing-lark
 *  PR 7): the Miner's drill-beam colours (`MINING_BEAM_STYLE`, so a player
 *  reads "mining", not "attack") at capital scale: core `MINING_LASER_WIDTH`
 *  wide, the strip its slice erases. Solid to the hit point (no taper), drawn
 *  by the same remote pool as every other beam (a per-beam style). */
export const MINING_LASER_STYLE: BeamSpriteStyle = {
  ...MINING_BEAM_STYLE, width: MINING_LASER_WIDTH, taper: false, minScreenPx: MINING_LASER_MIN_SCREEN_PX,
};

/** The tractor beam's pale blue (salvage plan PR 11b). */
export const TRACTOR_BEAM_COLOR = 0xa8d4ff;

/** The tractor beam's line (owner 2026-11-15: "a faint, thin, pale-blue line
 *  from the barrel to the target … subtle, not a weapon beam"): flat (no
 *  taper: it holds its target, it does not fade out at range), low alpha,
 *  a hair wide at any zoom. Drawn by its own `BeamSpritePool`, unfiltered
 *  (no glow, no lights): `render/tractorBeams.ts`. */
export const TRACTOR_BEAM_STYLE: BeamSpriteStyle = { tint: TRACTOR_BEAM_COLOR, width: 1, alpha: 0.3, minScreenPx: 1.25 };

/** The soft rings travelling along a tractor line toward its emitter (the
 *  direction of pull): short bars across the line, a little brighter than
 *  the line, faded in and out along it (`BeamView.alphaMul`). */
export const TRACTOR_PULSE_STYLE: BeamSpriteStyle = { tint: 0xd2e8ff, width: 1, alpha: 0.55, minScreenPx: 2 };

/** A heavy beam that MISSES fades over this last share of its drawn length
 *  (to its max range); one that hits is solid to the hit point. */
export const HEAVY_BEAM_MISS_FADE_FRAC = 0.15;

/** The solid length (`BeamView.solidLen`) a remote beam of `style` draws
 *  with over `len` world units: a non-tapering style (the heavy beam) is
 *  solid to its end on a hit, and fades only over its last
 *  `HEAVY_BEAM_MISS_FADE_FRAC` on a miss; anything else (null: the fighter
 *  pool style, or a tapering style) is undefined, the pool's own taper. */
export function remoteBeamSolidLen(style: BeamSpriteStyle | null, len: number, hit: boolean): number | undefined {
  if (style === null || style.taper) return undefined;
  return hit ? len : len * (1 - HEAVY_BEAM_MISS_FADE_FRAC);
}

/** What a pilot's own beam slot draws with (`BeamView.style` / `solidLen`). */
export interface LiveBeamLook { style?: BeamSpriteStyle | null; solidLen?: number }

/**
 * The look of the pilot's OWN beam from `mount` (PixiRenderer's live-beam
 * loop, `mirror.liveBeams`), into `out` (no allocation, #14): `len` the drawn
 * length, `solidDist` the client ray's solid length, `hit` whether it stopped
 * on something.
 *
 * A styled mount (the heavy beam, the mining laser) draws with the SAME style
 * and solid length as when another ship fires it (`remoteBeamStyleForMount`,
 * `remoteBeamSolidLen`): the pool's unfiltered `styledContainer`, its
 * `minScreenPx` floor. Anything else keeps the live style and the ray's
 * solid length. (The pilot's heavy beam once drew with the fighter look: a
 * 2 u core under the cyan `LaserGlow`, a fraction of a px at capital zoom,
 * so it rasterised as a faint cyan dotted line.)
 */
export function liveBeamLook(
  mount: { readonly weaponId: string } | null | undefined,
  len: number, solidDist: number | undefined, hit: boolean, out: LiveBeamLook,
): LiveBeamLook {
  const style = remoteBeamStyleForMount(mount);
  out.style = style;
  out.solidLen = remoteBeamSolidLen(style, len, hit) ?? solidDist;
  return out;
}

/** True when `mount` carries the capital heavy beam. */
export function isHeavyBeamMount(mount: { readonly weaponId: string } | null | undefined): boolean {
  return mount?.weaponId === 'heavy_beam';
}

/** True when `mount` fires a sustained capital beam at the 10-tick cadence
 *  (the heavy beam, the mining laser): it holds `HEAVY_BEAM_TTL_MS` so it
 *  reads as one burn, not a strobe (`remoteBeamTtlMs`). */
export function isSustainedBeamMount(mount: { readonly weaponId: string } | null | undefined): boolean {
  return remoteBeamStyleForMount(mount) !== null;
}

/** The remote-pool style a beam from `mount` draws with: the heavy style for a
 *  `heavy_beam` mount, the mining-laser style for a `mining_laser` mount, else
 *  `null` (the pool's own fighter style). The client resolves `mount` from the
 *  shooter's kind and `laser_fired.mountId`, so no wire change. */
export function remoteBeamStyleForMount(
  mount: { readonly weaponId: string } | null | undefined,
): BeamSpriteStyle | null {
  if (isHeavyBeamMount(mount)) return HEAVY_BEAM_STYLE;
  return mount?.weaponId === 'mining_laser' ? MINING_LASER_STYLE : null;
}

/** The mount `mountId` on a ship kind's catalogue `mounts` (alloc-free loop;
 *  `onMessage` / render paths, invariant #14), or null. */
export function findMount<M extends { readonly id: string }>(
  mounts: readonly M[] | undefined,
  mountId: string | undefined,
): M | null {
  if (!mounts || mountId === undefined) return null;
  for (let i = 0; i < mounts.length; i++) if (mounts[i]!.id === mountId) return mounts[i]!;
  return null;
}

/** A remote beam holds full brightness until this long before it expires,
 *  then fades (PixiRenderer's remote-laser loop). */
export const REMOTE_BEAM_FADE_MS = 150;

/**
 * How long a remote beam stays drawn after its last `laser_fired` (the TTL the
 * client stamps on the remote-laser entry). Player beams 400 ms, AI beams
 * 250 ms (see the `laser_fired` handler). The heavy beam fires every 10 ticks
 * (~167 ms); with the AI's 250 ms it would start fading 100 ms after each shot
 * and dip to ~55 % before the next one — a strobe. So it holds for the fade
 * window + a full cooldown + a snapshot-jitter margin: the next shot always
 * lands while the beam is still at full brightness, and it reads as one
 * continuous burn.
 */
export const HEAVY_BEAM_TTL_MS = 450;

export function remoteBeamTtlMs(isAiShooter: boolean, heavy: boolean): number {
  if (heavy) return HEAVY_BEAM_TTL_MS;
  return isAiShooter ? 250 : 400;
}

/**
 * The fire angle a remote beam is drawn along (PixiRenderer's remote-laser
 * loop): the shooter's live hull angle + the mount's base angle + the turret's
 * slewed angle, so the beam leaves down the drawn barrel.
 *
 * With no turret angle known (`mountAngle` undefined) it aims from the beam's
 * live origin at the wire end point (`laser_fired.to`) instead. Turret angles
 * ride `snapshot.drones[].mountAngles` only for drones in the viewer's
 * interest window, which scales with the viewer's hull: a capital burning a
 * frigate from 8 km is outside the frigate's window, and an angle defaulted
 * to 0 sent the beam along the mount's base bearing, off screen.
 */
export function remoteBeamFireAngle(
  poseAngle: number, baseAngle: number, mountAngle: number | undefined,
  originX: number, originY: number, toX: number, toY: number,
): number {
  if (mountAngle !== undefined) return poseAngle + baseAngle + mountAngle;
  const dx = toX - originX, dy = toY - originY;
  if (dx === 0 && dy === 0) return poseAngle + baseAngle;
  // Game-space forward is (-sin a, cos a).
  return Math.atan2(-dx, dy);
}

/** A drawn remote beam line (game space), filled by `remoteBeamLine`. */
export interface RemoteBeamLine { fromX: number; fromY: number; toX: number; toY: number }

/**
 * The line a remote beam is drawn along this frame (game space), into `out`
 * (no allocation, #14). `pivotX/Y` is the mount's live pivot on the shooter's
 * drawn hull, `muzzleD` the barrel length, `range` the wire beam's length and
 * `wireToX/Y` its end point (`laser_fired.to`: where the server's ray stopped).
 *
 * `holdLine` false (fighter beams): the beam leaves down the live barrel
 * (`remoteBeamFireAngle`) for `range`. Their 250 ms life overlaps a 167 ms
 * cooldown, so a fresh pulse redraws the line every shot; a nose gun's beam
 * that stayed put while the fighter turned would leave its nose.
 *
 * `holdLine` true (a styled beam: the capital heavy beam): a pulse stays on
 * the line it was fired along for its whole `HEAVY_BEAM_TTL_MS` life. Its
 * origin follows the muzzle (the ship moves under it), but it aims at the
 * wire end point and stops THERE: never the live mount angle. A heavy pulse
 * outlives a cooldown by ~280 ms, so drawing it down the live barrel swung
 * the last pulse with the turret after the kill follow-through (filmed: ~1.9°
 * off the cut in 0.33 s, then sweeping past the wreck) and, while the turret
 * was still swinging onto a target, ran the beam through the intact hull to
 * its full range.
 */
export function remoteBeamLine(
  holdLine: boolean, poseAngle: number, baseAngle: number, mountAngle: number | undefined,
  pivotX: number, pivotY: number, muzzleD: number, range: number,
  wireToX: number, wireToY: number, out: RemoteBeamLine,
): RemoteBeamLine {
  const a = remoteBeamFireAngle(poseAngle, baseAngle, holdLine ? undefined : mountAngle, pivotX, pivotY, wireToX, wireToY);
  const fx = -Math.sin(a), fy = Math.cos(a);
  out.fromX = pivotX + fx * muzzleD;
  out.fromY = pivotY + fy * muzzleD;
  if (holdLine) {
    // The end point is the server's: a hit stays on the hit. An end point
    // inside the barrel (point blank) draws nothing rather than backwards.
    const behind = (wireToX - pivotX) * fx + (wireToY - pivotY) * fy <= muzzleD;
    out.toX = behind ? out.fromX : wireToX;
    out.toY = behind ? out.fromY : wireToY;
  } else {
    out.toX = out.fromX + fx * range;
    out.toY = out.fromY + fy * range;
  }
  return out;
}

/** Where `addBeamLights` puts its lights (`LitScene.addLight`'s shape). */
export interface BeamLightSink {
  addLight(x: number, y: number, z: number, color: number, intensity: number, reach: number): void;
}

/** Most lights one line-lit beam adds (hit + line), with 8 point lights per
 *  hull (the high tiers); `HEAVY_BEAM_MAX_LIGHTS_LOW` with 4. */
export const HEAVY_BEAM_MAX_LIGHTS = 6;
export const HEAVY_BEAM_MAX_LIGHTS_LOW = 4;

/** The per-beam light budget for a lit pass giving each hull `pointLights`. */
export function beamLightBudget(pointLights: number): number {
  return pointLights >= 8 ? HEAVY_BEAM_MAX_LIGHTS : HEAVY_BEAM_MAX_LIGHTS_LOW;
}

/**
 * A beam lights where it hits and along its length (the GPU-lit art). The
 * beam is in GAME space and the lit scene in PIXI space (y down: pixiY =
 * -gameY, like every other light the renderer feeds it). Without the flip the
 * lights sat at the beam's Y mirror: a heavy beam burning a cruiser 280 u
 * below the sector's x axis lit a spot 560 u up its hull (a hard rose wash on
 * the wreck piece there that vanished with the beam) and never the piece it
 * hit. A styled beam lights in its own colour, `glowScale` wider; one with a
 * `lineLight` (the heavy beam) lights its muzzle, its length and its hit (`BeamLineLight`),
 * at most `maxLights` lights in all (`beamLightBudget`). Alloc-free.
 */
export function addBeamLights(
  sink: BeamLightSink,
  b: {
    fromX: number; fromY: number; toX: number; toY: number;
    style?: { tint: number; glowScale?: number; lineLight?: BeamLineLight } | null;
    passX?: number; passY?: number;
  },
  maxLights: number = HEAVY_BEAM_MAX_LIGHTS,
): void {
  const len = Math.hypot(b.toX - b.fromX, b.toY - b.fromY);
  const k = b.style?.glowScale ?? 1;
  const ll = b.style?.lineLight;
  if (ll && maxLights >= 2) {
    // The hit spot, then line lights at fixed distances from the muzzle (the
    // first ON it: the shooter's own hull glows), within the budget and each
    // at least its reach short of the hit. Independent of the beam's length.
    // A no-hit pulse burning through what its mount just hit (the kill
    // follow-through) keeps the spot where it crosses it (`BeamHitMemory`).
    const pass = b.passX !== undefined && b.passY !== undefined && Number.isFinite(b.passX) && Number.isFinite(b.passY);
    sink.addLight(pass ? b.passX! : b.toX, -(pass ? b.passY! : b.toY), ll.hitZ, ll.color, ll.hitIntensity, ll.hitReach);
    const ux = len > 0 ? (b.toX - b.fromX) / len : 0;
    const uy = len > 0 ? (b.toY - b.fromY) / len : 0;
    for (let j = 0; j < maxLights - 1; j++) {
      const d = j * ll.spacing;
      if (j > 0 && d + ll.reach > len) break;
      sink.addLight(b.fromX + ux * d, -(b.fromY + uy * d), ll.z, ll.color, ll.intensity, ll.reach);
    }
    return;
  }
  const c = b.style ? b.style.tint : 0xff6a9a;
  sink.addLight(b.toX, -b.toY, 6, c, 2.2, 120 * k);
  sink.addLight((b.fromX + b.toX) / 2, -(b.fromY + b.toY) / 2, 6, c, 0.8, len * 0.6 + 30 * k);
}

/** How far (world u) a no-hit pulse's line may pass from its mount's last hit
 *  and still light it: the shooter and the wreck drift a little over the
 *  0.75 s follow-through; a turret that swung off misses it by far more. */
export const BEAM_PASS_LIGHT_TOLERANCE = 250;

interface BeamHitRecord { x: number; y: number; has: boolean; gen: number }

/**
 * Each remote beam mount's last hit point, so a no-hit pulse that still burns
 * through it keeps its hit spot there (`BeamView.passX/Y`, `addBeamLights`).
 * After a heavy-beam kill the server fires full-length pulses that pass the
 * wreck (`laser.hit` false, end at max range): with no hit spot and the line
 * lights only near the muzzle, the wreck went dark the frame after the kill
 * while the beam burned on through it. The spot sits where the current line
 * crosses the last hit, and only while the beam has burned every frame since
 * that hit: the frame the beam stops, so does the light. `track` each drawn
 * beam every frame, then `endFrame` once. Allocates a record only the first
 * time a (shooter, mount) is seen (#14); `endFrame` prunes stale ones.
 */
export class BeamHitMemory {
  private readonly byShooter = new Map<string, Map<string, BeamHitRecord>>();
  private gen = 1;

  track(
    shooterId: string, mountId: string, hit: boolean,
    v: { fromX: number; fromY: number; toX: number; toY: number; passX?: number; passY?: number },
  ): void {
    let perShooter = this.byShooter.get(shooterId);
    if (!perShooter) { perShooter = new Map(); this.byShooter.set(shooterId, perShooter); }
    let r = perShooter.get(mountId);
    if (!r) { r = { x: 0, y: 0, has: false, gen: 0 }; perShooter.set(mountId, r); }
    v.passX = NaN; v.passY = NaN;
    if (hit) {
      r.x = v.toX; r.y = v.toY; r.has = true;
    } else if (r.has && r.gen === this.gen - 1) {
      const dx = v.toX - v.fromX, dy = v.toY - v.fromY;
      const len = Math.hypot(dx, dy);
      const t = len > 0 ? ((r.x - v.fromX) * dx + (r.y - v.fromY) * dy) / len : -1;
      const off = len > 0 ? Math.abs((r.x - v.fromX) * dy - (r.y - v.fromY) * dx) / len : Infinity;
      if (t > 0 && t < len && off <= BEAM_PASS_LIGHT_TOLERANCE) {
        v.passX = v.fromX + (dx / len) * t; v.passY = v.fromY + (dy / len) * t;
      } else r.has = false;
    } else r.has = false;
    r.gen = this.gen;
  }

  /** Close the frame: a mount not tracked this frame has stopped burning. */
  endFrame(): void {
    this.gen++;
    if ((this.gen & 255) !== 0) return;
    for (const [shooterId, perShooter] of this.byShooter) {
      for (const [mountId, r] of perShooter) if (r.gen < this.gen - 1) perShooter.delete(mountId);
      if (perShooter.size === 0) this.byShooter.delete(shooterId);
    }
  }
}
