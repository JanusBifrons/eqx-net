/**
 * Goods + the unified HOLD shape (plan peppy-jumping-pinwheel P1a-1).
 *
 * Storage is PHYSICAL: every unit of value lives in some entity's hold — a
 * ship, a loot pod, a derelict, a trade hauler, or a storage structure. A hold
 * is the same shape everywhere, so moving value between entities is one pure
 * transfer (`src/core/cargo/hold.ts`).
 *
 * Shared by server + client (invariant #15): the HUD weight readout and the
 * server's capacity clamp read the same `GOOD_DEFS` weights.
 */
import { z } from 'zod';

/** Tradable goods. APPEND-ONLY (persisted in hold JSON + audit). */
export const GOOD_IDS = ['minerals', 'salvage', 'alloy', 'core'] as const;
export type GoodId = (typeof GOOD_IDS)[number];

export interface GoodDef {
  readonly id: GoodId;
  readonly displayName: string;
  /** Cargo weight per unit (credits + blueprints are weightless). */
  readonly weight: number;
  /** Rarity tier 0..2 — drives loot-pod glow (grey / blue / gold). */
  readonly tier: 0 | 1 | 2;
}

export const GOOD_DEFS: Readonly<Record<GoodId, GoodDef>> = Object.freeze({
  minerals: { id: 'minerals', displayName: 'Minerals', weight: 0.1, tier: 0 },
  salvage: { id: 'salvage', displayName: 'Salvage', weight: 1, tier: 0 },
  alloy: { id: 'alloy', displayName: 'Alloy', weight: 2, tier: 1 },
  core: { id: 'core', displayName: 'Robot Core', weight: 5, tier: 2 },
});

/** A hold's contents. `goods` keys are optional (absent ⇒ 0). Integer counts. */
export interface Hold {
  goods: Partial<Record<GoodId, number>>;
  credits: number;
  blueprints: string[];
}

const nonNegInt = z.number().int().nonnegative();

/** Strict schema for a persisted / wire hold. `partialRecord` — any subset of
 *  goods (zod 4 `record(enum, v)` would be exhaustive, LESSONS 2026-10-31). */
export const HoldSchema = z
  .object({
    goods: z.partialRecord(z.enum(GOOD_IDS), nonNegInt),
    credits: nonNegInt,
    blueprints: z.array(z.string().min(1).max(64)).max(64),
  })
  .strict();

/** Parse persisted hold JSON defensively — corruption yields an empty hold
 *  (never a crash, never a fabricated value). */
export function parseHoldJson(json: string | null | undefined): Hold {
  if (!json) return { goods: {}, credits: 0, blueprints: [] };
  try {
    const r = HoldSchema.safeParse(JSON.parse(json));
    if (r.success) return { goods: { ...r.data.goods }, credits: r.data.credits, blueprints: [...r.data.blueprints] };
  } catch {
    /* fall through */
  }
  return { goods: {}, credits: 0, blueprints: [] };
}

/** Cargo capacity (weight units) of a ship kind — derived, so it needs no
 *  catalogue field: tougher hulls haul more. Shared by the HUD + server clamp. */
export function cargoCapacityForMaxHealth(maxHealth: number): number {
  return Math.max(50, Math.round(maxHealth * 2));
}
