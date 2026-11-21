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
  STRUCTURE_FLAG_NO_FUEL,
  STRUCTURE_FLAG_DRAW_FULL,
  STRUCTURE_FLAG_OFF,
  decodeStructureThrottleFlags,
  STRUCTURE_FLAG_BREACH,
  STRUCTURE_FLAG_LOCK_HOLDING,
  STRUCTURE_FLAG_GHOST_BODY,
  STRUCTURE_FLAG_MIRROR,
  STRUCTURE_DEFAULTS as D,
  STRUCTURE_RIG_CLIP_TARGET,
  CONN_SOCK_UNKNOWN,
  decodeConnSockOther,
  decodeConnSockSelf,
  decodeRigClipIndex,
  decodeRigHoldCargo,
  decodeRigHoldTicks,
  type StructureStateView,
} from '../../shared-types/structureStateWire.js';
import { decodeProdBay, decodeProdFrac } from '../../shared-types/production.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { clearDoorRow, decodeDoorRow, isDoorKind } from './doorMotionDecode.js';
import {
  decodeBpAvail,
  decodeBpProduct,
  decodeProdCount,
  decodeProdQueue,
  decodeProdQueueRepeat,
  isProcessorKind,
  prodQ1HasQueue,
} from '../../shared-types/production.js';
import type { RecipeId } from '../../shared-types/recipes.js';
import { isUnownedOwner } from '../../shared-types/relations.js';

/** The owner label of an ownerless base (capture 4E): no faction, nobody's. */
export const UNOWNED_OWNER_LABEL = 'Unowned';

/** Scratch for `decodeProdBay` (reused per row, #14). */
const _bay = { bay: 0, queued: 0 };

export function emptyStructureRow(): StructureRenderState {
  return { powered: false, netPower: 0, connTo: [], connSockSelf: [], connSockOther: [], built: false, buildPct: 0, deconstructPct: 0 };
}

/** Interned owner tables (index → id / display name), rebuilt by the caller
 *  only when the sector's owner set changes. */
export interface StructureOwnerTables {
  ids: readonly string[];
  names: readonly string[];
}

/** `rigKind` is the structure kind (its swarm entry `shipKind`), which maps
 *  the wire clip index to its id; unknown (no pose yet) ⇒ no `rigClip` until
 *  a later decode knows it. */
export function decodeStructureState(
  v: StructureStateView, owners: StructureOwnerTables, out: StructureRenderState, rigKind?: string,
): void {
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
  out.noFuel = (flags & STRUCTURE_FLAG_NO_FUEL) !== 0 ? true : undefined;
  out.drawFull = (flags & STRUCTURE_FLAG_DRAW_FULL) !== 0 ? true : undefined;
  out.switchedOff = (flags & STRUCTURE_FLAG_OFF) !== 0 ? true : undefined;
  const throttle = decodeStructureThrottleFlags(flags);
  out.throttle = throttle < 10 ? throttle : undefined;
  out.breach = (flags & STRUCTURE_FLAG_BREACH) !== 0 ? true : undefined;
  out.lockHolding = (flags & STRUCTURE_FLAG_LOCK_HOLDING) !== 0 ? true : undefined;
  out.ghostBody = (flags & STRUCTURE_FLAG_GHOST_BODY) !== 0 ? true : undefined;
  out.mirror = (flags & STRUCTURE_FLAG_MIRROR) !== 0 ? true : undefined;
  // Door kinds: gateOpen + the rig fields carry the door segment (slice 9),
  // decoded into doorA / doorB (+ the scrubbed rigClip).
  const door = isDoorKind(rigKind);
  if (door) decodeDoorRow(v, out, rigKind!);
  else clearDoorRow(out);
  const gateAccess = v.gateAccess ?? D.gateAccess;
  out.gateAccess = gateAccess !== 0 ? gateAccess : undefined;
  const recipe = v.recipe ?? D.recipe;
  out.recipe = recipe !== 0 ? recipe : undefined;
  const prodState = v.prodState ?? D.prodState;
  out.prodState = prodState !== 0 ? prodState : undefined;
  const prodMissing = v.prodMissing ?? D.prodMissing;
  out.prodMissing = prodMissing !== 0 ? prodMissing : undefined;
  const prodFrac = decodeProdFrac(v.prodFrac);
  out.prodFrac = prodFrac > 0 ? prodFrac : undefined;
  decodeProdBay(v.prodBay, _bay);
  out.prodBay = _bay.bay !== 0 ? _bay.bay : undefined;
  out.prodQueued = _bay.queued !== 0 ? _bay.queued : undefined;
  const bpRuns = v.bpRuns ?? D.bpRuns;
  out.bpRuns = bpRuns !== 0 ? bpRuns : undefined;
  out.bpQuality = bpRuns !== 0 ? (v.bpQuality ?? D.bpQuality) : undefined;
  out.prodCount = decodeProdCount(v.prodCount ?? D.prodCount);
  decodeQueue(v, out);
  decodeBlueprintStock(v, out, rigKind);
  // v4 T1 — teleporters: decode in place (allocated once per teleporter row).
  if (v.tpPhase !== undefined || v.tpPartner !== undefined || v.tpChargePct !== undefined || out.teleport !== undefined) {
    const t = (out.teleport ??= { phase: 0, phaseMs: 0, chargePct: 0, partner: -1, rules: 0, loadGood: 0, loadQty: 0, keepGood: 0, keepQty: 0, padWeight: 0, toll: 0 });
    t.phase = v.tpPhase ?? D.tpPhase;
    t.phaseMs = v.tpPhaseMs ?? D.tpPhaseMs;
    t.chargePct = v.tpChargePct ?? D.tpChargePct;
    t.partner = v.tpPartner ?? D.tpPartner;
    t.rules = v.tpRules ?? D.tpRules;
    t.loadGood = v.tpLoadGood ?? D.tpLoadGood;
    t.loadQty = v.tpLoadQty ?? D.tpLoadQty;
    t.keepGood = v.tpKeepGood ?? D.tpKeepGood;
    t.keepQty = v.tpKeepQty ?? D.tpKeepQty;
    t.padWeight = v.padWeight ?? D.padWeight;
    t.toll = v.tpToll ?? D.tpToll;
  }
  const minesOut = v.minesOut ?? D.minesOut;
  out.minesOut = minesOut !== 0 ? minesOut : undefined;
  const fillPct = v.fillPct ?? D.fillPct;
  out.fillPct = fillPct !== 0 ? fillPct : undefined;
  if (!door) decodeRigClip(v, out, rigKind);
  const oi = v.ownerIdx ?? D.ownerIdx;
  out.owner = owners.ids[oi] ?? '';
  const name = owners.names[oi] ?? '';
  // Capture 4E: an ownerless base (`none:`) has no faction; every owner label reads this.
  out.ownerName = isUnownedOwner(out.owner) ? UNOWNED_OWNER_LABEL : name !== '' ? name : undefined;
  const level = v.level ?? D.level;
  out.level = level > 1 ? level : undefined;
  const conn = out.connTo;
  conn.length = 0;
  for (let i = 0; i < v.connTo.length; i++) conn.push(v.connTo.at(i)!);
  decodeConnSock(v, out);
}

