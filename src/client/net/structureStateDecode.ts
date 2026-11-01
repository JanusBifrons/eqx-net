/**
 * Decode a room-state structure row (plan soft-leaping-truffle v2, A2) into the
 * `mirror.structures` row shape the renderer + inspector already read, IN
 * PLACE (no per-snapshot allocation once a row exists). The mapping matches the
 * pre-A2 per-snapshot slice exactly — locked by
 * tests/unit/structureStateWire.test.ts (two-sided contract, invariant #15).
 */
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';
import {
  STRUCTURE_ETA_NONE,
  STRUCTURE_ETA_STALLED,
  STRUCTURE_FLAG_BUILT,
  STRUCTURE_FLAG_DECONSTRUCTING,
  STRUCTURE_FLAG_POWERED,
  STRUCTURE_FLAG_WALL_ACTIVE,
  STRUCTURE_FLAG_NO_AMMO,
  STRUCTURE_DEFAULTS as D,
  type StructureStateView,
} from '../../shared-types/structureStateWire.js';

export function emptyStructureRow(): StructureRenderState {
  return { powered: false, netPower: 0, connTo: [], built: false, buildPct: 0, deconstructPct: 0 };
}

/** Interned owner tables (index → id / display name), rebuilt by the caller
 *  only when the sector's owner set changes. */
export interface StructureOwnerTables {
  ids: readonly string[];
  names: readonly string[];
}

export function decodeStructureState(v: StructureStateView, owners: StructureOwnerTables, out: StructureRenderState): void {
  const flags = v.flags ?? D.flags;
  const built = (flags & STRUCTURE_FLAG_BUILT) !== 0;
  out.powered = (flags & STRUCTURE_FLAG_POWERED) !== 0;
  out.netPower = v.netPower ?? D.netPower;
  out.hpPct = (v.hpPct ?? D.hpPct) / 100;
  out.built = built;
  out.buildPct = built ? 1 : v.buildPct ?? D.buildPct;
  const eta = v.etaMs ?? D.etaMs;
  out.etaMs = eta === STRUCTURE_ETA_NONE ? undefined : eta === STRUCTURE_ETA_STALLED ? null : eta;
  out.isDeconstructing = (flags & STRUCTURE_FLAG_DECONSTRUCTING) !== 0 ? true : undefined;
  out.deconstructPct = out.isDeconstructing ? v.deconstructPct ?? D.deconstructPct : 0;
  const minerals = v.minerals ?? D.minerals;
  out.minerals = minerals > 0 ? minerals : undefined;
  const storedMax = v.storedPowerMax ?? D.storedPowerMax;
  if (storedMax > 0) {
    out.storedPower = v.storedPower ?? D.storedPower;
    out.storedPowerMax = storedMax;
  } else {
    out.storedPower = undefined;
    out.storedPowerMax = undefined;
  }
  const wallTo = v.shieldWallTo ?? D.shieldWallTo;
  out.shieldWallTo = wallTo >= 0 ? wallTo : undefined;
  // Every shield emitter: are all of its walls up? Walls themselves are derived
  // from connections (structures/derivedWalls.ts).
  out.wallActive = (flags & STRUCTURE_FLAG_WALL_ACTIVE) !== 0 ? true : undefined;
  out.noAmmo = (flags & STRUCTURE_FLAG_NO_AMMO) !== 0 ? true : undefined;
  const gateOpen = v.gateOpen ?? D.gateOpen;
  out.gateOpen = gateOpen !== 0 ? gateOpen : undefined;
  const gateAccess = v.gateAccess ?? D.gateAccess;
  out.gateAccess = gateAccess !== 0 ? gateAccess : undefined;
  const recipe = v.recipe ?? D.recipe;
  out.recipe = recipe !== 0 ? recipe : undefined;
  const prodState = v.prodState ?? D.prodState;
  out.prodState = prodState !== 0 ? prodState : undefined;
  const prodMissing = v.prodMissing ?? D.prodMissing;
  out.prodMissing = prodMissing !== 0 ? prodMissing : undefined;
  const bpRuns = v.bpRuns ?? D.bpRuns;
  out.bpRuns = bpRuns !== 0 ? bpRuns : undefined;
  out.bpQuality = bpRuns !== 0 ? (v.bpQuality ?? D.bpQuality) : undefined;
  const oi = v.ownerIdx ?? D.ownerIdx;
  out.owner = owners.ids[oi] ?? '';
  const name = owners.names[oi] ?? '';
  out.ownerName = name !== '' ? name : undefined;
  const level = v.level ?? D.level;
  out.level = level > 1 ? level : undefined;
  const conn = out.connTo;
  conn.length = 0;
  for (let i = 0; i < v.connTo.length; i++) conn.push(v.connTo.at(i)!);
}
