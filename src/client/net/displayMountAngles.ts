/**
 * Drawn turret angles for snapshot-driven ships (capitals, drones).
 *
 * A drone's mount angles arrive in the 20 Hz JSON snapshot and replaced the
 * drawn angles outright, so a turning capital turret moved in 20 steps a
 * second: one frame in three moved, two held (hostile audit 2026-11-07,
 * bystander clip). Each frame the drawn angle is now the latest snapshot
 * angle carried forward at the turret's turning rate (measured from the last
 * two snapshots, capped at two snapshot intervals), followed at a bounded
 * rate so nothing jumps. A first sight or a jump beyond DISPLAY_SNAP_RAD
 * snaps. Pure, in place, alloc-free once sized (#14).
 *
 * A new snapshot is detected by array identity: the snapshot apply stores a
 * fresh copy per snapshot (`applyDroneMountAngles`).
 */
import { wrapPi } from '@core/ai/WeaponMountController';

/** The drawn angle may turn this much faster than the turret, to catch up. */
export const DISPLAY_SLEW_CATCHUP = 2;
/** A jump bigger than this (rad) is a reset, not a turn: snap. */
export const DISPLAY_SNAP_RAD = 0.6;
/** Snapshot spacing assumed before two snapshots have been seen (s). */
const DEFAULT_INTERVAL_S = 0.05;

export interface DisplayMountEntry {
  mountAngles?: number[];
  displayMountAngles?: number[];
  /** Follower state (renderer ignores these). */
  _dmRef?: number[];
  _dmBase?: number[];
  _dmRate?: number[];
  _dmSince?: number;
  _dmInterval?: number;
}

export function slewDisplayMountAngles(
  entry: DisplayMountEntry,
  mounts: ReadonlyArray<{ rotationSpeed: number }> | undefined,
  dtSec: number,
): void {
  const target = entry.mountAngles;
  if (!target) {
    entry.displayMountAngles = undefined;
    entry._dmRef = undefined;
    return;
  }
  const n = target.length;
  let d = entry.displayMountAngles, base = entry._dmBase, rate = entry._dmRate;
  if (!d || !base || !rate || d.length !== n) {
    // TODO: alloc-debt — once per entry (or when its mount count changes).
    entry.displayMountAngles = target.slice();
    entry._dmBase = target.slice();
    entry._dmRate = new Array<number>(n).fill(0);
    entry._dmRef = target;
    entry._dmSince = 0;
    entry._dmInterval = DEFAULT_INTERVAL_S;
    return;
  }
  // Time since the last snapshot, counted on every frame (this one too).
  entry._dmSince = (entry._dmSince ?? 0) + dtSec;
  if (target !== entry._dmRef) {
    // A new snapshot: its turning rate from the previous one. The drawn
    // angle carried forward from the old one already stands about here.
    const since = entry._dmSince;
    const interval = since > 0.005 && since < 0.25 ? since : DEFAULT_INTERVAL_S;
    for (let i = 0; i < n; i++) {
      const max = (mounts?.[i]?.rotationSpeed ?? 0) * DISPLAY_SLEW_CATCHUP;
      const r = wrapPi(target[i]! - base[i]!) / interval;
      rate[i] = r > max ? max : r < -max ? -max : r;
      base[i] = target[i]!;
    }
    entry._dmRef = target;
    entry._dmInterval = interval;
    entry._dmSince = 0;
  }
  // Up to two intervals ahead: snapshots arrive unevenly (a 2-frame gap
  // then a 4-frame one held the turret still). If it stops, the overshoot is
  // one interval of turning (a 16" turret: 0.2 degrees), followed out smoothly.
  const ahead = Math.min(entry._dmSince ?? 0, 2 * (entry._dmInterval ?? DEFAULT_INTERVAL_S));
  for (let i = 0; i < n; i++) {
    const est = base[i]! + rate[i]! * ahead;
    const diff = wrapPi(est - d[i]!);
    const speed = (mounts?.[i]?.rotationSpeed ?? 0) * DISPLAY_SLEW_CATCHUP;
    if (!(speed > 0) || Math.abs(diff) > DISPLAY_SNAP_RAD) { d[i] = est; continue; }
    const step = speed * dtSec;
    d[i] = d[i]! + (diff > step ? step : diff < -step ? -step : diff);
  }
}
