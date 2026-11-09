/**
 * Count budgets for the perf scenes (plan prancy-squishing-donut P3.5),
 * gated on every PR by `tests/integration/sectorRoom/perfSceneCounts.test.ts`.
 *
 * Counts, not timings: they barely depend on the machine. Each budget names
 * the measurement that set it. Raise one only with a new measurement and a
 * reason in the PR, never to get green; shrink the design instead.
 */
export interface CountBudget {
  /** Bytes a pilot's socket receives per second, over the test window (KB/s). */
  rxKBps: number;
  /** The scene must be at least this busy, or the run says nothing. */
  minSwarm: number;
  /** Where the number came from. */
  measured: string;
}

export const COUNT_BUDGETS: Record<string, CountBudget> = {
  // 2026-11-06, laptop, two runs: 216 / 218 KB/s (swarm 67); browser runs 216–263.
  'fleet-fight': { rxKBps: 275, minSwarm: 30, measured: '216–218 KB/s, 2026-11-06' },
  // 2026-11-06, laptop, two runs: 67.8 / 67.8 KB/s (174 entities: citadel + raid).
  'teleport-raid': { rxKBps: 85, minSwarm: 100, measured: '67.8 KB/s, 2026-11-06' },
  // 2026-11-09, laptop, two runs: 17.1 / 16.9 KB/s (swarm 29: the fleet + two robot waves).
  'capital-fleet': { rxKBps: 22, minSwarm: 20, measured: '16.9–17.1 KB/s, 2026-11-09' },
  // 2026-11-09, laptop, two runs: 11.6 / 11.6 KB/s (one battleship firing on the pilot).
  'capital-duel': { rxKBps: 15, minSwarm: 1, measured: '11.6 KB/s, 2026-11-09' },
};
