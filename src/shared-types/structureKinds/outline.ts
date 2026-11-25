/**
 * Structure outline — the per-kind outline family and `structureOutline`.
 */
import { DEFAULT_STRUCTURE_KIND, getStructureKind, isStructureKindId } from './lookup.js';
import type { StructureKindId } from './types.js';

// ── Structure outline (structure-restyle plan §2, §8) ──────────────────────
// A structure's FORM is an OUTLINE polygon inside its footprint box: never a
// square or rectangle; line nodes (`connector`) are flat-top hexagons. The
// family table below is the single piece of per-kind shape data;
// `structureOutline` turns it into points. It is THE shape seam: the art draws
// it, and Stage 3 flips `structureHullPoints` (the collider) onto it, so what
// you SEE is what you HIT. Outlines may be CONCAVE (the `cluster` family), so
// the collider flip must run them through `convexParts` in
// `core/geometry/shipHullDecomp.ts` (shared-types cannot import core, so that
// call lives on the core side).

/** The outline families. `hex`: a regular flat-top hexagon. `chamfer`: the
 *  footprint box with all four corners cut (each cut seeded, so it can be
 *  asymmetric). `cluster`: an irregular faceted blob (star-shaped about the
 *  origin, may be concave). */
export type StructureOutlineFamily = 'hex' | 'chamfer' | 'cluster';

/** Per-kind outline family. A full `Record`, so a new kind cannot ship without
 *  a shape. Style variants vary the seeded details via `styleId`. */
export const STRUCTURE_OUTLINE_FAMILY: Readonly<Record<StructureKindId, StructureOutlineFamily>> =
  Object.freeze({
    capital: 'cluster',
    connector: 'hex',
    solar: 'chamfer',
    miner: 'cluster',
    turret: 'chamfer',
    battery: 'chamfer',
    shield_pylon: 'chamfer',
    laser_bolt_turret: 'chamfer',
    missile_turret: 'hex',
    cargo_bay: 'chamfer',
    shield_gate: 'chamfer',
    shield_airlock: 'chamfer',
    gas_collector: 'cluster',
    reclaimer: 'cluster',
    smelter: 'cluster',
    refinery: 'cluster',
    silicon_works: 'chamfer',
    hydroponics: 'cluster',
    fabricator: 'chamfer',
    munitions_works: 'chamfer',
    freight_dock: 'chamfer',
    deep_core_rig: 'cluster',
    ore_processing_complex: 'cluster',
    assembly_plant: 'chamfer',
    research_lab: 'cluster',
    autocannon_turret: 'chamfer',
    reactor: 'chamfer',
    battery_bank: 'chamfer',
    storage_vault: 'chamfer',
    shipyard: 'chamfer',
    habitat_module: 'cluster',
    tower_module: 'chamfer',
    mine_layer: 'chamfer',
    teleporter: 'hex',
    teleporter_large: 'hex',
    alien_gate: 'cluster',
    pocket_pad: 'chamfer',
    aa_quad_40mm: 'chamfer',
    dp_mount_5in: 'chamfer',
    coastal_casemate_8in: 'chamfer',
    coastal_turret_11in: 'chamfer',
    coastal_barbette_16in: 'chamfer',
    coastal_lindemann: 'chamfer',
    siege_gun_80cm: 'chamfer',
    territory_lock: 'chamfer',
    road: 'hex',
  });

/** FNV-1a 32-bit: a stable seed from the kind + style ids. */
function outlineSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32: a tiny deterministic PRNG (same seed, same stream on every
 *  Node / Chromium load). */
function outlineRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type OutlinePoint = { x: number; y: number };

