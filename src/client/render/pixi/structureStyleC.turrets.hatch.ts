/**
 * Style C turrets family: the beam turret's pop-up hatch art (the
 * `sandbox-door-turret` rig, core/articulation/rigs/turrets.ts), drawn through
 * the rig's `partArt` hook (`RigDrawHook`, structureRigLook.ts) in the
 * gun-pad language of structureStyleC.turrets.pad.ts: dark SLAB armour, a
 * SLAB_DARK collar, rivets, blue TRIM lamps, soot. The two hatch leaves are
 * armour plates; the riser is a dark octagonal turntable the gun (drawn on
 * top by the gun forge) sits on. One shared context per (rig, part), built on
 * first use; posing only transforms it (invariant #14).
 */
import { GraphicsContext } from 'pixi.js';
import type { Rig } from '../../../core/articulation/rig.js';
import { HAZARD, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT } from './structureStyleKit.js';
import { TRIM, TRIM_DEAD } from './structureStyleC.turrets.pad.js';

/** Hard outline (the rig parts' edge) and a worn, scuffed metal lip. */
const EDGE = 0x0a0c0e;
const WORN = 0x6a6f74;

const hatchContexts = new Map<string, GraphicsContext | null>();
const hatchLitContexts = new Map<string, GraphicsContext | null>();

/** The riser's two blue trim lamps, fore and aft on the deck between the
 *  collar and the rim (pixi frame, before the lift scale), and their radius. */
const RISER_LAMPS: readonly (readonly [number, number])[] = [[0, -16.5], [0, 16.5]];
const RISER_LAMP_R = 1.6;

/** Pixi-frame (y-down) points of a game-frame outline, flat. */
function pixiFlat(o: readonly number[], k = 1): number[] {
  const out: number[] = [];
  for (let j = 0; j < o.length; j += 2) out.push(o[j]! * k, -o[j + 1]! * k);
  return out;
}

/** A small blue trim lamp as baked: dark bezel, dead glass (the pad's
 *  unpowered lamps). Its light is the riser's lit overlay (`litLamp`). */
function deadLamp(g: GraphicsContext, x: number, y: number, r: number): void {
  g.circle(x, y, r * 1.25).fill({ color: EDGE });
  g.circle(x, y, r).fill({ color: TRIM_DEAD });
}

/** A trim lamp's light over its dead glass: soft halo, lit glass. */
function litLamp(g: GraphicsContext, x: number, y: number, r: number): void {
  g.circle(x, y, r * 2.2).fill({ color: TRIM, alpha: 0.14 });
  g.circle(x, y, r).fill({ color: TRIM, alpha: 0.9 });
}

/** A rivet head with a dark rim, readable at play zoom. */
function rivet(g: GraphicsContext, x: number, y: number, r = 1.5): void {
  g.circle(x, y, r + 0.6).fill({ color: EDGE, alpha: 0.7 });
  g.circle(x, y, r).fill({ color: RIVET });
}

/** A hatch leaf: a dark armour plate, a recessed inner panel, a rivet row
 *  along the outer side, hinge / rail blocks on the outer edge and a worn
 *  lip with a narrow dull warning stripe on the meeting edge. */
function drawLeaf(g: GraphicsContext, o: readonly number[], meetRight: boolean): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < o.length; j += 2) {
    x0 = Math.min(x0, o[j]!); x1 = Math.max(x1, o[j]!);
    y0 = Math.min(y0, -o[j + 1]!); y1 = Math.max(y1, -o[j + 1]!);
  }
  const w = x1 - x0, h = y1 - y0;
  // The plate, with a lighter bevel on its top face.
  g.rect(x0, y0, w, h).fill({ color: SLAB });
  g.rect(x0 + 1.5, y0 + 1.5, w - 3, 3).fill({ color: SLAB_LIGHT, alpha: 0.7 });
  // The recessed panel (inset from the meeting stripe and the hinge side).
  const meetX = meetRight ? x1 : x0, outX = meetRight ? x0 : x1, s = meetRight ? -1 : 1;
  const px0 = Math.min(meetX + s * 6, outX - s * 7), px1 = Math.max(meetX + s * 6, outX - s * 7);
  g.rect(px0, y0 + 6, px1 - px0, h - 12).fill({ color: SLAB_DARK }).stroke({ color: EDGE, width: 1.6 });
  g.moveTo(px0 + 1.5, y0 + 7.5).lineTo(px1 - 1.5, y0 + 7.5).stroke({ color: WORN, width: 1, alpha: 0.45 });
  // A cross rib across the panel's middle.
  g.rect(px0, (y0 + y1) / 2 - 1.5, px1 - px0, 3).fill({ color: SLAB });
  // Grime streak down the panel.
  g.rect(px0 + (px1 - px0) * 0.35, y0 + 9, 2.5, h * 0.4).fill({ color: SOOT, alpha: 0.35 });
  // The meeting edge: a worn steel lip, a narrow dull warning stripe, a
  // dark seam so the split reads the moment the leaves part.
  const lipX = meetRight ? x1 - 4.5 : x0;
  g.rect(lipX, y0, 4.5, h).fill({ color: WORN, alpha: 0.85 });
  const stX = meetRight ? x1 - 4 : x0 + 1.5;
  for (let y = y0 + 3; y + 4 <= y1 - 3; y += 8) g.rect(stX, y, 2.5, 4).fill({ color: HAZARD, alpha: 0.75 });
  g.moveTo(meetX, y0).lineTo(meetX, y1).stroke({ color: EDGE, width: 2.6 });
  // Hinge / rail blocks on the outer edge.
  const bx = meetRight ? x0 - 1 : x1 - 4;
  for (const by of [y0 + 4, y1 - 12]) {
    g.rect(bx, by, 5, 8).fill({ color: SLAB_DARK }).stroke({ color: EDGE, width: 1.2 });
    rivet(g, bx + 2.5, by + 4, 1.1);
  }
  // A rivet row down the outer side of the panel.
  const rx = outX - s * 3.8;
  for (let y = y0 + 16; y <= y1 - 16 + 0.01; y += (h - 32) / 2) rivet(g, rx, y);
  g.rect(x0, y0, w, h).stroke({ color: EDGE, width: 2.2 });
}

