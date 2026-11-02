/**
 * Mine Layer + proximity mines (plan soft-leaping-truffle v3, P2d follow-up).
 * Shared by the server (laying, triggering) and the client (drawing the trigger
 * ring and the blast), invariant #15.
 *
 * A built, powered Mine Layer spends munitions (`AMMO_SHOTS_PER_UNIT.mine_layer`
 * mines per unit) to keep up to `MINES_PER_LAYER` mines on a ring around
 * itself. A mine arms after `MINE_ARM_MS`, then detonates on the first ship
 * HOSTILE to the layer's owner that comes within `MINE_TRIGGER_RANGE` (the
 * same rule its owner's turrets use: drones and pilots who committed a hostile
 * act for a player's base; anyone hostile by relation for an NPC base). Mines
 * leave the world with their layer.
 */
import { z } from 'zod';

/** Most mines one layer keeps out. */
export const MINES_PER_LAYER = 6;
/** One mine every this long while below the cap (and stocked + powered). */
export const MINE_LAY_INTERVAL_MS = 8_000;
/** A freshly laid mine is inert for this long. */
export const MINE_ARM_MS = 2_000;
/** Distance from a mine to a target's centre that sets it off. */
export const MINE_TRIGGER_RANGE = 110;
/** Damage to the ship that sets it off. */
export const MINE_DAMAGE = 260;
/** Blast radius, for the explosion visual. */
export const MINE_BLAST_RADIUS = 140;
/** Mines are laid on a ring this far from the layer's centre. */
export const MINE_RING_MIN = 420;
export const MINE_RING_MAX = 760;
/** Mines keep this far from structures, asteroids and each other. */
export const MINE_CLEARANCE = 90;

/** Server → client: a mine went off (an accelerator for the blast visual; the
 *  mine leaving room state `mines` is the truth, #16). */
export const MineDetonatedSchema = z
  .object({
    type: z.literal('mine_detonated'),
    x: z.number(),
    y: z.number(),
    radius: z.number().nonnegative(),
  })
  .strict();
export type MineDetonated = z.infer<typeof MineDetonatedSchema>;
