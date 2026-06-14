/**
 * Pure formation geometry (roaming-formation system, Phase 5).
 *
 * Computes each squad member's slot pose RELATIVE to a leader, so a roaming
 * squad flies together in a readable shape (the user's Phase-5 ask: "it would
 * be cool if they made a formation and set arbitrary A-to-B destinations and
 * flew in formation") instead of clumping at one point.
 *
 * Frame: the leader's nose points `(-sin θ, cos θ)` (ship-angle convention,
 * matching `World.applyInput`). A slot's LOCAL offset is `(forward, right)`:
 *   forward axis = (-sin θ,  cos θ)   — toward the nose
 *   right axis   = ( cos θ,  sin θ)   — starboard (nose rotated −90°)
 * Slot 0 is the leader anchor `(0, 0)`.
 *
 * Zone-pure (src/core): scalar in / caller-owned out (allocation-free),
 * deterministic, mirror-safe (the offsets are ASYMMETRIC so a forward/right
 * swap or a Y-flip is caught by the tests). Game-space is Y-up.
 */

export type FormationShape = 'wedge' | 'line' | 'column';

export interface SlotOffset {
  /** Distance toward the leader's nose (negative = behind). */
  forward: number;
  /** Distance to the leader's starboard (negative = port). */
  right: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export function makeSlotOffset(): SlotOffset {
  return { forward: 0, right: 0 };
}

/**
 * Local `(forward, right)` offset for member `index` (0-based; 0 = leader) in a
 * squad of `count`, scaled by `spacing` (world units between neighbours).
 *
 *  - `column`: a single file trailing directly astern.
 *  - `line`:   abreast, centred on the leader's lateral axis.
 *  - `wedge`:  a V — members alternate starboard/port and step one rank astern
 *              per pair, so the squad reads as an arrowhead.
 */
export function formationSlotOffset(
  shape: FormationShape,
  index: number,
  count: number,
  spacing: number,
  out: SlotOffset,
): SlotOffset {
  if (index <= 0) {
    out.forward = 0;
    out.right = 0;
    return out;
  }
  switch (shape) {
    case 'column':
      out.forward = -index * spacing;
      out.right = 0;
      return out;
    case 'line': {
      // Centre the line on the leader: e.g. count 4 → offsets at
      // -1.5, -0.5, +0.5, +1.5 spacings (leader is index 0 at -1.5? no — the
      // leader anchors the centre, members fan to one side then the other).
      out.forward = 0;
      // Alternate sides so the line grows symmetrically around the leader.
      const side = index % 2 === 1 ? 1 : -1;
      const rank = Math.ceil(index / 2);
      out.right = side * rank * spacing;
      return out;
    }
    case 'wedge':
    default: {
      const side = index % 2 === 1 ? 1 : -1; // odd → starboard, even → port
      const rank = Math.ceil(index / 2);
      out.forward = -rank * spacing;
      out.right = side * rank * spacing;
      return out;
    }
  }
}

/** Rotate + translate a local slot offset into a world pose at the leader's
 *  pose. */
export function formationSlotWorldPose(
  leaderX: number,
  leaderY: number,
  leaderAngle: number,
  offset: SlotOffset,
  out: WorldPoint,
): WorldPoint {
  const sin = Math.sin(leaderAngle);
  const cos = Math.cos(leaderAngle);
  // forward axis (-sin, cos); right axis (cos, sin).
  out.x = leaderX + offset.forward * -sin + offset.right * cos;
  out.y = leaderY + offset.forward * cos + offset.right * sin;
  return out;
}