/** Regular flat-top hexagon, the largest that fits in `hw × hh`. CCW from +x. */
function hexOutline(hw: number, hh: number): OutlinePoint[] {
  const r = Math.min(hw, hh / (Math.sqrt(3) / 2));
  const pts: OutlinePoint[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

/** The footprint box with each corner cut by 18–32 % of the short half-side
 *  (seeded per corner, so asymmetric). 8 vertices, convex, CCW. */
function chamferOutline(hw: number, hh: number, rand: () => number): OutlinePoint[] {
  const s = Math.min(hw, hh);
  const cut = (): number => s * (0.18 + 0.14 * rand());
  const c0 = cut();
  const c1 = cut();
  const c2 = cut();
  const c3 = cut();
  return [
    { x: hw - c0, y: -hh }, // bottom-right corner
    { x: hw, y: -hh + c0 },
    { x: hw, y: hh - c1 }, // top-right corner
    { x: hw - c1, y: hh },
    { x: -hw + c2, y: hh }, // top-left corner
    { x: -hw, y: hh - c2 },
    { x: -hw, y: -hh + c3 }, // bottom-left corner
    { x: -hw + c3, y: -hh },
  ];
}

/** An irregular faceted cluster: 9–12 vertices at increasing polar angle on a
 *  squarish superellipse inscribed in the box, each pulled in by a seeded
 *  0–22 %. Star-shaped about the origin with strictly increasing angles, so
 *  simple and CCW; every point is on/inside the superellipse, so inside the
 *  box. */
function clusterOutline(hw: number, hh: number, rand: () => number): OutlinePoint[] {
  const n = 9 + Math.floor(rand() * 4);
  const step = (Math.PI * 2) / n;
  const phase = rand() * step;
  const pts: OutlinePoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + i * step + (rand() - 0.5) * step * 0.5;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const k = 1 - 0.22 * rand();
    pts.push({
      x: k * hw * Math.sign(c) * Math.abs(c) ** 0.6,
      y: k * hh * Math.sign(s) * Math.abs(s) ** 0.6,
    });
  }
  return pts;
}

/** Style C ("shipyard brutalist", restyle 1i): ORDER, not chaos. The footprint
 *  box with all four corners cut by the SAME amount, so the outline is convex
 *  and symmetric about both axes (8 vertices, CCW). Cluster-family kinds get a
 *  deeper cut (a near-regular octagon) instead of a lumpy blob. */
function symmetricChamferOutline(hw: number, hh: number, deep: boolean): OutlinePoint[] {
  const c = Math.min(hw, hh) * (deep ? 0.36 : 0.22);
  return [
    { x: hw - c, y: -hh },
    { x: hw, y: -hh + c },
    { x: hw, y: hh - c },
    { x: hw - c, y: hh },
    { x: -hw + c, y: hh },
    { x: -hw, y: hh - c },
    { x: -hw, y: -hh + c },
    { x: -hw + c, y: -hh },
  ];
}

/**
 * The structure's OUTLINE: a deterministic polygon in local GAME space (Y-up,
 * centred on the structure, unrotated), CCW (positive shoelace area), simple,
 * at least 5 vertices, never an axis-aligned rectangle, and inside the kind's
 * footprint box. `styleId` (optional) re-seeds the irregular details (chamfer
 * cuts, cluster facets) so a style can vary its look; the family is per kind.
 * Style `c` is the exception: clean symmetric chamfers (hex stays the hex),
 * never seeded or lumpy (`symmetricChamferOutline`).
 * Unknown kind ⇒ the Capital's outline, the same forgiving stance as
 * `getStructureKind`. Returns a FRESH array (callers may mutate it). Called at
 * sprite-create / entity-spawn, never in a hot loop.
 */
export function structureOutline(
  kindId: string | null | undefined,
  styleId?: string,
): OutlinePoint[] {
  const id = kindId != null && isStructureKindId(kindId) ? kindId : DEFAULT_STRUCTURE_KIND;
  const { w, h } = getStructureKind(id).footprint;
  const hw = w / 2;
  const hh = h / 2;
  const family = STRUCTURE_OUTLINE_FAMILY[id];
  if (styleId === 'c' && family !== 'hex') return symmetricChamferOutline(hw, hh, family === 'cluster');
  const rand = outlineRng(outlineSeed(`${id}/${styleId ?? ''}`));
  switch (family) {
    case 'hex':
      return hexOutline(hw, hh);
    case 'chamfer':
      return chamferOutline(hw, hh, rand);
    case 'cluster':
      return clusterOutline(hw, hh, rand);
  }
}