/** The riser: a dark gunmetal octagonal turntable, a SLAB_DARK collar ring
 *  with a bolt circle and two blue trim lamps (dead glass; lit by the
 *  overlay while powered), and a dark soot centre the gun
 *  sits on (no paint under the gun). */
function drawRiser(g: GraphicsContext, o: readonly number[]): void {
  const outer = pixiFlat(o);
  g.poly(outer, true).fill({ color: SLAB });
  // Bevel: a lighter lip just inside the rim.
  g.poly(pixiFlat(o, 0.9), true).stroke({ color: SLAB_LIGHT, width: 1.6, alpha: 0.8 });
  // The collar ring and the turntable inside it.
  g.circle(0, 0, 13.5).fill({ color: SLAB_DARK }).stroke({ color: EDGE, width: 1.6 });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    rivet(g, Math.cos(a) * 11.2, Math.sin(a) * 11.2, 1.2);
  }
  g.circle(0, 0, 9).fill({ color: SOOT }).stroke({ color: EDGE, width: 1.2 });
  g.circle(0, 0, 6).stroke({ color: SLAB, width: 1.5, alpha: 0.8 });
  // Blue trim lamps fore and aft on the deck between collar and rim, baked
  // dark; their light is the lit overlay (`turretHatchLitContext`).
  for (const [x, y] of RISER_LAMPS) deadLamp(g, x, y, RISER_LAMP_R);
  g.poly(outer, true).stroke({ color: EDGE, width: 2.2 });
}

/** The beam turret hatch rig's own art for part `i` (the riser and the two
 *  leaves), or null for any other part (it keeps its role art). */
export function turretHatchPartContext(rig: Rig, i: number): GraphicsContext | null {
  const part = rig.parts[i];
  if (part === undefined) return null;
  const key = `${rig.id}/${part.id}`;
  const hit = hatchContexts.get(key);
  if (hit !== undefined) return hit;
  const o = part.outline;
  let g: GraphicsContext | null = null;
  if (o !== undefined && o.length >= 6) {
    if (part.joint.type === 'lift') {
      g = new GraphicsContext();
      drawRiser(g, o);
    } else if (part.joint.type === 'slide') {
      // The meeting edge faces against the slide: a leaf sliding −x meets on its +x side.
      g = new GraphicsContext();
      drawLeaf(g, o, (part.joint.axisX ?? 1) < 0);
    }
  }
  hatchContexts.set(key, g);
  return g;
}

/** The beam turret hatch rig's lit overlay for part `i` (its `partLit`
 *  hook): the riser's trim lamps lit, shown only while the turret is
 *  powered; null for any other part. One shared context per (rig, part). */
export function turretHatchLitContext(rig: Rig, i: number): GraphicsContext | null {
  const part = rig.parts[i];
  if (part === undefined) return null;
  const key = `${rig.id}/${part.id}`;
  const hit = hatchLitContexts.get(key);
  if (hit !== undefined) return hit;
  let g: GraphicsContext | null = null;
  const o = part.outline;
  if (part.joint.type === 'lift' && o !== undefined && o.length >= 6) {
    g = new GraphicsContext();
    for (const [x, y] of RISER_LAMPS) litLamp(g, x, y, RISER_LAMP_R);
  }
  hatchLitContexts.set(key, g);
  return g;
}
