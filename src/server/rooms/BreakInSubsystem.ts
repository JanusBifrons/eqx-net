/**
 * Break-ins (plan soft-leaping-truffle v3, C2). Decision logic over injected
 * hooks (unit-testable without a room; the TransitOrchestrator pattern).
 *
 * One channel per actor: { structure, start, duration }. Ticked with the 10 Hz
 * structure tick. It ends — FAILED — when the actor leaves range or dies, the
 * structure is gone, or the actor takes a hit (`onActorDamaged`); it ends —
 * SUCCEEDED — after its duration, granting the actor access to that
 * structure's cargo for BREAK_IN_ACCESS_MS. Starting is a hostile act; the
 * room's `onStart` records it and raises the alarm.
 */
import { BREAK_IN_ACCESS_MS } from '../../shared-types/breakIn.js';

export interface BreakInDeps {
  now(): number;
  /** Is the actor alive, active and within range of the structure? */
  canContinue(actor: string, structureId: string): boolean;
  /** Does the structure still exist? */
  exists(structureId: string): boolean;
  onStart(actor: string, structureId: string): void;
  onEnd(actor: string, structureId: string, outcome: 'success' | 'interrupted', reason: string): void;
}

interface Channel { structureId: string; startMs: number; durationMs: number }

export class BreakInSubsystem {
  private readonly channels = new Map<string, Channel>();
  /** `${actor}|${structureId}` → access expiry (ms). */
  private readonly grants = new Map<string, number>();

  constructor(private readonly d: BreakInDeps) {}

  /** Start breaking in (replaces any channel the actor had). */
  start(actor: string, structureId: string, durationMs: number): void {
    this.channels.set(actor, { structureId, startMs: this.d.now(), durationMs: Math.max(1, durationMs) });
    this.d.onStart(actor, structureId);
  }

  cancel(actor: string, reason: string): void {
    const c = this.channels.get(actor);
    if (!c) return;
    this.channels.delete(actor);
    this.d.onEnd(actor, c.structureId, 'interrupted', reason);
  }

  /** A hit ends the actor's break-in (cheap: one Map lookup). */
  onActorDamaged(actor: string): void {
    if (this.channels.has(actor)) this.cancel(actor, 'You were hit.');
  }

  tick(): void {
    if (this.channels.size === 0 && this.grants.size === 0) return;
    const now = this.d.now();
    for (const [actor, c] of [...this.channels]) {
      if (!this.d.exists(c.structureId)) { this.cancel(actor, 'It is gone.'); continue; }
      if (!this.d.canContinue(actor, c.structureId)) { this.cancel(actor, 'You moved away.'); continue; }
      if (now - c.startMs >= c.durationMs) {
        this.channels.delete(actor);
        this.grants.set(`${actor}|${c.structureId}`, now + BREAK_IN_ACCESS_MS);
        this.d.onEnd(actor, c.structureId, 'success', 'You are in.');
      }
    }
    for (const [k, until] of [...this.grants]) if (until <= now) this.grants.delete(k);
  }

  /** The actor's progress on this structure (0..1), or null when not breaking in. */
  progress(actor: string, structureId: string): number | null {
    const c = this.channels.get(actor);
    if (!c || c.structureId !== structureId) return null;
    return Math.min(1, (this.d.now() - c.startMs) / c.durationMs);
  }

  hasGrant(actor: string, structureId: string): boolean {
    const until = this.grants.get(`${actor}|${structureId}`);
    return until !== undefined && until > this.d.now();
  }

  /** Is anyone breaking into this structure right now? (the BREACH flag) */
  breached(structureId: string): boolean {
    for (const c of this.channels.values()) if (c.structureId === structureId) return true;
    return false;
  }

  activeCount(): number {
    return this.channels.size;
  }
}
