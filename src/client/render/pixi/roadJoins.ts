/**
 * Base platforms slice 31 — road JOINS (derived, render only). A road deck
 * tile draws a carriageway ARM from its hex centre to each of its six edge
 * midpoints where the hex beyond is a road too, or where a shield gate stands
 * on that seam (`deckGateRoad.ts`). With no such arm it draws its own straight
 * (local ±y, edge-mid to edge-mid at its snapped turn, `roadTurnDeg`); with
 * one, a straight through it (that arm and the opposite edge), so a dead end
 * never shows a junction. Three or more joins make a junction.
 *
 * The arms are drawn by the road's body-status hook
 * (`structureStyleC.transport.road.ts`, the socket-nub overlay, one shared
 * context per arm mask), so the mask is in the road's LOCAL frame: slot `j`
 * points at Pixi-local angle 30° + 60°·j (the edge midpoints of the deck hex
 * once the flat-top tile sits at 30° + 60°·k).
 *
 * The table is rebuilt only when a road or gate is added, moved, turned or
 * removed: per frame {@link syncRoadJoins} folds the deck's roads and gates
 * into one integer (no allocation, invariant #14) and compares it.
 */
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { pixelToAxialInto, type AxialHex } from '../../../core/hex/hex.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE, deckHexCentreInto } from '../../../core/hex/plates.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { DECK_ROAD_KIND } from '../../../core/structures/deckGateRoad.js';
import { DECK_FENCE_GATE_KIND } from '../../../core/structures/deckLinks.js';
import { rebuildRoadLamps, resetRoadLamps } from './roadLampLights.js';

/** Local arm slots of the lone straight: Pixi-local 90° and 270° (j = 1, 4). */
export const ROAD_STRAIGHT_MASK = (1 << 1) | (1 << 4);

/** One road tile, game frame (y up): centre, turn (degrees CCW), build mirror. */
export interface RoadPiece { id: number; x: number; y: number; rotDeg: number; mirror: boolean }
/** One shield gate: its centre (a seam midpoint). */
export interface GatePoint { x: number; y: number }

/** Set bits in a 6-bit mask. */
export function armCount(mask: number): number {
  let n = 0;
  for (let j = 0; j < 6; j++) n += (mask >> j) & 1;
  return n;
}

/** The local arm slot (0..5) a WORLD edge direction `i` (game angle 60°·i)
 *  falls in for a road turned `rotDeg`, mirrored or not. */
export function localArmSlot(i: number, rotDeg: number, mirror: boolean): number {
  // Pixi-local angle φ of game angle θ: sprite.rotation = -rot, scale.x = ±1.
  let phi = rotDeg - 60 * i;
  if (mirror) phi = 180 - phi;
  return ((Math.round((phi - 30) / 60) % 6) + 6) % 6;
}

const hexKey = (q: number, r: number): number => (q + 0x8000) * 0x10000 + (r + 0x8000);

/**
 * The WORLD join mask of each road (bit `i`: the edge at game angle 60°·i has
 * a road beyond it or a gate on it). Cold path (allocates).
 */
export function roadWorldJoins(roads: readonly RoadPiece[], gates: readonly GatePoint[]): Map<number, number> {
  const h: AxialHex = { q: 0, r: 0 };
  const c = { x: 0, y: 0 };
  const roadHexes = new Set<number>();
  for (const p of roads) { pixelToAxialInto(p.x, p.y, DECK_HEX_SIZE, h); roadHexes.add(hexKey(h.q, h.r)); }
  // Gate seams, as (hex, edge) bits on both hexes of the seam.
  const gateEdges = new Map<number, number>();
  const tol = DECK_HEX_INRADIUS * 0.05;
  for (const g of gates) {
    pixelToAxialInto(g.x, g.y, DECK_HEX_SIZE, h);
    deckHexCentreInto(h.q, h.r, c);
    const vx = g.x - c.x, vy = g.y - c.y;
    if (Math.abs(Math.hypot(vx, vy) - DECK_HEX_INRADIUS) > tol) continue; // not on a seam midpoint
    const i = ((Math.round((Math.atan2(vy, vx) * 180) / Math.PI / 60) % 6) + 6) % 6;
    const ka = hexKey(h.q, h.r);
    gateEdges.set(ka, (gateEdges.get(ka) ?? 0) | (1 << i));
    pixelToAxialInto(c.x + 2 * vx, c.y + 2 * vy, DECK_HEX_SIZE, h);
    const kb = hexKey(h.q, h.r);
    gateEdges.set(kb, (gateEdges.get(kb) ?? 0) | (1 << ((i + 3) % 6)));
  }
  const out = new Map<number, number>();
  for (const p of roads) {
    pixelToAxialInto(p.x, p.y, DECK_HEX_SIZE, h);
    deckHexCentreInto(h.q, h.r, c);
    let mask = gateEdges.get(hexKey(h.q, h.r)) ?? 0;
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      pixelToAxialInto(c.x + DECK_HEX_FLAT * Math.cos(a), c.y + DECK_HEX_FLAT * Math.sin(a), DECK_HEX_SIZE, h);
      if (roadHexes.has(hexKey(h.q, h.r))) mask |= 1 << i;
    }
    out.set(p.id, mask);
  }
  return out;
}

