/**
 * Style C family "coastal" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Coastal guns: AA quad, 5 in, 8 in casemate, 11 in, 16 in barbette, Lindemann, 80 cm siege gun.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 *
 * Only the BASE is drawn. Every gun stands on the turrets family's shared
 * armoured pad (`gunPad`, structureStyleC.turrets.pad.ts) sized to its gun:
 * the naval gunhouse turns on its barbette ring (`turretLayout.ts`
 * `structureTurrets`, ring = the shared `navalTurret` barbette), which sits in
 * the pad's dark well (`COASTAL_WELL`, × R, R = half the short side) with a
 * dark lip. Round the pad, in the same family look: dark armour corner slabs,
 * magazine hatches with hazard edges, vent grilles and blue trim lamps (dead
 * glass unpowered). The casemates (8 in, Lindemann) wall the gun in on the
 * sides with an embrasure sill on the firing side (-y: mount rotation 0 is the
 * structure's +y facing, drawn up); the 16 in barbette has a low glacis across
 * its arc; the 80 cm siege gun sits on a rail carriage.
 */
import {
  DECK, HAZARD, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck, glow, lamp, ngon,
  poly, rivets, stencil, strip, type Pt, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import { TRIM, TRIM_DEAD, gunPad } from './structureStyleC.turrets.pad.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'c1';

/** Each gun's dark well, × R: its barbette ring (`structureTurrets`) plus a
 *  dark lip. The siege gun's ring is wider than its carriage, so its pad and
 *  well are cut to the carriage width (`SIEGE_HALF_W`). */
export const COASTAL_WELL: Readonly<Record<string, number>> = {
  aa_quad_40mm: 0.52,
  dp_mount_5in: 0.58,
  coastal_casemate_8in: 0.64,
  coastal_turret_11in: 0.56,
  coastal_barbette_16in: 0.52,
  coastal_lindemann: 0.55,
  siege_gun_80cm: 1.32,
};
/** The siege gun's pad and well cut, × R (the carriage deck's half width). */
export const SIEGE_HALF_W = 0.7;

/** A blue trim lamp: lit glass when powered, dead glass when not. */
function trim(c: StyleCtx, x: number, y: number, r: number): void {
  glow(c, ngon(x, y, r, 8), c.live ? TRIM : TRIM_DEAD, 0.9);
  lamp(c, x, y, r * 0.85, TRIM);
}

/** `n` trim lamps evenly from `a` to `b`. */
function trimRow(c: StyleCtx, a: Pt, b: Pt, n: number, r: number): void {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    trim(c, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r);
  }
}

/** Dark armour slabs in the four footprint corners, `s` × R square, their
 *  outer corner cut to follow the outline's chamfer. */
function cornerSlabs(c: StyleCtx, R: number, s: number): void {
  const hw = c.W / 2 - 0.04 * R, hh = c.H / 2 - 0.04 * R, w = s * R;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx > 0 ? hw - w : -hw, y = sy > 0 ? hh - w : -hh;
      core(c, chamferBox(x, y, w, w, 0.24 * R), SLAB_DARK, 14, Math.PI / 4);
      poly(c, ngon(x + w / 2, y + w / 2, 0.03 * R, 6), RIVET, 'metal', 16, 0.5);
    }
  }
}

/** A magazine hatch (x, y, w, h): outlined plate, two lift lugs, a hazard
 *  edge on its `edge` side (+1 = +y, -1 = -y). */
function hatch(c: StyleCtx, x: number, y: number, w: number, h: number, edge: 1 | -1): void {
  const b = Math.min(w, h) * 0.12;
  poly(c, chamferBox(x, y, w, h, b), SOOT, 'metal', 22, 0.6);
  poly(c, chamferBox(x + b * 0.6, y + b * 0.6, w - b * 1.2, h - b * 1.2 - h * 0.22, b * 0.6), SLAB_LIGHT, 'metal', 24, 0.8);
  for (const s of [0.28, 0.72]) poly(c, ngon(x + w * s, y + h * 0.36, b * 0.5, 6), RIVET, 'metal', 26, 0.5);
  const hy = edge > 0 ? y + h * 0.78 : y + h * 0.02;
  poly(c, chamferBox(x + b * 0.4, hy, w - b * 0.8, h * 0.2, b * 0.3), HAZARD, 'hazard', 12, 0.5);
}

/** A vent grille (x, y, w, h): a sooty recess with steel slats across its
 *  long side. */
