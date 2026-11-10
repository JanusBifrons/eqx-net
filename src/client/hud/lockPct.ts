/**
 * The percent shown for a lock that is still ACQUIRING (or failsafe, or
 * draining). The wire progress `p` is rounded server-side (99.6 → 100), so a
 * lock one tick from done read "LOCKING ON YOU 100%" before the LOCKED stage
 * arrived (frame review 2026-11-10). Floor it and cap it at 99: only the
 * LOCKED stage ever reads as complete. Pure, alloc-free (per-frame safe).
 */
export function acquiringPct(p: number): number {
  if (!(p > 0)) return 0;
  return p >= 99 ? 99 : Math.floor(p);
}
