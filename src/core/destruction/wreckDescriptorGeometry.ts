/**
 * Wreck descriptor → piece geometry (capital-destruction.md §S2b, §S4
 * "Re-split"): the pure resolver that turns a `WreckDescriptor` (and, for a
 * child, its `parentWreck` ancestor chain) into the deterministic pieces the
 * server fractured. Shared by both sides: the client's `WreckGeometryStore`
 * rebuilds the wire's wrecks with it, and the server's wreck restore reuses
 * it for saved wrecks. The ancestor lookup is a parameter, so each caller
 * brings its own wreck set (a live store, a saved list, a test map).
 *
 * Pure and side-effect free; it allocates only when it fractures (once per
 * wreck at the caller's cache), never on a per-frame path.
 */
import { wreckPieceGeometry } from './wreckPieces.js';
import { wreckChildGeometry, wreckChildSeed, type WreckChildStep } from './wreckChildren.js';
import { FRACTURE_ALGO_VERSION } from './fractureHull.js';
import type { WreckFractureInputs, WreckPieceGeometry } from './wreckPieceFrame.js';
import { isShipKindId, type ShipKindId } from '../../shared-types/shipKinds.js';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor,
} from '../../shared-types/messages/wreckDescriptor.js';
import type { ChunkOpts } from '../terrain/fieldLayout.js';

/** Deepest child chain the resolver walks (a guard against a parent cycle
 *  on a malformed wire or save; real chains are a few breaks deep). */
export const MAX_WRECK_CHAIN_DEPTH = 16;

/** Finds a wreck's descriptor by id (undefined when not known). */
export type WreckDescriptorLookup = (wreckId: number) => WreckDescriptor | undefined;

/** A root descriptor's source: its rock (rock cut), its structure
 *  (structure break-up), else its ship kind. A cut-field rock (`rock.fk`)
 *  takes the caller's room field options. */
function rootSource(
  d: WreckDescriptor, field: ChunkOpts | null | undefined,
): Pick<WreckFractureInputs, 'kindId' | 'rock' | 'structure'> {
  if (d.structure !== undefined) return { structure: d.structure };
  if (d.rock === undefined) return { kindId: d.parentKind as ShipKindId };
  return d.rock.fk !== undefined ? { rock: { ...d.rock, field } } : { rock: d.rock };
}

/** The step a child descriptor names (its break of its parent's piece). */
function stepOf(d: WreckDescriptor): WreckChildStep {
  return {
    pieceIndex: d.parentPiece!, killX: d.killX, killY: d.killY, cutKind: d.cutKind, cutAng: d.cutAng, cutW: d.cutW,
    extraCuts: d.extraCuts,
  };
}

/**
 * The pieces of a child descriptor, resolving its chain through `lookup`.
 * Null when an ancestor is unknown, the chain is deeper than
 * `MAX_WRECK_CHAIN_DEPTH`, or a link disagrees with its parent (kind,
 * fracture version, or a seed that is not
 * `wreckChildSeed(parent.seed, parentPiece)`). `ancOut`, when given, gets the
 * ancestor descriptors parent first. `field`: the room's cut-field options
 * (a field rock's root needs them; null when the room has no field).
 */
export function resolveChildWreckPieces(
  d: WreckDescriptor,
  lookup: WreckDescriptorLookup,
  ancOut?: WreckDescriptor[],
  field?: ChunkOpts | null,
): WreckPieceGeometry[] | null {
  const steps: WreckChildStep[] = [];
  let cur = d;
  while (cur.parentWreck !== undefined) {
    if (steps.length >= MAX_WRECK_CHAIN_DEPTH) return null;
    const p = lookup(cur.parentWreck);
    if (p === undefined || p.parentKind !== cur.parentKind || p.algoVersion !== cur.algoVersion
      || cur.seed !== wreckChildSeed(p.seed, cur.parentPiece!)) return null;
    steps.push(stepOf(cur));
    ancOut?.push(p);
    cur = p;
  }
  steps.reverse();
  if (cur.parentKind === WRECK_ROCK_PARENT_KIND && cur.rock === undefined) return null;
  if (cur.parentKind === WRECK_STRUCTURE_PARENT_KIND && cur.structure === undefined) return null;
  if (cur.rock?.fk !== undefined && (field === undefined || field === null)) return null;
  return wreckChildGeometry({
    root: {
      ...rootSource(cur, field), seed: cur.seed, killX: cur.killX, killY: cur.killY,
      killBlowDamage: cur.killBlowDamage, recentDamageRate: cur.recentDamageRate, snapChance: cur.snapChance,
      cutKind: cur.cutKind, cutAng: cur.cutAng, cutW: cur.cutW, extraCuts: cur.extraCuts,
    },
    steps,
  });
}

/** Is this descriptor one this build can rebuild? A rock's wreck (rock
 *  cut) names `WRECK_ROCK_PARENT_KIND`; its root carries the rock. A
 *  structure's names `WRECK_STRUCTURE_PARENT_KIND`; its root carries the
 *  structure. */
export function wreckDescriptorUsable(d: WreckDescriptor): boolean {
  if (d.algoVersion !== FRACTURE_ALGO_VERSION) return false;
  if (d.parentKind === WRECK_ROCK_PARENT_KIND) return d.rock !== undefined || d.parentWreck !== undefined;
  if (d.parentKind === WRECK_STRUCTURE_PARENT_KIND) return d.structure !== undefined || d.parentWreck !== undefined;
  return isShipKindId(d.parentKind);
}

/** The deterministic pieces of one root wreck. `field`: the room's
 *  cut-field options (a field rock needs them; throws without). */
export function rebuildWreckPieces(d: WreckDescriptor, field?: ChunkOpts | null): WreckPieceGeometry[] {
  return wreckPieceGeometry({
    ...rootSource(d, field),
    seed: d.seed,
    killX: d.killX,
    killY: d.killY,
    killBlowDamage: d.killBlowDamage,
    recentDamageRate: d.recentDamageRate,
    snapChance: d.snapChance,
    // The v9 kill cut rides as-is (absent = no cut).
    cutKind: d.cutKind,
    cutAng: d.cutAng,
    cutW: d.cutW,
    // v12 multi-cut: the other beams' lines, as-is too.
    extraCuts: d.extraCuts,
  });
}
