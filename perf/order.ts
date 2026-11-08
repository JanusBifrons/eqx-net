/**
 * Rep count and arm order for the perf runner (plan machine-independent-perf
 * WS1). Pure, so it is unit-tested (perf/order.test.ts).
 */

/** Round odd rep counts up to even, so each arm runs second equally often. */
export function evenReps(reps: number): number {
  const r = Math.max(1, Math.floor(reps));
  return r % 2 ? r + 1 : r;
}

/** All 6 orders of [base, head, aa]; base-before-head flips every step. */
const PERMS3 = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]] as const;

/**
 * Arm order for rep `i`. Two arms alternate (A B, B A, …): the arm that runs
 * second in a round runs on a warmer machine. With the A/A arm the order walks
 * all 6 permutations of [base, head, aa]; base-before-head still flips every
 * rep, so any even rep count balances head against base.
 */
export function armOrder<T>(arms: readonly T[], i: number): T[] {
  if (arms.length === 3) return PERMS3[i % 6]!.map((k) => arms[k]!);
  return i % 2 === 0 ? [...arms] : [...arms].reverse();
}
