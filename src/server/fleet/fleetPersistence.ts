/**
 * RTS slice 9 — what a wingman keeps across a server restart, and the
 * hydrate-side validators for it.
 *
 * Persisted (in the sector snapshot, beside each lingering hull): the standing
 * MODE with its data (guard post / patrol route / escort id / retreat point),
 * the STANCE, and SQUAD membership (`squads[]`: id, owner, leader, members,
 * squad mode). Squads fly as a loose pack (RTS Part B slice 10): a squad
 * saved before then carries a formation `shape`, which hydrate ignores. Direct orders (move / attack) are NOT persisted: an
 * order is a one-off the owner gave at a moment that has passed.
 *
 * Every field is OPTIONAL in the snapshot (additive, no schema-version bump):
 * a snapshot written before slice 9 hydrates with default brains. Hydrate
 * re-validates every entry here (zod) and drops what fails; the subsystem
 * then re-checks ownership and escort targets like a live `set_mode`.
 */
import { z } from 'zod';
import { WingmanModeSchema, WingmanStanceSchema } from '../../shared-types/messages/clientMessages.js';
import { WINGMAN_ROUTE_MAX, type WingmanMode, type WingmanStance } from '../../core/ai/wingman/types.js';

/** Saved mode parameters (the `set_mode` fields that describe a standing job). */
export interface FleetSavedModeData {
  x?: number;
  y?: number;
  route?: Array<[number, number]>;
  escortId?: string;
}

/** One AI-flown ship's standing job. */
export interface FleetSavedShip {
  mode?: WingmanMode;
  modeData?: FleetSavedModeData;
  stance?: WingmanStance;
  /** The squad it belonged to (informational: `squads[]` is the authority). */
  squadId?: string;
}

/** One squad. */
export interface FleetSavedSquad {
  id: string;
  ownerId: string;
  leaderId: string;
  memberIds: string[];
  /** The squad-wide standing mode, when one was given. */
  mode?: WingmanMode;
  modeData?: FleetSavedModeData;
}

const Finite = z.number().refine(Number.isFinite);
const Id = z.string().min(1).max(64);

const ModeDataSchema = z.object({
  x: Finite.optional(),
  y: Finite.optional(),
  route: z.array(z.tuple([Finite, Finite])).max(WINGMAN_ROUTE_MAX).optional(),
  escortId: Id.optional(),
});

const SquadSchema = z.object({
  id: Id,
  ownerId: Id,
  leaderId: Id,
  memberIds: z.array(Id).max(64),
  // An old save's formation `shape` (wedge / line / column) is stripped.
  mode: WingmanModeSchema.optional(),
  modeData: ModeDataSchema.optional(),
});

/** The mode part of a saved ship, or null when absent / invalid. */
export function parseSavedMode(raw: { mode?: unknown; modeData?: unknown }): { mode: WingmanMode; modeData?: FleetSavedModeData } | null {
  const m = WingmanModeSchema.safeParse(raw.mode);
  if (!m.success) return null;
  if (raw.modeData === undefined) return { mode: m.data };
  const d = ModeDataSchema.safeParse(raw.modeData);
  if (!d.success) return null;
  return { mode: m.data, modeData: d.data as FleetSavedModeData };
}

/** The saved stance, or null when absent / invalid. */
export function parseSavedStance(raw: unknown): WingmanStance | null {
  const s = WingmanStanceSchema.safeParse(raw);
  return s.success ? s.data : null;
}

/** A saved squad, or null when invalid. */
export function parseSavedSquad(raw: unknown): FleetSavedSquad | null {
  const s = SquadSchema.safeParse(raw);
  return s.success ? (s.data as FleetSavedSquad) : null;
}