function vent(c: StyleCtx, x: number, y: number, w: number, h: number): void {
  poly(c, chamferBox(x, y, w, h, Math.min(w, h) * 0.2), SOOT, 'metal', -2, 1);
  const across = w < h, n = Math.max(3, Math.round((across ? h : w) / (Math.min(w, h) * 0.6)));
  for (let i = 1; i < n; i++) {
    const t = i / n, m = Math.min(w, h) * 0.12;
    if (across) poly(c, strip([x + m, y + h * t], [x + w - m, y + h * t], Math.min(w, h) * 0.18), STEEL, 'metal', 14, 0.4);
    else poly(c, strip([x + w * t, y + m], [x + w * t, y + h - m], Math.min(w, h) * 0.18), STEEL, 'metal', 14, 0.4);
  }
}

/** The casemate walls (8 in, Lindemann): tall concrete cheek walls down both
 *  sides, front cheek blocks either side of the embrasure, and a low sill
 *  across the embrasure with a hazard lip, on the firing side (-y). */
function casemateWalls(c: StyleCtx, R: number, sill: number): void {
  const hw = c.W / 2, hh = c.H / 2;
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? hw - 0.25 * R : -hw + 0.03 * R;
    core(c, chamferBox(x0, -hh + 0.28 * R, 0.22 * R, hh * 2 - 0.62 * R, 0.06 * R), SLAB_LIGHT, 34, Math.PI / 2);
    vent(c, x0 + 0.05 * R, -0.3 * R, 0.12 * R, 0.5 * R);
    trimRow(c, [x0 + 0.11 * R, 0.35 * R], [x0 + 0.11 * R, hh - 0.5 * R], 2, 0.03 * R);
    // Front cheek block, from the side wall in toward the embrasure.
    const cx0 = s > 0 ? sill * R : -hw + 0.27 * R, cw = hw - 0.27 * R - sill * R;
    core(c, chamferBox(cx0, -hh + 0.04 * R, cw, 0.26 * R, 0.06 * R), SLAB_LIGHT, 30, 0);
    rivets(c, [cx0 + 0.06 * R, -hh + 0.2 * R], [cx0 + cw - 0.06 * R, -hh + 0.2 * R], 0.1 * R, 0.02 * R);
  }
  // The embrasure sill, low enough for the barrel to fire over.
  poly(c, chamferBox(-sill * R, -hh + 0.04 * R, sill * 2 * R, 0.1 * R, 0.03 * R), SLAB_DARK, 'metal', 8, 0.03 * R);
  poly(c, chamferBox(-sill * R + 0.02 * R, -hh + 0.05 * R, sill * 2 * R - 0.04 * R, 0.04 * R, 0.01 * R), HAZARD, 'hazard', 10, 0.5);
}

/** Quad 40 mm AA (`aa_quad_40mm`, 150 × 150): the small pad, ready-ammo
 *  lockers on the four corners, a clip hatch on +y. */
function aaQuad(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  cornerSlabs(c, R, 0.3);
  gunPad(c, R, 0.84, 61, COASTAL_WELL.aa_quad_40mm);
  hatch(c, -0.22 * R, 0.8 * R, 0.44 * R, 0.15 * R, 1);
  lamp(c, -0.84 * R, -0.84 * R, 0.04 * R, LAMP_WHITE);
  stencil(c, '40', -0.08 * R, -0.97 * R, 0.11 * R);
  if (c.livery) c.sigils.push({ x: 0.81 * R, y: 0.81 * R, r: 0.07 * R });
}

/** 5 in DP mount (`dp_mount_5in`, 200 × 200): the pad, corner slabs, a
 *  magazine hatch on +y and vent grilles on both sides. */
function dpMount(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  cornerSlabs(c, R, 0.28);
  gunPad(c, R, 0.86, 71, COASTAL_WELL.dp_mount_5in);
  hatch(c, -0.25 * R, 0.8 * R, 0.5 * R, 0.16 * R, 1);
  for (const s of [-1, 1]) vent(c, s > 0 ? 0.84 * R : -0.95 * R, -0.25 * R, 0.11 * R, 0.5 * R);
  trimRow(c, [-0.3 * R, -0.9 * R], [0.3 * R, -0.9 * R], 3, 0.03 * R);
  stencil(c, '5', -0.86 * R, -0.66 * R, 0.12 * R);
  if (c.livery) c.sigils.push({ x: 0.83 * R, y: 0.83 * R, r: 0.07 * R });
}

/** 8 in casemate (`coastal_casemate_8in`, 360 × 300): the pad between tall
 *  concrete side walls, front cheek blocks and a low embrasure sill on the
 *  firing side, magazine hatches in the rear corners. */