/** Building panels B4: the recipe queue onto `out.prodQueue`, in place (one
 *  array per row, allocated the first time a queue shows up; an emptied queue
 *  keeps its array, cleared). */
function decodeQueue(v: StructureStateView, out: StructureRenderState): void {
  const q0 = v.prodQ0 ?? D.prodQ0;
  const q1 = v.prodQ1 ?? D.prodQ1;
  out.prodQueueRepeat = decodeProdQueueRepeat(q1) ? true : undefined;
  if (q0 === 0 && !prodQ1HasQueue(q1) && out.prodQueue === undefined) return;
  decodeProdQueue(q0, q1, (out.prodQueue ??= []) as RecipeId[]);
}

/** Building panels B7: the slot blueprint's recipe (prodQ1 bits 24..30) and
 *  the recipes with a blueprint in network storage (`bpAvail`), onto the row
 *  in place (one `bpAvailable` array per row, allocated the first time one
 *  shows up). Both index the kind's recipe list, so they need the kind; an
 *  unknown kind (no pose yet) or a non-processor leaves them undefined. */
function decodeBlueprintStock(v: StructureStateView, out: StructureRenderState, kind: string | undefined): void {
  if (kind === undefined || !isProcessorKind(kind)) {
    out.bpProduct = undefined;
    if (out.bpAvailable !== undefined) (out.bpAvailable as RecipeId[]).length = 0;
    return;
  }
  out.bpProduct = decodeBpProduct(kind, v.prodQ1 ?? D.prodQ1);
  const mask = v.bpAvail ?? D.bpAvail;
  if (mask === 0 && out.bpAvailable === undefined) return;
  decodeBpAvail(kind, mask, (out.bpAvailable ??= []) as RecipeId[]);
}

/** 0d slice 6: each link's cable sockets (`connSock`, parallel to `connTo`)
 *  onto `connSockSelf` / `connSockOther`, in place (the two arrays are
 *  allocated once per row). A missing entry reads as no socket (-1). */
function decodeConnSock(v: StructureStateView, out: StructureRenderState): void {
  const self = (out.connSockSelf ??= []);
  const other = (out.connSockOther ??= []);
  self.length = 0;
  other.length = 0;
  const cs = v.connSock;
  for (let i = 0; i < v.connTo.length; i++) {
    const packed = cs !== undefined && i < cs.length ? cs.at(i)! : CONN_SOCK_UNKNOWN;
    self.push(decodeConnSockSelf(packed));
    other.push(decodeConnSockOther(packed));
  }
}

/** Structure-restyle 2e: the row's rig clip onto `out.rigClip` (reused in
 *  place while a clip plays; allocates only when a clip starts after none). */
function decodeRigClip(v: StructureStateView, out: StructureRenderState, rigKind: string | undefined): void {
  const code = v.rigClip ?? D.rigClip;
  const rig = code !== 0 && rigKind !== undefined ? rigForStructureKind(rigKind) : null;
  const clip = rig !== null ? rig.clips[decodeRigClipIndex(code)] : undefined;
  if (clip === undefined) {
    out.rigClip = undefined;
    return;
  }
  const r = (out.rigClip ??= { clipId: '', startTick: 0 });
  r.clipId = clip.id;
  r.startTick = v.rigStart ?? D.rigStart;
  const hold = v.rigHold ?? D.rigHold;
  r.holdTicks = hold !== 0 ? decodeRigHoldTicks(hold) : undefined;
  r.cargo = hold !== 0 ? decodeRigHoldCargo(hold) : undefined;
  if ((code & STRUCTURE_RIG_CLIP_TARGET) !== 0) {
    r.targetX = v.rigTx ?? D.rigTx;
    r.targetY = v.rigTy ?? D.rigTy;
  } else {
    r.targetX = undefined;
    r.targetY = undefined;
  }
}
