/**
 * TransitStateMachine — Phase 8 sub-phase B.
 *
 * Pure, per-player. Drives the sequence of states a pilot moves through
 * during inter-sector transit:
 *
 *   DOCKED        — normal play, no transit in progress.
 *   SPOOLING      — engine charging up. The ship stays in the source room
 *                   and is fully damageable; can be cancelled via player
 *                   input or by being destroyed.
 *   IN_TRANSIT    — server has committed: SAB pose snapshotted to Limbo,
 *                   destination seat reservation issued. The ship is on
 *                   its way out of the source room.
 *   ARRIVED       — destination's `onJoin` has consumed the Limbo entry
 *                   and the pilot is back in the world. Brief state; the
 *                   client fades it out and `reset()` returns to DOCKED.
 *   CANCELLED     — terminal-cancel. The state value reads as DOCKED on
 *                   subsequent `state` reads (no `'CANCELLED'` on the bus
 *                   union — see Bus.ts; cancellation re-emits 'DOCKED').
 *
 * Mirrors the [SimulationClock] template (`src/core/clock/SimulationClock.ts`):
 * pure module, optional `Bus` constructor arg, no I/O, time injected via
 * `nowMs` parameters. Tests drive transitions synthetically.
 *
 * Invalid transitions throw — the machine is the single source of truth
 * for "is this transition legal right now?". The orchestrator catches the
 * throw and surfaces it as a transit_state {state:'DOCKED'} cancel.
 */
import type { Bus } from '../events/Bus.js';

export type TransitState =
  | 'DOCKED'
  | 'SPOOLING'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'CANCELLED';

export const SPOOL_DURATION_MS = 30_000;

export class TransitStateMachine {
  private _state: TransitState = 'DOCKED';
  private spoolStartMs = 0;
  private spoolEndMs = 0;

  constructor(
    private readonly playerId: string,
    private readonly bus?: Bus,
    private readonly spoolMs: number = SPOOL_DURATION_MS,
  ) {}

  /** Public state. CANCELLED reads as DOCKED to keep the bus surface small. */
  get state(): TransitState {
    return this._state === 'CANCELLED' ? 'DOCKED' : this._state;
  }

  /** Raw internal state — exposed only for testing / orchestrator-internal use. */
  get rawState(): TransitState {
    return this._state;
  }

  /** 0 outside SPOOLING; clamps to [0,1] during SPOOLING. */
  progress(nowMs: number): number {
    if (this._state !== 'SPOOLING') return 0;
    if (nowMs <= this.spoolStartMs) return 0;
    if (nowMs >= this.spoolEndMs) return 1;
    return (nowMs - this.spoolStartMs) / (this.spoolEndMs - this.spoolStartMs);
  }

  /** End-of-spool wall-clock, valid only while SPOOLING. */
  get scheduledCommitMs(): number {
    return this.spoolEndMs;
  }

  /** Begin spool-up. Legal from DOCKED only. Bus emits SPOOLING. */
  beginSpool(nowMs: number): void {
    if (this._state !== 'DOCKED') {
      throw new Error(`TransitStateMachine: cannot beginSpool from ${this._state}`);
    }
    this._state = 'SPOOLING';
    this.spoolStartMs = nowMs;
    this.spoolEndMs = nowMs + this.spoolMs;
    this.emit('SPOOLING');
  }

  /**
   * Cancel an in-flight spool. Legal from SPOOLING only — IN_TRANSIT has
   * already committed and the seat is reserved at the destination, so cancel
   * is no longer meaningful. Bus emits DOCKED.
   */
  cancel(): void {
    if (this._state !== 'SPOOLING') {
      throw new Error(`TransitStateMachine: cannot cancel from ${this._state}`);
    }
    this._state = 'CANCELLED';
    this.emit('DOCKED'); // bus union has no CANCELLED variant; re-emit DOCKED
  }

  /** Commit the spool. Legal from SPOOLING only. Bus emits IN_TRANSIT. */
  beginTransit(): void {
    if (this._state !== 'SPOOLING') {
      throw new Error(`TransitStateMachine: cannot beginTransit from ${this._state}`);
    }
    this._state = 'IN_TRANSIT';
    this.emit('IN_TRANSIT');
  }

  /** Mark arrival at the destination. Legal from IN_TRANSIT only. Bus emits ARRIVED. */
  arrive(): void {
    if (this._state !== 'IN_TRANSIT') {
      throw new Error(`TransitStateMachine: cannot arrive from ${this._state}`);
    }
    this._state = 'ARRIVED';
    this.emit('ARRIVED');
  }

  /** Return to DOCKED. Legal from ARRIVED or CANCELLED. No bus emit (a final
   *  ARRIVED → DOCKED transition is a UI fade, not a meaningful event;
   *  CANCELLED already re-emitted DOCKED on cancel()). */
  reset(): void {
    if (this._state !== 'ARRIVED' && this._state !== 'CANCELLED') {
      throw new Error(`TransitStateMachine: cannot reset from ${this._state}`);
    }
    this._state = 'DOCKED';
  }

  private emit(state: 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED'): void {
    this.bus?.emit('TRANSIT_STATE_CHANGED', {
      type: 'TRANSIT_STATE_CHANGED',
      playerId: this.playerId,
      state,
    });
  }
}
