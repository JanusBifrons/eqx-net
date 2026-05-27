/**
 * Canonical catalogue order. THIS FILE IS WIRE-FORMAT-STABLE.
 *
 * The swarm binary wire encodes a drone's kind as a u8 index into
 * `SHIP_KINDS_LIST`. Reordering or removing entries breaks decode for any
 * snapshot persisted by an older build. Adding new entries is safe IFF
 * they are APPENDED to the end of this list (and the catalogue version
 * bumped per `SHIP_KIND_CATALOGUE_VERSION`).
 *
 * The single point of truth for the wire order is the array below. The
 * `SHIP_KINDS` object derives from it (NOT the other way round), so both
 * `Object.values(SHIP_KINDS)` and `SHIP_KINDS_LIST` will agree by
 * construction. The golden snapshot test in
 * `tests/unit/shipKinds.test.ts` snapshots both maps to lock the order.
 *
 * Per the god-file refactor plan (`docs/plans/refactor-god-files.md`,
 * commit 4): isolating ordering here makes it visually obvious in code
 * review when someone tries to reorder it. The original
 * `Object.values(Object.freeze({...}))` pattern was already ES2015-
 * deterministic; this split is for readability + a future-proof anchor.
 */

import type { ShipKind } from './types.js';
import { SCOUT, FIGHTER } from './fighters.js';
import { HEAVY, INTERCEPTOR, GUNSHIP } from './heavyClass.js';
import { CROSSGUARD } from './crossguard.js';

/**
 * Insertion order = canonical catalogue order. Fighter is first so it
 * satisfies the "default to the first ship in the list" rule and so it
 * ends up at index 0 of `SHIP_KINDS_LIST`. Appending new kinds is safe;
 * reordering or removing entries breaks decode for older snapshots.
 */
export const SHIP_KINDS_LIST: readonly ShipKind[] = Object.freeze([
  FIGHTER,
  SCOUT,
  HEAVY,
  INTERCEPTOR,
  GUNSHIP,
  CROSSGUARD,
]);
