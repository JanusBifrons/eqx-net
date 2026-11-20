/**
 * Style C family "turrets" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Turrets: turret, laser bolt, missile, autocannon, mine layer.
 * The small guns are drawn here, the missile turret and mine layer in
 * structureStyleC.turretsHeavy.ts, all on the shared pad
 * (structureStyleC.turrets.pad.ts); `kinds` (both files) is spread into
 * `STYLE_C` (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 *
 * Only the BASE is drawn here. The turning gun (ring, barrel) is
 * `turretLayout.ts` (ring = R × 0.34 × 1.3, R = half the short side) and its
 * muzzle `muzzle.ts`; each base leaves a dark well under that ring so the gun
 * reads on top of it. The guns are always out (no hatch) except the beam
 * turret's existing pop-up rig, whose slot draws over the well.
 */
import {
  HAZARD, LAMP_AMBER, LAMP_WHITE, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck, glow,
  lamp, ngon, poly, rivets, stencil, strip, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import { TRIM, TRIM_DEAD, TURRET_WELL, gunPad } from './structureStyleC.turrets.pad.js';
import * as heavy from './structureStyleC.turretsHeavy.js';
import { rigPartIndex } from '../../../core/articulation/rig.js';
import { DOOR_TURRET_MOUNT, SANDBOX_DOOR_TURRET_DEF } from '../../../core/articulation/rigCatalogue.js';
import { rigSlotContext, type RigDrawHookTable } from './structureRigLook.js';
import { turretHatchLitContext, turretHatchPartContext } from './structureStyleC.turrets.hatch.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. It carries the heavy
 *  file's own version, so a change there re-bakes this family too. */
export const version = `t2${heavy.version}`;

export { TURRET_WELL };

/** Beam turret (`turret`, 140 × 140): the plain armoured pad, a dark well
 *  under the gun ring (the pop-up hatch rig's slot draws over it), blue trim
 *  lamps on the rim, amber work lamps on two corners. */
function beamTurret(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  gunPad(c, R, 0.9, 11);
  rivets(c, [-0.5 * R, 0.86 * R], [0.5 * R, 0.86 * R], 0.12 * R, 0.022 * R);
  lamp(c, -0.8 * R, -0.8 * R, 0.04 * R, LAMP_AMBER);
  lamp(c, 0.8 * R, 0.8 * R, 0.04 * R, LAMP_WHITE);
  stencil(c, '12', 0.56 * R, -0.86 * R, 0.13 * R);
  if (c.livery) c.sigils.push({ x: -0.72 * R, y: 0.72 * R, r: 0.09 * R });
}

/** Bolt turret (`laser_bolt_turret`, 150 × 150): the same pad, plus twin
 *  capacitor pods on the ±x sides, cabled in to the collar, their cells lit
 *  blue when powered. */
function boltTurret(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  const trim = c.live ? TRIM : TRIM_DEAD;
  deck(c);
  gunPad(c, R, 0.86, 21);
  for (const s of [-1, 1]) {
    const cx = s * 0.78 * R;
    // Cable run from the collar to the pod.
    for (const dy of [-0.16, 0.16]) poly(c, strip([s * 0.6 * R, dy * R], [cx, dy * R], 0.04 * R), STEEL, 'metal', 20, 0.6);
    core(c, chamferBox(cx - 0.12 * R, -0.36 * R, 0.24 * R, 0.72 * R, 0.07 * R), SLAB_LIGHT, 28, 0);
    poly(c, chamferBox(cx - 0.07 * R, -0.3 * R, 0.14 * R, 0.6 * R, 0.04 * R), SOOT, 'metal', -2, 1);
    for (const cy of [-0.2, 0, 0.2]) {
      glow(c, chamferBox(cx - 0.05 * R, (cy - 0.07) * R, 0.1 * R, 0.14 * R, 0.02 * R), trim, 0.9);
    }
    c.lit(cx, 0, 0.04 * R, trim);
    lamp(c, cx, s * 0.44 * R, 0.035 * R, LAMP_AMBER);
  }
  stencil(c, '14', -0.18 * R, 0.66 * R, 0.12 * R);
  if (c.livery) c.sigils.push({ x: 0.66 * R, y: -0.66 * R, r: 0.08 * R });
}

/** Autocannon turret (`autocannon_turret`, 160 × 160): a squat, heavy
 *  octagon with a thick armour skirt, an ammo feed box on −y (hazard stripe
 *  on its face) and a belt chute running in to the gun ring's edge. */
function autocannonTurret(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  // The skirt: a wider, low octagon under the pad.
  poly(c, ngon(0, 0, 0.94 * R, 8, Math.PI / 8), SLAB_DARK, 'metal', 10, 0.08 * R, { seams: 0.2 * R, seamAngle: 0 });
  gunPad(c, R, 0.8, 31);
  // The feed box on −y.
  const fy = -0.9 * R, fh = 0.3 * R;
  core(c, chamferBox(-0.34 * R, fy, 0.68 * R, fh, 0.06 * R), SLAB_LIGHT, 30, 0);
  poly(c, chamferBox(-0.3 * R, fy + 0.04 * R, 0.6 * R, 0.07 * R, 0.02 * R), HAZARD, 'hazard', 32, 0.6);
  rivets(c, [-0.26 * R, fy + 0.22 * R], [0.26 * R, fy + 0.22 * R], 0.1 * R, 0.02 * R);
  // The belt chute: from the box down to the edge of the gun ring's well,
  // with belt links across it.
  const x0 = 0.12 * R, y0 = fy + fh, y1 = -TURRET_WELL * R;
  poly(c, chamferBox(x0 - 0.07 * R, y0 - 0.02 * R, 0.14 * R, y1 - y0 + 0.02 * R, 0.02 * R), STEEL, 'metal', 27, 0.8);
  for (let y = y0 + 0.03 * R; y < y1 - 0.02 * R; y += 0.035 * R) {
    poly(c, strip([x0 - 0.05 * R, y], [x0 + 0.05 * R, y], 0.012 * R), SOOT, 'metal', 28, 0.3);
  }
  lamp(c, -0.42 * R, fy + 0.1 * R, 0.035 * R, LAMP_AMBER);
  for (const s of [-1, 1]) lamp(c, s * 0.74 * R, 0.5 * R, 0.035 * R, LAMP_WHITE);
  stencil(c, '16', -0.2 * R, 0.62 * R, 0.12 * R);
  if (c.livery) c.sigils.push({ x: 0.6 * R, y: 0.6 * R, r: 0.08 * R });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  turret: beamTurret,
  laser_bolt_turret: boltTurret,
  autocannon_turret: autocannonTurret,
  ...heavy.kinds,
};

/** The pop-up turret's riser lamps light on a built, powered row (the rig's
 *  `running` hook), like the pad's trim lamps (`c.live`). */
export function beamTurretPowered(st: StructureRenderState | undefined): boolean {
  return st !== undefined && st.built && st.powered === true;
}

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts). The pop-up door turret: its gun rides the riser
 *  (`DOOR_TURRET_MOUNT`), a dark hatch slot shows under the leaves, and the
 *  riser and leaves are drawn in the gun-pad armour (turrets.hatch.ts), the
 *  riser's trim lamps lit only while powered (`partLit` + `running`). */
export const rigs: RigDrawHookTable = {
  [SANDBOX_DOOR_TURRET_DEF.id]: {
    mountPart: (rig) => rigPartIndex(rig, DOOR_TURRET_MOUNT.partId),
    planeUnder: (rig) => rigSlotContext(rig),
    partArt: turretHatchPartContext,
    partLit: turretHatchLitContext,
    running: beamTurretPowered,
  },
};
