/**
 * Saved wreck lineage (wreck fields plan, slice 0a2a): one plain JSON record
 * per wreck lineage, so battle wrecks can survive a server restart
 * (docs/architecture/capital-destruction.md "Saved lineage record").
 *
 * A lineage is a root wreck (a ship death or a rock break) plus every
 * re-split wreck below it, INCLUDING dead intermediate ancestors that stay
 * only because they have live children (`CapitalWreckSubsystem.retire`), plus
 * every live piece's pose. Nodes go parent-before-child with LOCAL indices:
 * u16 wreck ids are reassigned on restore. No geometry is stored: restore
 * re-runs the fracture from the descriptor fields and chain steps (#15), so a
 * record from another `FRACTURE_ALGO_VERSION` is refused (null).
 *
 * Runs at save / load, never on a hot loop; allocates freely.
 */
import { z } from 'zod';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { ASTEROID_RESOURCE_IDS } from '../../shared-types/asteroidResources.js';
import {
  MAX_WRECK_EXTRA_CUTS, MAX_WRECK_OWNER_LEN, MAX_WRECK_PIECE_INDEX, MAX_WRECK_ROCK_ID_LEN,
  WRECK_ID_END, WRECK_ROCK_PARENT_KIND, WreckExtraCutSchema, WreckRockRefSchema,
  type WreckExtraCut,
} from '../../shared-types/messages/wreckDescriptor.js';
import type { LiveWreck } from './capitalWreckTypes.js';

/** Bump on any change to the record's shape. */
export const WRECK_LINEAGE_RECORD_VERSION = 1;

/** A piece's stored `integrity` when it is infinite (never wears out):
 *  restore maps it back to `Number.POSITIVE_INFINITY`. */
export const WRECK_LINEAGE_UNBREAKABLE = -1;

const u16 = z.number().int().min(0).max(0xffff);
const pieceIndex = z.number().int().min(0).max(MAX_WRECK_PIECE_INDEX);
const cutKind = z.enum(['slice', 'channel']);
const extraCuts = z.array(WreckExtraCutSchema).min(1).max(MAX_WRECK_EXTRA_CUTS);

/** A node's descriptor: `WreckDescriptor` minus `wreckId` / `parentWreck`
 *  (reassigned on restore), `algoVersion` (the record's `fractureAlgo`) and
 *  `deathTick` (a restored wreck is drawn cool). */
const NodeDescSchema = z
  .object({
    parentKind: z.string().min(1).max(64),
    seed: z.number().int().min(0).max(0xffffffff),
    killX: z.number().finite(),
    killY: z.number().finite(),
    killBlowDamage: z.number().finite(),
    recentDamageRate: z.number().finite(),
    snapChance: z.number().finite(),
    cutKind: cutKind.optional(),
    cutAng: u16.optional(),
    cutW: z.number().finite().min(0).optional(),
    extraCuts: extraCuts.optional(),
    parentPiece: pieceIndex.optional(),
    owner: z.string().min(1).max(MAX_WRECK_OWNER_LEN).optional(),
    rock: WreckRockRefSchema.optional(),
  })
  .strict();

/** One break of the chain (`WreckChildStep`). */
const StepSchema = z
  .object({
    pieceIndex,
    killX: z.number().finite(),
    killY: z.number().finite(),
    cutKind: cutKind.optional(),
    cutAng: u16.optional(),
    cutW: z.number().finite().min(0).optional(),
    extraCuts: extraCuts.optional(),
  })
  .strict();

/** `WreckOre`. */
const OreSchema = z
  .object({
    rockId: z.string().min(1).max(MAX_WRECK_ROCK_ID_LEN),
    resource: z.enum(ASTEROID_RESOURCE_IDS),
    perArea: z.number().finite().min(0),
  })
  .strict();

const NodeSchema = z
  .object({
    /** Local index of the parent node; -1 for the root. */
    parent: z.number().int().min(-1),
    desc: NodeDescSchema,
    /** The chain's steps down to this node (`LiveWreck.chain.steps`). */
    steps: z.array(StepSchema).max(WRECK_ID_END),
    ore: OreSchema.optional(),
  })
  .strict();

/** A live piece at rest: its node, its index in that node's pieces, pose,
 *  and its remaining integrity (`PieceKnock.integrity`, so a worn piece
 *  stays worn): `WRECK_LINEAGE_UNBREAKABLE` (-1) for an infinite one (a
 *  kind whose pieces never split; JSON has no Infinity), else finite ≥ 0. */
const PieceSchema = z
  .object({
    node: z.number().int().min(0),
    piece: pieceIndex,
    x: z.number().finite(),
    y: z.number().finite(),
    angle: z.number().finite(),
    integrity: z.union([z.literal(WRECK_LINEAGE_UNBREAKABLE), z.number().finite().min(0)]),
  })
  .strict();

