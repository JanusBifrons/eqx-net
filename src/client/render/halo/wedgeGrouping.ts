/**
 * Pure wedge-grouping helpers for halo radar. Collapses distant entities
 * into angular wedge representatives so a swarm of N drones doesn't
 * produce N arrows. Extracted from the monolithic `HaloRadar.ts` per the
 * god-file refactor plan (`docs/plans/refactor-god-files.md`, commit 7).
 */

// Phase D: angular bucket size for wedge grouping. 24 wedges around the
// full ring at 15° each.
const RADAR_WEDGE_DEG = 15;
export const RADAR_WEDGE_COUNT = Math.round(360 / RADAR_WEDGE_DEG);

// Beyond this distance, entities collapse into angular-wedge
// representatives instead of each getting their own arrow.
export const RADAR_GROUPING_DISTANCE = 2000;

// Beyond this distance, no arrow at all (distinct from `DIST_MAX`,
// which is just the lerp-finish point for radius/scale). Between
// `DIST_MAX` and `RADAR_MAX_DISTANCE` the arrow sits at the outer ring at
// the far scale, then disappears past the cutoff.
export const RADAR_MAX_DISTANCE = 10000;

export interface Candidate {
  key: string;
  x: number;
  y: number;
  color: number;
  dist: number;
  /** Whether this entry should render with the hostile glow + bright
   *  stroke. Defaults to false; set true by the radar for drones the
   *  client AI currently treats as hostile to the local player. */
  hostile?: boolean;
  /** Whether this entry represents a wedge (one arrow standing in for
   *  N grouped entities at the same bearing). Drives the wider/blunter
   *  silhouette so the player can distinguish a single off-screen target
   *  from an aggregated group at a glance. */
  grouped?: boolean;
}

/** Caller-owned scratch for `partitionAndGroupCandidates` — paradigm
 *  plan (quirky-rabbit) Phase 5c. Pre-fix the function allocated
 *  `result`, `wedges`, and one wedge-representative literal per emitted
 *  wedge on every call (radar tick @ 60-90 fps). When `scratch` is
 *  supplied, all three reuse caller-owned instances; pure-function
 *  contract preserved (same inputs → same return value; only the
 *  injected scratch is mutated).
 *
 *  Call site (`HaloRadar`) holds this as a class field. */
export interface PartitionScratch {
  /** Reused across calls; cleared on entry. */
  readonly result: Candidate[];
  /** Reused across calls; cleared on entry. */
  readonly wedges: Map<number, Candidate>;
  /** Pool of mutable wedge-representative Candidate instances. Acquired
   *  by index as wedges are emitted; subsequent calls reuse the same
   *  instances. */
  readonly wedgeReps: Candidate[];
}

/** Pre-allocated wedge-key strings indexed by wedge index. Avoids the
 *  `` `wedge:${idx}` `` template-literal alloc per emitted wedge — at
 *  RADAR_WEDGE_COUNT = 24 we cap at 64 to cover any reasonable future
 *  re-tuning. */
const _wedgeKeys: string[] = [];
for (let i = 0; i < 64; i++) _wedgeKeys.push(`wedge:${i}`);

function wedgeKey(idx: number): string {
  return _wedgeKeys[idx] ?? `wedge:${idx}`;
}

/**
 * Pure helper. Maps a world-space offset `(dx, dy)` to a wedge index in
 * `[0, wedgeCount)`. Wedge 0 starts at theta = -π (due west) and increases
 * counter-clockwise. atan2's east-zero / +π-edge convention is handled by
 * clamping the maximum index, so theta = π lands in the last wedge instead
 * of wrapping to 0.
 */
export function wedgeIndex(dx: number, dy: number, wedgeCount: number = RADAR_WEDGE_COUNT): number {
  const theta = Math.atan2(dy, dx);
  const t = (theta + Math.PI) / (2 * Math.PI);
  const raw = Math.floor(t * wedgeCount);
  if (raw < 0) return 0;
  if (raw >= wedgeCount) return wedgeCount - 1;
  return raw;
}

/**
 * Pure helper. Drops candidates past `maxDistance`, keeps every candidate
 * within `groupingDistance` as-is, and collapses the rest into angular
 * wedge representatives — the closest entity per wedge wins. The
 * representative inherits all member fields except `key`, which becomes
 * `wedge:${idx}` so the renderer can pool a single Graphics across whatever
 * entity currently leads that wedge.
 *
 * `scratch` (Phase 5c): when supplied, mutates the caller-owned scratch
 * instead of allocating per-call. Pure-function contract preserved:
 * same inputs → same returned reference (the scratch's `result` array);
 * absent `scratch` falls back to a fresh allocation per the legacy
 * shape so the unit tests (and any non-radar caller) don't need to know.
 */
export function partitionAndGroupCandidates(
  local: { x: number; y: number },
  candidates: ReadonlyArray<Candidate>,
  groupingDistance: number = RADAR_GROUPING_DISTANCE,
  maxDistance: number = RADAR_MAX_DISTANCE,
  wedgeCount: number = RADAR_WEDGE_COUNT,
  scratch?: PartitionScratch,
): Candidate[] {
  const result = scratch ? scratch.result : [];
  const wedges = scratch ? scratch.wedges : new Map<number, Candidate>();
  if (scratch) {
    result.length = 0;
    wedges.clear();
  }
  for (const c of candidates) {
    if (c.dist > maxDistance) continue;
    if (c.dist <= groupingDistance) {
      result.push(c);
      continue;
    }
    const idx = wedgeIndex(c.x - local.x, c.y - local.y, wedgeCount);
    const existing = wedges.get(idx);
    if (!existing || c.dist < existing.dist) {
      wedges.set(idx, c);
    }
  }
  // Emit wedge representatives — these are NEW Candidates (separate
  // from the input `c` so the caller's `c.key` isn't mutated). With
  // `scratch.wedgeReps` available, reuse pool instances; otherwise
  // allocate fresh literals.
  let repIdx = 0;
  for (const [idx, c] of wedges) {
    if (scratch) {
      let rep = scratch.wedgeReps[repIdx];
      if (!rep) {
        rep = { key: wedgeKey(idx), x: c.x, y: c.y, color: c.color, dist: c.dist, grouped: true };
        scratch.wedgeReps[repIdx] = rep;
      } else {
        rep.key = wedgeKey(idx);
        rep.x = c.x;
        rep.y = c.y;
        rep.color = c.color;
        rep.dist = c.dist;
        rep.grouped = true;
      }
      // hostile is optional — assign directly (set to false when absent
      // so a stale `true` from a prior tick doesn't leak through).
      rep.hostile = c.hostile ?? false;
      result.push(rep);
      repIdx++;
    } else {
      result.push({
        key: wedgeKey(idx),
        x: c.x,
        y: c.y,
        color: c.color,
        dist: c.dist,
        hostile: c.hostile,
        grouped: true,
      });
    }
  }
  return result;
}
