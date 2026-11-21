/**
 * Capture plan 4E (S2) — a base that loses its last Capital becomes ownerless.
 * Player and NPC bases alike (S5).
 *
 * When a built Capital leaves the world (destroyed, packed, taken down: every
 * path ends in `StructureRegistry.remove`), each grid piece it held together
 * that has no other built Capital gets the owner `none:<lostCapitalId>`. The
 * base keeps working: power, shields and production run as before (the grid
 * view roots power on an ownerless node, `structureGridView.ts`); it simply has
 * no faction (`relationOf` makes `none:` neutral to everyone).
 *
 * Pieces follow the grid's component rule: steps go THROUGH built nodes only;
 * an unbuilt blueprint on the edge joins its piece but is never crossed.
 * Discrete event (a removal), not a hot path.
 *
 * Capture (S4) — the way back: when a player's built Capital ends up on one
 * grid piece with ownerless pieces (a cable or Connector linked them, or a
 * Capital was placed in link range), every `none:` piece in it takes that
 * player's owner. Finders keepers: no standing change, no hostile act. Which
 * links may form is `gridLinkAllowed` (relations.ts); the flip itself runs
 * from the grid's topology rebuild (`captureOwnerlessGrids`), the one place
 * every link, build and removal passes through.
 */
import { isUnownedOwner, parseOwner, unownedOwner } from '../../shared-types/relations.js';
import type { StructureRecord } from './StructureRegistry.js';

/** What the flip reads from the registry (narrow, avoids an import cycle). */
export interface OwnerlessBaseRegistry {
  get(id: string): StructureRecord | undefined;
  connectionsOf(id: string): readonly { getOtherNode(id: string): string | null }[];
}

/** The grid view's "built" rule (a mid-upgrade Capital stays operational). */
function operational(rec: StructureRecord): boolean {
  return rec.isConstructed || (rec.kind === 'capital' && rec.upgradeTargetLevel !== undefined);
}

/** A Capital that holds its base together (built, or mid-upgrade). */
export function isBuiltCapital(rec: StructureRecord): boolean {
  return rec.kind === 'capital' && operational(rec);
}

/**
 * Call BEFORE `capital` is disconnected and removed. No-op unless it is a
 * built Capital. Player and NPC bases alike (S5): a fallen NPC base's pieces
 * stop being `npc:`-owned, so its faction lets go of it for free (no trade
 * anchor, no faction count, no standing); its garrison patrol stands down
 * (`PatrolSubsystem.watchBaseFalls`).
 */
export function orphanBaseOnCapitalLoss(registry: OwnerlessBaseRegistry, capital: StructureRecord): void {
  if (!isBuiltCapital(capital)) return;
  const owner = unownedOwner(capital.id);
  const seen = new Set<string>([capital.id]);
  for (const c of registry.connectionsOf(capital.id)) {
    const start = c.getOtherNode(capital.id);
    if (start === null || seen.has(start)) continue;
    const piece = collectPiece(registry, start, seen);
    if (piece.some((r) => r.kind === 'capital' && operational(r))) continue;
    for (const r of piece) r.owner = owner;
  }
}

/** What the fall record reads and writes (narrow; the registry). */
export interface FallenBaseRegistry {
  all(): Iterable<StructureRecord>;
  readonly fallenBases: Set<string>;
}

/**
 * Capture plan 4E (S6) — record a fall at the sector level: when a seeded NPC
 * base's built Capital leaves the world and no other built Capital of that
 * base remains, the base's origin joins `fallenBases` (saved with the
 * sector). Called from the one removal seam. Discrete (removals); returns
 * before any scan unless `capital` is a seeded NPC base's built Capital.
 */
export function noteBaseFall(registry: FallenBaseRegistry, capital: StructureRecord): void {
  const origin = capital.originBase;
  if (origin === undefined || capital.owner !== origin || !isBuiltCapital(capital)) return;
  for (const r of registry.all()) if (r !== capital && r.owner === origin && isBuiltCapital(r)) return;
  registry.fallenBases.add(origin);
}

/**
 * Capture plan 4E (S6) — the NPC bases that have fallen here: the sector's
 * recorded falls (`fallenBases`, kept even when every piece is gone) plus the
 * seed owner (`originBase`) of every structure no longer owned by it
 * (ownerless `none:`, or captured by a player). The seeders skip these, so a
 * fallen base never regrows, after a restart or not. Boot only (one pass).
 */
export function fallenBaseOrigins(registry: FallenBaseRegistry): Set<string> {
  const out = new Set<string>(registry.fallenBases);
  for (const r of registry.all()) if (r.originBase !== undefined && r.owner !== r.originBase) out.add(r.originBase);
  return out;
}

/** What the capture pass reads: the flip's view plus every record. */
export interface CaptureRegistry extends OwnerlessBaseRegistry {
  all(): Iterable<StructureRecord>;
}

/**
 * Capture (S4): each grid piece holding a player's built Capital takes every
 * ownerless (`none:`) record in it. NPC Capitals capture nothing (S5). If two
 * players' Capitals ever share a piece, the first in registry order wins.
 * Run before the topology rebuild so the rebuilt grid sees the new owners.
 * Returns true when any owner changed. Discrete (topology changes only);
 * returns before allocating when no ownerless structure exists.
 */
export function captureOwnerlessGrids(registry: CaptureRegistry): boolean {
  let anyUnowned = false;
  for (const r of registry.all()) {
    if (isUnownedOwner(r.owner)) { anyUnowned = true; break; }
  }
  if (!anyUnowned) return false;
  let changed = false;
  const seen = new Set<string>();
  for (const cap of registry.all()) {
    if (cap.kind !== 'capital' || !operational(cap) || seen.has(cap.id)) continue;
    if (parseOwner(cap.owner).kind !== 'player') continue;
    for (const r of collectPiece(registry, cap.id, seen)) {
      if (!isUnownedOwner(r.owner)) continue;
      r.owner = cap.owner;
      changed = true;
    }
  }
  return changed;
}

/** Every record of the grid piece reachable from `start` without crossing the
 *  lost Capital (already in `seen`) or an unbuilt node. */
function collectPiece(registry: OwnerlessBaseRegistry, start: string, seen: Set<string>): StructureRecord[] {
  const piece: StructureRecord[] = [];
  const queue = [start];
  seen.add(start);
  while (queue.length > 0) {
    const rec = registry.get(queue.pop()!);
    if (!rec) continue;
    piece.push(rec);
    if (!operational(rec)) continue; // dead end: a blueprint is never crossed
    for (const c of registry.connectionsOf(rec.id)) {
      const other = c.getOtherNode(rec.id);
      if (other === null || seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return piece;
}