const RecordSchema = z
  .object({
    version: z.literal(WRECK_LINEAGE_RECORD_VERSION),
    fractureAlgo: z.literal(FRACTURE_ALGO_VERSION),
    nodes: z.array(NodeSchema).min(1).max(WRECK_ID_END - 1),
    pieces: z.array(PieceSchema).max(WRECK_ID_END * (MAX_WRECK_PIECE_INDEX + 1)),
  })
  .strict()
  .refine((r) => {
    for (let i = 0; i < r.nodes.length; i++) {
      const n = r.nodes[i]!;
      const d = n.desc;
      if (i === 0) {
        // The root: no parent, no steps, no parentPiece; a rock only here.
        if (n.parent !== -1 || n.steps.length !== 0 || d.parentPiece !== undefined) return false;
        if (d.rock !== undefined && d.parentKind !== WRECK_ROCK_PARENT_KIND) return false;
      } else {
        // Parent-before-child; one more step than the parent; the step's piece.
        if (n.parent < 0 || n.parent >= i || d.rock !== undefined) return false;
        const p = r.nodes[n.parent]!;
        if (n.steps.length !== p.steps.length + 1) return false;
        if (d.parentPiece === undefined || n.steps[n.steps.length - 1]!.pieceIndex !== d.parentPiece) return false;
      }
      if (d.extraCuts !== undefined && d.cutKind === undefined) return false;
    }
    for (const pc of r.pieces) if (pc.node >= r.nodes.length) return false;
    return true;
  });

export type WreckLineageRecord = z.infer<typeof RecordSchema>;
export type WreckLineageNode = WreckLineageRecord['nodes'][number];
export type WreckLineagePiece = WreckLineageRecord['pieces'][number];

/** The wreck fields `collectLineage` reads. */
export type WreckLineageView = Pick<LiveWreck, 'desc' | 'chain' | 'parent' | 'root' | 'ore'>;

/** What `collectLineage` reads from the wreck subsystem and the swarm. */
export interface WreckLineageDeps {
  /** Visit every live wreck (dead ancestors with live children included). */
  forEachWreck(visit: (w: WreckLineageView) => void): void;
  /** Visit each live piece of wreck `wreckId` with its index in that wreck's
   *  pieces (the swarm record's `componentIndex`), its pose and its remaining
   *  integrity (`PieceKnock.integrity`; may be infinite). */
  forEachLivePiece(wreckId: number, visit: (pieceIndex: number, x: number, y: number, angle: number, integrity: number) => void): void;
}

function copyCuts(cuts: ReadonlyArray<WreckExtraCut>): WreckExtraCut[] {
  return cuts.map((c) => ({ x: c.x, y: c.y, ang: c.ang, ...(c.w !== undefined ? { w: c.w } : {}) }));
}

function nodeOf(w: WreckLineageView, parent: number): WreckLineageNode {
  const d = w.desc;
  return {
    parent,
    desc: {
      parentKind: d.parentKind, seed: d.seed, killX: d.killX, killY: d.killY,
      killBlowDamage: d.killBlowDamage, recentDamageRate: d.recentDamageRate, snapChance: d.snapChance,
      ...(d.cutKind !== undefined ? { cutKind: d.cutKind } : {}),
      ...(d.cutAng !== undefined ? { cutAng: d.cutAng } : {}),
      ...(d.cutW !== undefined ? { cutW: d.cutW } : {}),
      ...(d.extraCuts !== undefined ? { extraCuts: copyCuts(d.extraCuts) } : {}),
      ...(d.parentPiece !== undefined ? { parentPiece: d.parentPiece } : {}),
      ...(d.owner !== undefined ? { owner: d.owner } : {}),
      ...(d.rock !== undefined ? { rock: { ...d.rock } } : {}),
    },
    steps: w.chain.steps.map((s) => ({
      pieceIndex: s.pieceIndex, killX: s.killX, killY: s.killY,
      ...(s.cutKind !== undefined ? { cutKind: s.cutKind } : {}),
      ...(s.cutAng !== undefined ? { cutAng: s.cutAng } : {}),
      ...(s.cutW !== undefined ? { cutW: s.cutW } : {}),
      ...(s.extraCuts !== undefined ? { extraCuts: copyCuts(s.extraCuts) } : {}),
    })),
    ...(w.ore !== undefined ? { ore: { ...w.ore } } : {}),
  };
}

/** The lineage of root wreck `rootId` as a plain JSON-safe record, or null
 *  when `rootId` is not a live root wreck. */
export function collectLineage(rootId: number, deps: WreckLineageDeps): WreckLineageRecord | null {
  const members: WreckLineageView[] = [];
  deps.forEachWreck((w) => { if (w.root === rootId) members.push(w); });
  const root = members.find((w) => w.desc.wreckId === rootId && w.parent === 0);
  if (root === undefined) return null;
  // Breadth-first from the root: parent before child, whatever the ids.
  const order: WreckLineageView[] = [root];
  const local = new Map<number, number>([[rootId, 0]]);
  const nodes: WreckLineageNode[] = [nodeOf(root, -1)];
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!.desc.wreckId;
    for (const w of members) {
      if (w.parent !== id || local.has(w.desc.wreckId)) continue;
      local.set(w.desc.wreckId, order.length);
      order.push(w);
      nodes.push(nodeOf(w, i));
    }
  }
  const pieces: WreckLineagePiece[] = [];
  for (let i = 0; i < order.length; i++) {
    deps.forEachLivePiece(order[i]!.desc.wreckId, (piece, x, y, angle, integrity) => {
      pieces.push({ node: i, piece, x, y, angle, integrity: Number.isFinite(integrity) ? Math.max(0, integrity) : WRECK_LINEAGE_UNBREAKABLE });
    });
  }
  return { version: WRECK_LINEAGE_RECORD_VERSION, fractureAlgo: FRACTURE_ALGO_VERSION, nodes, pieces };
}

/** Validate a record read back from the DB (#3: inbound data is parsed like
 *  wire data). Null on any mismatch, a wrong record version or a wrong
 *  `FRACTURE_ALGO_VERSION` included; the caller logs and drops it. */
export function parseLineageRecord(json: unknown): WreckLineageRecord | null {
  const r = RecordSchema.safeParse(json);
  return r.success ? r.data : null;
}
