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
import {
  BlueprintItemSchema,
  PackedItemSchema,
  legacyBlueprintItem,
  type BlueprintItem,
  type PackedItem,
} from './items.js';

/** Tradable goods. APPEND-ONLY (persisted in hold JSON + audit). The goods
 *  after `core` are the production chain (plan soft-leaping-truffle v3, P1). */
export const GOOD_IDS = [
  'minerals',
  'salvage',
  'alloy',
  'core',
  'ice',
  'gas',
  'crystal',
  'fuel',
  'polymer',
  'silicon',
  'provisions',
  'components',
  'electronics',
  'munitions',
  'machinery',
  'consumer_goods',
] as const;
export type GoodId = (typeof GOOD_IDS)[number];

export interface GoodDef {
  readonly id: GoodId;
  readonly displayName: string;
  /** Cargo weight per unit (credits + blueprints are weightless). */
  readonly weight: number;
  /** Rarity tier 0..2 — drives loot-pod glow (grey / blue / gold). */
  readonly tier: 0 | 1 | 2;
  /** Production-chain stage (plan soft-leaping-truffle v3): 0 raw, 1 refined,
   *  2 components, 3 end products, 4 exotic (Robot Cores: loot only). */
  readonly stage: GoodStage;
}

export type GoodStage = 0 | 1 | 2 | 3 | 4;
export const GOOD_STAGE_EXOTIC: GoodStage = 4;
export const GOOD_STAGE_NAMES: Readonly<Record<GoodStage, string>> = Object.freeze({
  0: 'Raw',
  1: 'Refined',
  2: 'Components',
  3: 'End products',
  4: 'Exotic',
});

export const GOOD_DEFS: Readonly<Record<GoodId, GoodDef>> = Object.freeze({
  minerals: { id: 'minerals', displayName: 'Minerals', weight: 0.1, tier: 0, stage: 0 },
  salvage: { id: 'salvage', displayName: 'Salvage', weight: 1, tier: 0, stage: 0 },
  alloy: { id: 'alloy', displayName: 'Alloy', weight: 2, tier: 1, stage: 1 },
  core: { id: 'core', displayName: 'Robot Core', weight: 5, tier: 2, stage: 4 },
  ice: { id: 'ice', displayName: 'Ice', weight: 0.25, tier: 0, stage: 0 },
  gas: { id: 'gas', displayName: 'Gas', weight: 0.25, tier: 0, stage: 0 },
  crystal: { id: 'crystal', displayName: 'Crystal', weight: 0.5, tier: 1, stage: 0 },
  fuel: { id: 'fuel', displayName: 'Fuel', weight: 0.5, tier: 0, stage: 1 },
  polymer: { id: 'polymer', displayName: 'Polymer', weight: 0.5, tier: 0, stage: 1 },
  silicon: { id: 'silicon', displayName: 'Silicon', weight: 0.5, tier: 1, stage: 1 },
  provisions: { id: 'provisions', displayName: 'Provisions', weight: 0.5, tier: 0, stage: 1 },
  components: { id: 'components', displayName: 'Components', weight: 2, tier: 1, stage: 2 },
  electronics: { id: 'electronics', displayName: 'Electronics', weight: 1, tier: 1, stage: 2 },
  // Light by design (user, 2026-11-01): carrying and looting ammo is never a
  // chore; one unit covers many shots.
  munitions: { id: 'munitions', displayName: 'Munitions', weight: 0.1, tier: 1, stage: 2 },
  machinery: { id: 'machinery', displayName: 'Machinery', weight: 4, tier: 2, stage: 3 },
  consumer_goods: { id: 'consumer_goods', displayName: 'Consumer Goods', weight: 1, tier: 2, stage: 3 },
});

/** A hold's contents. `goods` keys are optional (absent ⇒ 0). Integer counts.
 *  Credits are NOT here: they are virtual and live in the player's wallet
 *  (economy v2 W1, `src/server/economy/Wallet.ts`). */
export interface Hold {
  goods: Partial<Record<GoodId, number>>;
  /** Economy v2 W2 — blueprint instances (originals + copies). Weightless. */
  blueprints: BlueprintItem[];
  /** Economy v2 W2 — packed structures / hulls (have weight). Absent ⇒ none. */
  packed?: PackedItem[];
}

const nonNegInt = z.number().int().nonnegative();

/** Strict schema for a persisted / wire hold. `partialRecord` — any subset of
 *  goods (zod 4 `record(enum, v)` would be exhaustive, LESSONS 2026-10-31). */
export const HoldSchema = z
  .object({
    goods: z.partialRecord(z.enum(GOOD_IDS), nonNegInt),
    // A pre-W2 bare string id parses into a single-run copy (`legacyBlueprintItem`).
    blueprints: z
      .array(z.union([BlueprintItemSchema, z.string().min(1).max(64)]))
      .max(64)
      .transform((arr) => arr.map((b) => (typeof b === 'string' ? legacyBlueprintItem(b) : b))),
    packed: z.array(PackedItemSchema).max(64).optional(),
  })
  .strict();

/** Parse persisted hold JSON defensively — corruption yields an empty hold
 *  (never a crash, never a fabricated value). */
export function parseHoldJson(json: string | null | undefined): Hold {
  if (!json) return { goods: {}, blueprints: [] };
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    // Pre-W1 rows carried `credits`; they migrate to the wallet at boot
    // (`legacyHoldCredits`) — never back into a hold.
    if (raw !== null && typeof raw === 'object') delete raw['credits'];
    const r = HoldSchema.safeParse(raw);
    if (r.success) {
      const h: Hold = { goods: { ...r.data.goods }, blueprints: r.data.blueprints.map((b) => ({ ...b })) };
      if (r.data.packed && r.data.packed.length > 0) h.packed = r.data.packed.map((p) => ({ ...p }));
      return h;
    }
  } catch {
    /* fall through */
  }
  return { goods: {}, blueprints: [] };
}

/** Economy v2 W1 — the credits a PRE-wallet persisted hold carried (0 if
 *  none / corrupt). Read once at boot to move them into the owner's wallet. */
export function legacyHoldCredits(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const c = (JSON.parse(json) as { credits?: unknown }).credits;
    return typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.floor(c) : 0;
  } catch {
    return 0;
  }
}

/** Credit sinks (balance knobs — tune on-device), paid from the WALLET.
 *  Shared so the UI labels and the server charge read the SAME numbers (#15).
 *  Instant repair costs this many credits per missing hull point (rounded up);
 *  a stat respec is flat. */
export const REPAIR_CREDITS_PER_HP = 0.5;
export const RESPEC_CREDIT_COST = 100;

/** Cargo capacity (weight units) of a ship kind — derived, so it needs no
 *  catalogue field: tougher hulls haul more. Shared by the HUD + server clamp. */
export function cargoCapacityForMaxHealth(maxHealth: number): number {
  return Math.max(50, Math.round(maxHealth * 2));
}
