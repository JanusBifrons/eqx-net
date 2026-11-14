/**
 * Dev-only wreck WAKE CENSUS (sub-cap debris soak follow-up, 2026-11-13):
 * what keeps permanent wreck pieces awake in a live fight. Off unless the
 * physics worker runs with `EQX_WAKE_CENSUS=1`; then the worker feeds it
 * every wreck piece's Rapier sleep state each tick, plus every impulse
 * command, and posts `sample()` as a `WAKE_CENSUS` message every
 * `WAKE_CENSUS_EVERY_TICKS`. `/dev/perf` carries the latest one
 * (`ScenePerfView.wakeCensus`).
 *
 * Two views:
 *  - `wakes`: every asleep → awake flip of a piece, by its cause this tick:
 *    an impulse command (`knock` = WRECK_IMPULSE / WRECK_RIGID_IMPULSE,
 *    `missile`, `kick`), else the fastest body it touches (`shipSlow` /
 *    `shipFast` split at `SLOW_SHIP_SPEED`, `piece`, `scrap`), else `none`
 *    (woken through an island with no contact of its own).
 *  - `awakeNow`: at the sample, why each awake piece is awake: touching a
 *    ship / piece / scrap, `drifting` (over Rapier's sleep thresholds), or
 *    `settling` (under them: Rapier's 2 s sleep timer is running).
 * Not on any production path; allocations here are dev-only.
 */
import type { PhysicsWorld } from './World.js';

export const WAKE_CENSUS_EVERY_TICKS = 300;
/** A contacting ship slower than this counts as `shipSlow`. */
const SLOW_SHIP_SPEED = 20;
/** Rapier's default sleep thresholds at lengthUnit 1 (u/s, rad/s). */
const RAPIER_LINEAR_SLEEP = 0.4;
const RAPIER_ANGULAR_SLEEP = 0.5;
/** "Old" pieces: the soak target is >= 80 % of these asleep. */
const OLD_TICKS = 20 * 60;

export type WakeCause = 'knock' | 'missile' | 'kick' | 'shipSlow' | 'shipFast' | 'piece' | 'scrap' | 'none';
export type AwakeReason = 'ship' | 'piece' | 'scrap' | 'drifting' | 'settling';

export interface WakeCensusSample {
  tick: number;
  pieces: number;
  asleep: number;
  oldPieces: number;
  oldAsleep: number;
  neverSleptAwake: number;
  wakes: Record<WakeCause, number>;
  /** Wakes of a piece that had been asleep >= 12 ticks (flagged SLEEPING). */
  wakesFromRest: Record<WakeCause, number>;
  awakeNow: Record<AwakeReason, number>;
}

function zeroWakes(): Record<WakeCause, number> {
  return { knock: 0, missile: 0, kick: 0, shipSlow: 0, shipFast: 0, piece: 0, scrap: 0, none: 0 };
}

function classifyOther(otherId: string, speed: number): WakeCause {
  if (otherId.startsWith('wreck-')) return 'piece';
  if (otherId.startsWith('scrap-')) return 'scrap';
  return speed < SLOW_SHIP_SPEED ? 'shipSlow' : 'shipFast';
}

export class WakeCensus {
  private readonly impulsed = new Map<string, WakeCause>();
  private readonly firstTick = new Map<string, number>();
  private readonly everSlept = new Set<string>();
  private readonly wakes = zeroWakes();
  private readonly wakesFromRest = zeroWakes();

  noteImpulse(id: string, cause: 'knock' | 'missile' | 'kick'): void {
    if (id.startsWith('wreck-')) this.impulsed.set(id, cause);
  }

  /** Per tick per wreck piece, after the step. */
  poll(physics: PhysicsWorld, id: string, tick: number, wasSleeping: boolean, wasFlagged: boolean, sleeping: boolean): void {
    if (!this.firstTick.has(id)) this.firstTick.set(id, tick);
    if (sleeping) { this.everSlept.add(id); return; }
    if (!wasSleeping) return;
    let cause: WakeCause = this.impulsed.get(id) ?? 'none';
    if (cause === 'none') {
      const c = physics.fastestContact(id);
      if (c !== null) cause = classifyOther(c.otherId, c.speed);
    }
    this.wakes[cause]++;
    if (wasFlagged) this.wakesFromRest[cause]++;
  }

  /** After the poll each tick: impulses only count for the tick they landed. */
  endTick(): void {
    this.impulsed.clear();
  }

  forget(id: string): void {
    this.firstTick.delete(id);
    this.everSlept.delete(id);
  }

  sample(physics: PhysicsWorld, ids: Iterable<string>, tick: number): WakeCensusSample {
    const awakeNow: Record<AwakeReason, number> = { ship: 0, piece: 0, scrap: 0, drifting: 0, settling: 0 };
    let pieces = 0, asleep = 0, oldPieces = 0, oldAsleep = 0, neverSleptAwake = 0;
    for (const id of ids) {
      if (!id.startsWith('wreck-')) continue;
      pieces++;
      const old = tick - (this.firstTick.get(id) ?? tick) >= OLD_TICKS;
      if (old) oldPieces++;
      if (physics.isSleeping(id)) {
        asleep++;
        if (old) oldAsleep++;
        continue;
      }
      if (!this.everSlept.has(id)) neverSleptAwake++;
      const c = physics.fastestContact(id);
      if (c !== null) {
        const k = classifyOther(c.otherId, c.speed);
        awakeNow[k === 'shipSlow' || k === 'shipFast' ? 'ship' : k === 'piece' ? 'piece' : 'scrap']++;
        continue;
      }
      const s = physics.getShipState(id);
      const v = s ? Math.hypot(s.vx, s.vy) : 0;
      const w = s ? Math.abs(s.angvel ?? 0) : 0;
      awakeNow[v > RAPIER_LINEAR_SLEEP || w > RAPIER_ANGULAR_SLEEP ? 'drifting' : 'settling']++;
    }
    return {
      tick, pieces, asleep, oldPieces, oldAsleep, neverSleptAwake,
      wakes: { ...this.wakes }, wakesFromRest: { ...this.wakesFromRest }, awakeNow,
    };
  }
}