function casemate8(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2, hh = c.H / 2;
  deck(c);
  gunPad(c, R, 0.92, 81, COASTAL_WELL.coastal_casemate_8in);
  casemateWalls(c, R, 0.42);
  for (const s of [-1, 1]) hatch(c, s > 0 ? 0.6 * R : -0.9 * R, hh - 0.3 * R, 0.3 * R, 0.24 * R, 1);
  lamp(c, 0, hh - 0.08 * R, 0.04 * R, LAMP_WHITE);
  stencil(c, '8', -0.06 * R, 0.86 * R, 0.1 * R);
  if (c.livery) c.sigils.push({ x: -0.66 * R, y: -0.5 * R, r: 0.06 * R });
}

/** 11 in triple turret (`coastal_turret_11in`, 420 × 420): trains all round,
 *  so a plain square emplacement: big corner slabs, twin magazine hatches on
 *  +y, vent grilles on both sides, trim along the front. */
function turret11(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  cornerSlabs(c, R, 0.3);
  gunPad(c, R, 0.84, 91, COASTAL_WELL.coastal_turret_11in);
  for (const s of [-1, 1]) hatch(c, s > 0 ? 0.06 * R : -0.36 * R, 0.8 * R, 0.3 * R, 0.16 * R, 1);
  for (const s of [-1, 1]) vent(c, s > 0 ? 0.82 * R : -0.94 * R, -0.3 * R, 0.12 * R, 0.6 * R);
  trimRow(c, [-0.4 * R, -0.88 * R], [0.4 * R, -0.88 * R], 5, 0.025 * R);
  stencil(c, '11', -0.62 * R, -0.95 * R, 0.1 * R);
  if (c.livery) c.sigils.push({ x: 0.82 * R, y: 0.82 * R, r: 0.06 * R });
}

/** 16 in barbette (`coastal_barbette_16in`, 520 × 520): a casemated barbette
 *  with 145° of fire: a low armoured glacis in segments across the arc on
 *  the firing side, tall cheek blocks beyond it, magazine hatches and vents
 *  at the rear. */
function barbette16(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  cornerSlabs(c, R, 0.28);
  gunPad(c, R, 0.8, 101, COASTAL_WELL.coastal_barbette_16in);
  const fwd = -Math.PI / 2, arc = (78 * Math.PI) / 180, n = 9;
  for (let i = 0; i < n; i++) {
    const a0 = fwd - arc + (i * 2 * arc) / n, a1 = a0 + (2 * arc) / n - 0.02;
    const seg = (r0: number, r1: number): Pt[] => [
      [Math.cos(a0) * r0 * R, Math.sin(a0) * r0 * R], [Math.cos(a1) * r0 * R, Math.sin(a1) * r0 * R],
      [Math.cos(a1) * r1 * R, Math.sin(a1) * r1 * R], [Math.cos(a0) * r1 * R, Math.sin(a0) * r1 * R],
    ];
    poly(c, seg(0.84, 0.96), SLAB_DARK, 'metal', 8, 0.03 * R);
    poly(c, seg(0.84, 0.865), HAZARD, 'hazard', 10, 0.5);
  }
  // Cheek blocks just past each end of the arc.
  for (const s of [-1, 1]) core(c, chamferBox(s > 0 ? 0.74 * R : -0.96 * R, -0.12 * R, 0.22 * R, 0.5 * R, 0.05 * R), SLAB_LIGHT, 30, Math.PI / 2);
  for (const s of [-1, 1]) hatch(c, s > 0 ? 0.08 * R : -0.38 * R, 0.8 * R, 0.3 * R, 0.15 * R, 1);
  for (const s of [-1, 1]) vent(c, s > 0 ? 0.5 * R : -0.66 * R, 0.66 * R, 0.16 * R, 0.1 * R);
  trimRow(c, [-0.36 * R, 0.74 * R], [0.36 * R, 0.74 * R], 4, 0.022 * R);
  stencil(c, '16', 0.78 * R, 0.5 * R, 0.08 * R);
  if (c.livery) c.sigils.push({ x: -0.84 * R, y: 0.84 * R, r: 0.05 * R });
}

/** Lindemann super battery (`coastal_lindemann`, 640 × 560): the fortress
 *  casemate. The pad between massive side walls, a rear wall with a dark
 *  entry, front cheeks and an embrasure sill, magazine hatches in both rear
 *  corners. */
