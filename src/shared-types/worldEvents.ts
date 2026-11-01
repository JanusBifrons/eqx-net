/**
 * World events (Living World P4b, plan peppy-jumping-pinwheel).
 *
 * A world event is a short, sector-wide happening players can travel to:
 *
 *  - `incursion`  — a hostile robot strike group. Destroy every raider and a
 *                   reward cache drops where the group stood.
 *  - `mothership` — a drone mothership (a 6×-hull named carrier) with escorts.
 *                   Its kill drops the elite-style haul.
 *  - `salvage`    — a salvage field: rich loot pods scattered for a short time.
 *
 * Built only from existing ship kinds (no catalogue bump). The truth for
 * clients is the galaxy snapshot's per-sector `event`; `world_notice` toasts
 * are accelerators (#16). Shared so both sides agree (#15).
 */
import { z } from 'zod';
import type { Hold } from './goods.js';
import { INCURSION_BLUEPRINT_CHANCE, rollBlueprint } from './blueprints.js';

export const WORLD_EVENT_KINDS = ['incursion', 'mothership', 'salvage'] as const;
export type WorldEventKind = (typeof WORLD_EVENT_KINDS)[number];

/** Event NPC ids (owned by the server `EventDirector`). */
export const EVENT_ID_PREFIX = 'event-';

export function isEventId(id: string): boolean {
  return id.startsWith(EVENT_ID_PREFIX);
}

export const WORLD_EVENT_TITLES: Readonly<Record<WorldEventKind, string>> = {
  incursion: 'Robot Incursion',
  mothership: 'Drone Mothership',
  salvage: 'Salvage Field',
};

/** How long an unfinished event lasts before it fades (ms). */
export const WORLD_EVENT_DURATION_MS: Readonly<Record<WorldEventKind, number>> = {
  incursion: 10 * 60_000,
  mothership: 12 * 60_000,
  salvage: 5 * 60_000,
};

/** The mothership's hull is this many times its kind's (an elite is 4×). */
export const MOTHERSHIP_HEALTH_MUL = 6;
/** Pods in a salvage field. */
export const SALVAGE_POD_COUNT = 6;

/** A live event as the galaxy map sees it (per sector). */
export interface WorldEventView {
  kind: WorldEventKind;
  title: string;
  /** Wall-clock ms when it fades if not finished. */
  endsAtMs: number;
}

export const WorldEventViewSchema = z
  .object({
    kind: z.enum(WORLD_EVENT_KINDS),
    title: z.string().max(60),
    endsAtMs: z.number().nonnegative(),
  })
  .strict();

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** The cache dropped when an incursion is wiped out. */
export function rollIncursionCache(rng: () => number): Hold {
  // P5 — an incursion cache often carries a blueprint.
  const bp = rollBlueprint(rng, INCURSION_BLUEPRINT_CHANCE);
  return {
    goods: { salvage: randInt(rng, 40, 80), alloy: randInt(rng, 10, 20), core: randInt(rng, 1, 3) },
    blueprints: bp !== null ? [bp] : [],
  };
}

/** One pod of a salvage field. */
export function rollSalvagePod(rng: () => number): Hold {
  return {
    goods: { salvage: randInt(rng, 20, 45), alloy: randInt(rng, 2, 8) },
    blueprints: [],
  };
}
