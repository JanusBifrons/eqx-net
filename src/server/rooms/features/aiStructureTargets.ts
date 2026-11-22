import type { AiStructureView } from '../../../core/contracts/IAiBehaviour.js';
import { relationOf, type RelationContext } from '../../../shared-types/relations.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';

/** Wave-system Phase 2 — drone target priority by structure kind (higher =
 *  attacked first). The Capital (the "core" / mineral bank) is the prize; the
 *  Miner is the objective the de-escalation condition keys on; defence + power
 *  rank below. All are > 0 so every hostile structure outranks a player ship
 *  (req #2 "structures primarily"). Tunable per difficulty pass. */
export function structurePriority(kind: StructureKindId): number {
  switch (kind) {
    case 'capital':
      return 3;
    // The Miner is the wave objective; a shield-fence pylon is a defensive wall
    // attackers want to dismantle to reach the base — both ranked above the
    // other leaves so drones actively engage them (the wall absorbs the incoming
    // fire until its batteries / power give out).
    case 'miner':
    case 'shield_pylon':
      return 2;
    default:
      return 1;
  }
}

export interface AiStructureTargetsHost {
  structures(): { readonly size: number; all(): IterableIterator<StructureRecord>; get(id: string): StructureRecord | undefined };
  /** The drone-raid rule (`FactionLedger.isHostileToDrones`). */
  isHostileToDrones(owner: string): boolean;
  health(id: string): number | undefined;
  /** The AI-flown hulls (fleet): their count and each one's owner. */
  fleetSize(): number;
  fleetOwnerAt(i: number): string;
  relationCtx: RelationContext;
  now(): number;
  /** The NPC→player answer for anything that is not a structure. */
  npcHostileTo(entityId: string, playerId: string): boolean;
}

type MutableStructureView = { -readonly [K in keyof AiStructureView]: AiStructureView[K] };
interface StructureCircle { id: string; x: number; y: number; radius: number }

/**
 * The per-tick structure list the AI brains see (`AiWorldView.structures`),
 * built ONCE per tick and shared by every brain (#14). Two kinds of entry:
 *  - drone-raid structures (owner `isHostileToDrones`: member attacked a drone
 *    or under wave) — every brain, and the capital turret circles;
 *  - structures hostile to the OWNER of an AI-flown hull (an enemy base,
 *    `relationOf(owner, structureOwner) === 'hostile'`, the lock pipeline's
 *    rule) — `ownerFoeOnly`, read only by owned brains (drones skip them).
 * Constructed structures only. Entries are pooled (no per-tick allocation).
 */
export class AiStructureTargets {
  /** Capital turret target circles: drone-raid structures only. */
  readonly circles: StructureCircle[] = [];
  private readonly viewPool: MutableStructureView[] = [];
  private readonly circlePool: StructureCircle[] = [];
  /** This tick's distinct AI-hull owners (reused). */
  private readonly owners: string[] = [];

  constructor(private readonly h: AiStructureTargetsHost) {}

  fill(out: AiStructureView[]): void {
    const circles = this.circles;
    circles.length = 0;
    const reg = this.h.structures();
    if (reg.size === 0) return;
    const owners = this.owners;
    owners.length = 0;
    const fleetN = this.h.fleetSize();
    for (let i = 0; i < fleetN; i++) {
      const o = this.h.fleetOwnerAt(i);
      if (!owners.includes(o)) owners.push(o);
    }
    if (owners.length > 0) this.h.relationCtx.nowMs = this.h.now();
    let nv = 0;
    let nc = 0;
    for (const rec of reg.all()) {
      if (!rec.isConstructed) continue;
      const raid = this.h.isHostileToDrones(rec.owner);
      if (!raid && !this.foeOfAnyOwner(rec.owner)) continue;
      let v = this.viewPool[nv];
      if (!v) {
        v = { id: '', x: 0, y: 0, priority: 0 };
        this.viewPool[nv] = v;
      }
      nv++;
      v.id = rec.id;
      v.x = rec.x;
      v.y = rec.y;
      v.health = this.h.health(rec.id);
      v.maxHealth = getStructureKind(rec.kind).maxHealth;
      v.priority = structurePriority(rec.kind);
      v.owner = rec.owner;
      v.ownerFoeOnly = !raid;
      out.push(v);
      if (!raid) continue;
      let c = this.circlePool[nc];
      if (!c) {
        c = { id: '', x: 0, y: 0, radius: 0 };
        this.circlePool[nc] = c;
      }
      nc++;
      c.id = rec.id;
      c.x = rec.x;
      c.y = rec.y;
      c.radius = rec.radius;
      circles.push(c);
    }
  }

  /** `AiWorldView.hostileToPlayer`: a structure is hostile to a player when
   *  its owner is (the lock pipeline's `relationOf` rule; never their own);
   *  anything else asks the NPC answer. */
  hostileToPlayer(entityId: string, playerId: string): boolean {
    const rec = this.h.structures().get(entityId);
    if (rec === undefined) return this.h.npcHostileTo(entityId, playerId);
    return rec.owner !== playerId && relationOf(playerId, rec.owner, this.h.relationCtx) === 'hostile';
  }

  private foeOfAnyOwner(structureOwner: string): boolean {
    const owners = this.owners;
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i]!;
      if (o !== structureOwner && relationOf(o, structureOwner, this.h.relationCtx) === 'hostile') return true;
    }
    return false;
  }
}