function lindemann(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2, hh = c.H / 2;
  deck(c);
  gunPad(c, R, 0.86, 111, COASTAL_WELL.coastal_lindemann);
  casemateWalls(c, R, 0.46);
  // Rear wall either side of the entry.
  for (const s of [-1, 1]) {
    core(c, chamferBox(s > 0 ? 0.16 * R : -0.84 * R, hh - 0.14 * R, 0.68 * R, 0.1 * R, 0.03 * R), SLAB_LIGHT, 32, 0);
    hatch(c, s > 0 ? 0.56 * R : -0.84 * R, 0.56 * R, 0.28 * R, 0.2 * R, -1);
  }
  poly(c, chamferBox(-0.14 * R, hh - 0.13 * R, 0.28 * R, 0.08 * R, 0.02 * R), SOOT, 'metal', -2, 1);
  trimRow(c, [-0.12 * R, hh - 0.18 * R], [0.12 * R, hh - 0.18 * R], 2, 0.022 * R);
  lamp(c, 0, hh - 0.09 * R, 0.035 * R, LAMP_WHITE);
  stencil(c, '40', 0.6 * R, 0.82 * R, 0.07 * R);
  if (c.livery) c.sigils.push({ x: -0.7 * R, y: -0.5 * R, r: 0.05 * R });
}

/** 80 cm siege gun (`siege_gun_80cm`, 300 × 900): the rail carriage. Two
 *  pairs of rails on sleepers down the whole length, a bogie at each end of
 *  each pair, the carriage deck between them with the pad (cut to the deck's
 *  width: the ring is wider than the track) in the middle, a loading hatch
 *  at the rear, a vent at the front and buffer beams at both ends. */
function siegeGun(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2, L = c.H / 2;
  // No full-outline deck: the track bed is the drawn edge, 0.9 R a side, where
  // the kind's side cable sockets sit (`STRUCTURE_SOCKET_OVERRIDES`, ±135 u).
  poly(c, chamferBox(-0.9 * R, -L, 1.8 * R, 2 * L, 0.24 * R), DECK, 'metal', 4, 3, { seams: 32, seamAngle: Math.PI / 2 });
  for (let y = -L + 0.3 * R; y < L - 0.2 * R; y += 0.25 * R) poly(c, strip([-0.88 * R, y], [0.88 * R, y], 0.08 * R), STEEL, 'metal', 3, 0.6);
  for (const x of [-0.78, -0.45, 0.45, 0.78]) poly(c, strip([x * R, -L + 0.12 * R], [x * R, L - 0.12 * R], 0.05 * R), RIVET, 'metal', 6, 0.5);
  // Bogies over each rail pair at both ends, wheel hubs on the rails.
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? 0.3 * R : -0.9 * R, y0 = sy > 0 ? 2.05 * R : -2.75 * R;
      core(c, chamferBox(x0, y0, 0.6 * R, 0.7 * R, 0.08 * R), SLAB, 16, Math.PI / 2);
      for (const x of [0.45, 0.78]) for (const t of [0.2, 0.5, 0.8]) poly(c, ngon(sx * x * R, y0 + t * 0.7 * R, 0.05 * R, 8), RIVET, 'metal', 20, 0.5);
    }
    // Buffer beam with a hazard face.
    const by = sy > 0 ? L - 0.17 * R : -L + 0.07 * R;
    poly(c, chamferBox(-0.6 * R, by, 1.2 * R, 0.1 * R, 0.03 * R), SLAB_LIGHT, 'metal', 14, 0.03 * R);
    poly(c, chamferBox(-0.56 * R, by + 0.025 * R, 1.12 * R, 0.05 * R, 0.01 * R), HAZARD, 'hazard', 16, 0.5);
  }
  core(c, chamferBox(-0.74 * R, -2 * R, 1.48 * R, 4 * R, 0.12 * R), SLAB_DARK, 12, Math.PI / 2);
  gunPad(c, R, 1.8, 121, COASTAL_WELL.siege_gun_80cm, SIEGE_HALF_W);
  hatch(c, -0.4 * R, 1.7 * R, 0.8 * R, 0.24 * R, 1);
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) trim(c, sx * 0.6 * R, sy * 1.84 * R, 0.035 * R);
  vent(c, -0.4 * R, -1.94 * R, 0.8 * R, 0.2 * R);
  stencil(c, '80', -0.14 * R, 2.3 * R, 0.2 * R);
  if (c.livery) c.sigils.push({ x: 0, y: -2.4 * R, r: 0.12 * R });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  aa_quad_40mm: aaQuad,
  dp_mount_5in: dpMount,
  coastal_casemate_8in: casemate8,
  coastal_turret_11in: turret11,
  coastal_barbette_16in: barbette16,
  coastal_lindemann: lindemann,
  siege_gun_80cm: siegeGun,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
