/**
 * Tractor beams on screen (salvage plan PR 11b): each `mirror.tractorLinks`
 * row becomes beam views for the tractor's `BeamSpritePool`, the same pool
 * every beam draws with (styles in `beamStyles.ts`):
 * - the LINE, from the emitter mount's barrel tip to the target's centre
 *   (`TRACTOR_BEAM_STYLE`: faint, thin, pale blue);
 * - soft RINGS travelling along it toward the emitter, so the direction of
 *   pull reads (`TRACTOR_PULSE_STYLE`): short bars across the line, spaced
 *   and sized in SCREEN px (the same look at any zoom), each fading in near
 *   the target and out near the barrel.
 *
 * Poses are the drawn ones: a pilot's mirror pose, a drone's resolved
 * display pose (`resolveEntityDisplayPose`), anything else interpolated like
 * its sprite. Allocation-free once `out` has grown (#14). Time is game time
 * (`fxNow()`), so the rings slow with the sector.
 */
import type { RenderMirror, ShipRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { resolveInstanceMounts } from '../../shared-types/shipKinds/slots.js';
import { shipShotMuzzle } from '../../core/combat/muzzle.js';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation.js';
import { resolveEntityDisplayPose } from '../net/swarmDisplayPose.js';
import type { BeamView } from './BeamSpritePool.js';
import { TRACTOR_PULSE_STYLE } from './beamStyles.js';

/** Screen px between rings. */
export const TRACTOR_PULSE_SPACING_PX = 64;
/** Screen px a ring travels per second (game time). */
export const TRACTOR_PULSE_SPEED_PX_S = 80;
/** A ring's length across the line, screen px. */
export const TRACTOR_RING_PX = 11;
/** Most rings on one beam (a long beam spaces them wider). */
export const TRACTOR_MAX_PULSES = 12;

const _e: InterpolatedPose = { x: 0, y: 0, angle: 0 };
const _t: InterpolatedPose = { x: 0, y: 0, angle: 0 };

function swarmPose(sw: SwarmRenderState, nowMs: number, out: InterpolatedPose): InterpolatedPose {
  return sw.kind === 1 ? resolveEntityDisplayPose(sw, out) : interpolateSwarmPose(sw, nowMs, out);
}

/** A wire ref's drawn pose into `out`, and its ship kind id (undefined: none
 *  known); false when it is not in the mirror. */
let _kindId: string | undefined;
/** The emitter's activated latent mounts and DRAWN mount angles (what
 *  `applyMountAngles` turns the guns by; instance/catalogue order). */
let _activated: ShipRenderState['activatedMounts'];
let _angles: readonly number[] | undefined;
function poseOf(m: Pick<RenderMirror, 'ships' | 'swarm'>, ref: number | string, nowMs: number, out: InterpolatedPose): boolean {
  if (typeof ref === 'number') {
    const sw = m.swarm?.get(ref);
    if (sw === undefined) return false;
    swarmPose(sw, nowMs, out);
    _kindId = sw.shipKind;
    _activated = undefined;
    _angles = sw.displayMountAngles ?? sw.mountAngles;
    return true;
  }
  const s = m.ships.get(ref);
  if (s === undefined) return false;
  out.x = s.x; out.y = s.y; out.angle = s.angle;
  _kindId = s.kind;
  _activated = s.activatedMounts;
  _angles = s.mountAngles;
  return true;
}

function slot(out: BeamView[], i: number): BeamView {
  let v = out[i];
  if (v === undefined) {
    v = { fromX: 0, fromY: 0, toX: 0, toY: 0, style: null, alphaMul: 1 };
    out[i] = v; // grows to the peak count once
  }
  return v;
}

/**
 * Fill `out` with this frame's tractor views (lines and rings) and return how
 * many. `cameraScale`: screen px per world unit. A link whose emitter or
 * target is not in the mirror draws nothing.
 */
export function fillTractorBeams(
  m: Pick<RenderMirror, 'ships' | 'swarm' | 'tractorLinks'>, nowMs: number, cameraScale: number, out: BeamView[],
): number {
  const links = m.tractorLinks;
  if (links === undefined || links.length === 0 || !(cameraScale > 0)) return 0;
  let n = 0;
  for (let li = 0; li < links.length; li++) {
    const link = links[li]!;
    if (!poseOf(m, link.target, nowMs, _t)) continue;
    if (!poseOf(m, link.emitter, nowMs, _e)) continue;
    const kind = getShipKind(_kindId ?? null);
    // The same mount list and index the drawn guns use (shipSpriteUpdater /
    // swarmSpriteUpdater -> applyMountAngles): base mounts, then activated
    // latent ones. Allocates only on the rare activated path (as the sprite
    // updater does).
    const mounts = resolveInstanceMounts(kind, _activated);
    let mi = -1;
    for (let i = 0; i < mounts.length; i++) if (mounts[i]!.id === link.mountId) { mi = i; break; }
    // From the DRAWN barrel tip: the mount's pivot, the gun's own angle and
    // the shared muzzle (core/combat/muzzle.ts). No mount: the hull centre.
    let fx = _e.x, fy = _e.y;
    if (mi >= 0) {
      const mount = mounts[mi]!;
      const c = Math.cos(_e.angle), s = Math.sin(_e.angle);
      const px = fx + mount.localX * c - mount.localY * s;
      const py = fy + mount.localX * s + mount.localY * c;
      const a = _e.angle + mount.baseAngle + (_angles?.[mi] ?? 0);
      const muzzle = shipShotMuzzle(kind, mount, typeof link.emitter === 'number');
      fx = px - Math.sin(a) * muzzle;
      fy = py + Math.cos(a) * muzzle;
    }
    let dx = _t.x - fx, dy = _t.y - fy;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    dx /= len; dy /= len;
    const line = slot(out, n++);
    line.fromX = fx; line.fromY = fy; line.toX = _t.x; line.toY = _t.y;
    line.style = null; line.alphaMul = 1; line.solidLen = undefined;

    // Rings: spaced in screen px (wider on a long beam), moving toward the
    // emitter: a ring at d from the barrel shrinks d as time runs.
    const pxToWorld = 1 / cameraScale;
    const spacing = Math.max(TRACTOR_PULSE_SPACING_PX * pxToWorld, len / TRACTOR_MAX_PULSES);
    const speed = TRACTOR_PULSE_SPEED_PX_S * pxToWorld;
    const phase = ((nowMs / 1000) * speed) % spacing; // 0..spacing
    const half = (TRACTOR_RING_PX * pxToWorld) / 2;
    for (let d = spacing - phase; d < len; d += spacing) {
      const u = d / len;
      const fade = Math.sin(Math.PI * u); // 0 at the barrel and at the target
      if (fade <= 0.02) continue;
      const cx = fx + dx * d, cy = fy + dy * d;
      const ring = slot(out, n++);
      // Across the line (the perpendicular of (dx, dy)).
      ring.fromX = cx + dy * half; ring.fromY = cy - dx * half;
      ring.toX = cx - dy * half; ring.toY = cy + dx * half;
      ring.style = TRACTOR_PULSE_STYLE; ring.alphaMul = fade; ring.solidLen = undefined;
    }
  }
  return n;
}