/** The LOCAL arm mask a road draws: no join = its own straight; one join = a
 *  straight through it (that arm and the opposite one, never a junction);
 *  two or more = just the joins. */
export function roadLocalArms(worldJoins: number, rotDeg: number, mirror: boolean): number {
  let m = 0;
  for (let i = 0; i < 6; i++) if ((worldJoins >> i) & 1) m |= 1 << localArmSlot(i, rotDeg, mirror);
  const n = armCount(m);
  if (n === 0) return ROAD_STRAIGHT_MASK;
  if (n === 1) for (let j = 0; j < 6; j++) if ((m >> j) & 1) return m | (1 << ((j + 3) % 6));
  return m;
}

/** Every road's LOCAL arm mask, by entity id (cold path). `unmirrored`
 *  (lit deck spike): the same masks as if no road were mirrored, for the lit
 *  bake, whose mesh is counter-flipped (a lit mesh never takes a negative scale). */
export function deriveRoadArms(roads: readonly RoadPiece[], gates: readonly GatePoint[], out: Map<number, number>, unmirrored?: Map<number, number>): Map<number, number> {
  out.clear();
  unmirrored?.clear();
  const joins = roadWorldJoins(roads, gates);
  for (const p of roads) {
    out.set(p.id, roadLocalArms(joins.get(p.id) ?? 0, p.rotDeg, p.mirror));
    unmirrored?.set(p.id, roadLocalArms(joins.get(p.id) ?? 0, p.rotDeg, false));
  }
  return out;
}

// ── Live table ──────────────────────────────────────────────────────────────

/** Road entity id → local arm mask (the hook's code reads it). */
const ARMS = new Map<number, number>();
/** Road entity id → its arm mask ignoring the build mirror (the lit bake's). */
const LIT_ARMS = new Map<number, number>();
let signature = 0;
let sigAcc = 0;
let sigSwarm: ReadonlyMap<number, SwarmRenderState> | undefined;

function mix(h: number, n: number): number {
  return Math.imul(h ^ (n | 0), 16777619);
}

function foldOne(st: StructureRenderState, id: number): void {
  const a = sigSwarm!.get(id);
  if (a === undefined || (a.shipKind !== DECK_ROAD_KIND && a.shipKind !== DECK_FENCE_GATE_KIND)) return;
  sigAcc = mix(mix(mix(mix(mix(sigAcc, id), Math.round(a.x)), Math.round(a.y)), Math.round(a.angle * 1000)), st.mirror === true ? 1 : 0);
}

/** The local arm mask of road `id` (its lone straight until the table has it). */
export function roadArmsOf(id: number | undefined): number {
  return (id === undefined ? undefined : ARMS.get(id)) ?? ROAD_STRAIGHT_MASK;
}

/** Road `id`'s arm mask for its lit bake: as {@link roadArmsOf}, but in the
 *  UNMIRRORED local frame (its lit mesh is counter-flipped on a mirrored road). */
export function roadLitArmsOf(id: number): number {
  return LIT_ARMS.get(id) ?? ROAD_STRAIGHT_MASK;
}

/** Per frame on a deck room: rebuild the arm table when a road or gate
 *  changed. Unchanged frame: one fold over the structure rows, no allocation. */
export function syncRoadJoins(
  structures: ReadonlyMap<number, StructureRenderState> | undefined,
  swarm: ReadonlyMap<number, SwarmRenderState> | undefined,
): void {
  if (structures === undefined || swarm === undefined) return;
  sigAcc = 2166136261;
  sigSwarm = swarm;
  structures.forEach(foldOne);
  sigSwarm = undefined;
  if (sigAcc === signature) return;
  signature = sigAcc;
  rebuild(structures, swarm);
}

function rebuild(structures: ReadonlyMap<number, StructureRenderState>, swarm: ReadonlyMap<number, SwarmRenderState>): void {
  const roads: RoadPiece[] = [];
  const gates: GatePoint[] = [];
  structures.forEach((st, id) => {
    const a = swarm.get(id);
    if (a === undefined) return;
    if (a.shipKind === DECK_ROAD_KIND) roads.push({ id, x: a.x, y: a.y, rotDeg: (a.angle * 180) / Math.PI, mirror: st.mirror === true });
    else if (a.shipKind === DECK_FENCE_GATE_KIND) gates.push({ x: a.x, y: a.y });
  });
  deriveRoadArms(roads, gates, ARMS, LIT_ARMS);
  rebuildRoadLamps(roads, LIT_ARMS); // lit deck: the lamps light the deck (roadLampLights.ts)
}

/** Test hook: forget the live table. */
export function resetRoadJoins(): void {
  ARMS.clear();
  LIT_ARMS.clear();
  resetRoadLamps();
  signature = 0;
}
