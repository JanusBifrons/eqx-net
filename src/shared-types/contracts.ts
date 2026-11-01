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
