/**
 * Tractor beams on screen (salvage plan PR 11b): each `mirror.tractorLinks`
 * row becomes beam views for the tractor's `BeamSpritePool`, the same pool
 * every beam draws with (styles in `beamStyles.ts`):
 * - the BEAM, from the emitter mount's barrel tip to the target's centre
 *   (`TRACTOR_BEAM_STYLE`: drawn like a beam weapon, with a blue glow);
 * - look B only (`?tractorLook=b`): bright PULSES running along it toward
 *   the emitter, so the direction of pull reads (`TRACTOR_PULSE_STYLE`),
 *   spaced and sized in SCREEN px (the same look at any zoom), each fading
 *   in near the target and out near the barrel.
 *
 * Poses are the drawn ones: a pilot's mirror pose, a drone's resolved
 * display pose (`resolveEntityDisplayPose`), anything else interpolated like
 * its sprite. Allocation-free once `out` has grown (#14). Time is game time
 * (`fxNow()`), so the pulses slow with the sector.
 */
import type { RenderMirror, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipShotMuzzle } from '../../core/combat/muzzle.js';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation.js';
import { resolveEntityDisplayPose } from '../net/swarmDisplayPose.js';
import type { BeamView } from './BeamSpritePool.js';
import { TRACTOR_BEAM_STYLE, TRACTOR_PULSE_STYLE, findMount, tractorLook } from './beamStyles.js';

/** Screen px between pulses. */
export const TRACTOR_PULSE_SPACING_PX = 64;
/** Screen px a pulse travels per second (game time). */
export const TRACTOR_PULSE_SPEED_PX_S = 80;
/** A pulse's length along the beam, screen px. */
export const TRACTOR_PULSE_PX = 24;
/** Most pulses on one beam (a long beam spaces them wider). */
export const TRACTOR_MAX_PULSES = 12;

const _e: InterpolatedPose = { x: 0, y: 0, angle: 0 };
const _t: InterpolatedPose = { x: 0, y: 0, angle: 0 };

function swarmPose(sw: SwarmRenderState, nowMs: number, out: InterpolatedPose): InterpolatedPose {
  return sw.kind === 1 ? resolveEntityDisplayPose(sw, out) : interpolateSwarmPose(sw, nowMs, out);
}

/** A wire ref's drawn pose into `out`, and its ship kind id (undefined: none
 *  known); false when it is not in the mirror. */
let _kindId: string | undefined;
function poseOf(m: Pick<RenderMirror, 'ships' | 'swarm'>, ref: number | string, nowMs: number, out: InterpolatedPose): boolean {
  if (typeof ref === 'number') {
    const sw = m.swarm?.get(ref);
    if (sw === undefined) return false;
    swarmPose(sw, nowMs, out);
    _kindId = sw.shipKind;
    return true;
  }
  const s = m.ships.get(ref);
  if (s === undefined) return false;
  out.x = s.x; out.y = s.y; out.angle = s.angle;
  _kindId = s.kind;
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
    const mount = findMount(kind.mounts, link.mountId);
    // The mount's pivot on the drawn hull (no mount: the hull centre).
    let px = _e.x, py = _e.y;
    if (mount !== null) {
      const c = Math.cos(_e.angle), s = Math.sin(_e.angle);
      px += mount.localX * c - mount.localY * s;
      py += mount.localX * s + mount.localY * c;
    }
    let dx = _t.x - px, dy = _t.y - py;
    const dist = Math.hypot(dx, dy);
    // Out of the barrel toward the target (the turret is locked on it).
    const muzzle = mount !== null ? shipShotMuzzle(kind, mount, typeof link.emitter === 'number') : 0;
    if (dist <= muzzle) continue; // target inside the barrel: nothing to draw
    dx /= dist; dy /= dist;
    const fx = px + dx * muzzle, fy = py + dy * muzzle;
    const len = dist - muzzle;
    const line = slot(out, n++);
    line.fromX = fx; line.fromY = fy; line.toX = _t.x; line.toY = _t.y;
    line.style = TRACTOR_BEAM_STYLE; line.alphaMul = 1; line.solidLen = undefined;
    if (tractorLook() !== 'b') continue;

    // Pulses (look B): spaced in screen px (wider on a long beam), moving
    // toward the emitter: a pulse at d from the barrel shrinks d as time runs.
    const pxToWorld = 1 / cameraScale;
    const spacing = Math.max(TRACTOR_PULSE_SPACING_PX * pxToWorld, len / TRACTOR_MAX_PULSES);
    const speed = TRACTOR_PULSE_SPEED_PX_S * pxToWorld;
    const phase = ((nowMs / 1000) * speed) % spacing; // 0..spacing
    const half = Math.min((TRACTOR_PULSE_PX * pxToWorld) / 2, spacing / 4);
    for (let d = spacing - phase; d < len; d += spacing) {
      const u = d / len;
      const fade = Math.sin(Math.PI * u); // 0 at the barrel and at the target
      if (fade <= 0.02) continue;
      const cx = fx + dx * d, cy = fy + dy * d;
      const pulse = slot(out, n++);
      // Along the beam, centred on d.
      pulse.fromX = cx - dx * half; pulse.fromY = cy - dy * half;
      pulse.toX = cx + dx * half; pulse.toY = cy + dy * half;
      pulse.style = TRACTOR_PULSE_STYLE; pulse.alphaMul = fade; pulse.solidLen = undefined;
    }
  }
  return n;
}
