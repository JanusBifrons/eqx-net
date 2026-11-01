/**
 * Contracts (Living World P4c, plan peppy-jumping-pinwheel) — the targets the
 * Contracts tab lists: named elites (with a bounty), the running world event,
 * and (P4c-2) player bounties. Served by `GET /galaxy/contracts`; the client
 * rebuilds the tab from it alone (#16). Shared so both sides agree (#15).
 */
import { z } from 'zod';

/** Credits paid into the killer's hold for a named elite (P4a). */
export const ELITE_BOUNTY_CREDITS = 300;
/** Credits paid into the killer's hold for the Drone Mothership (P4b). */
export const MOTHERSHIP_BOUNTY_CREDITS = 500;

export const CONTRACT_KINDS = ['elite', 'event', 'player'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const ContractSchema = z
  .object({
    /** Stable row key (never shown). */
    id: z.string().max(80),
    kind: z.enum(CONTRACT_KINDS),
    /** Player-facing title ("Dread Vexis", "Robot Incursion"). */
    title: z.string().max(80),
    /** One line of detail ("Gunship elite", "Destroy every raider"). */
    detail: z.string().max(120),
    /** Where to go (a galaxy sector key; the client shows its name). */
    sectorKey: z.string().max(64),
    /** Credits paid on completion, or null when the reward is loot. */
    rewardCredits: z.number().int().nonnegative().nullable(),
    /** Wall-clock ms the contract lapses, or null. */
    endsAtMs: z.number().nonnegative().nullable(),
  })
  .strict();

export type Contract = z.infer<typeof ContractSchema>;

export const ContractsResponseSchema = z
  .object({ contracts: z.array(ContractSchema) })
  .strict();

export type ContractsResponse = z.infer<typeof ContractsResponseSchema>;

// ── P4c-2 — player bounties ────────────────────────────────────────────────

/** Placing a bounty also burns this fraction ON TOP (a 100¢ bounty costs 125¢). */
export const PVP_BOUNTY_FEE_FRAC = 0.25;
export const PVP_BOUNTY_MIN = 100;
export const PVP_BOUNTY_MAX = 50_000;
/** The target must own a ship at least this level (no griefing new pilots). */
export const PVP_BOUNTY_MIN_TARGET_LEVEL = 3;
/** After a bounty on a target is claimed, its placer must wait this long to
 *  place another on the same target. */
export const PVP_BOUNTY_PAIR_COOLDOWN_MS = 24 * 60 * 60_000;

/** The total a placer pays for a bounty of `amount` (bounty + burned fee). */
export function pvpBountyCost(amount: number): number {
  return amount + Math.ceil(amount * PVP_BOUNTY_FEE_FRAC);
}

/** Client → server: put `amount` credits on `targetPlayerId`, paid from the
 *  placer's WALLET (economy v2 — credits are virtual). */
export const PlaceBountySchema = z
  .object({
    targetPlayerId: z.string().min(1).max(64),
    amount: z.number().int().min(PVP_BOUNTY_MIN).max(PVP_BOUNTY_MAX),
  })
  .strict();
export type PlaceBounty = z.infer<typeof PlaceBountySchema>;

/** Server → client: the placement verdict (an accelerator — the board is the truth). */
export const BountyResultSchema = z
  .object({
    type: z.literal('bounty_result'),
    ok: z.boolean(),
    message: z.string().max(200),
  })
  .strict();
export type BountyResult = z.infer<typeof BountyResultSchema>;
