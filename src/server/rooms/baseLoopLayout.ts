/** The `base-loop` perf scene layout (`perfRooms.ts`). Its own file so
*  `scenarioLayouts.ts` stays under the 600-line cap. */

import type { RecipeId } from '../../shared-types/recipes.js';
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { PREBUILT_ADOPT_OWNER } from './scenarioLayouts.js';

/** Perf scene `base-loop`: the Sunday-loop base in sol-prime's belt clearing
 *  (r 4900; no rock inside). Capital (pad west) + 3 Solars, a Shipyard building an
 *  Interceptor (east), Refinery and Cargo Bay (south), a Turret and two Shield
 *  Pylons with their wall. Past the Shipyard (teleporter redesign T6): a
 *  powered, paired Teleporter pair on a relay, and an Ancients' gate beyond
 *  them, all in the scene's view. 410 power for 300 used. The first joiner
 *  adopts the base (not the gate: the Ancients own it). */
export const BASE_LOOP_AT = { x: 96_626, y: 80_499 } as const;
const loop = (kind: string, x: number, y: number, more?: { rot?: number; recipe?: RecipeId }) =>
  ({ kind, x: BASE_LOOP_AT.x + x, y: BASE_LOOP_AT.y + y, ...more });
export const BASE_LOOP_OPTS = {
  prebuiltStructures: [
    loop('capital', 0, 0, { rot: 90 }), loop('connector', 0, 380), loop('connector', 0, -380), loop('connector', 420, 0),
    loop('solar', 450, 500), loop('solar', -450, 500), loop('solar', 450, -500),
    loop('shipyard', 1000, 0, { recipe: 'build_interceptor' }),
    loop('refinery', -450, -600), loop('connector', 0, -950), loop('cargo_bay', -400, -1100),
    loop('turret', 300, -1100), loop('shield_pylon', -350, -1450), loop('shield_pylon', 350, -1450),
    // The relay west of the two pads, then the pads (paired at seed).
    loop('connector', 1615, -50), loop('teleporter', 2150, 450), loop('teleporter', 2150, -550),
  ],
  prebuiltStructuresOwner: PREBUILT_ADOPT_OWNER,
  prebuiltCapitalMinerals: CAPITAL_STARTING_MINERALS,
  pairTeleporters: true,
  /** The Ancients' gate east of the pads (its own seeder, `seedAlienGates`). */
  testAlienGate: { x: BASE_LOOP_AT.x + 3500, y: BASE_LOOP_AT.y - 100, neighbour: 'vega-reach' },
};
