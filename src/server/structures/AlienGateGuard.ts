/**
 * Alien gate guns (plan soft-leaping-truffle v4, phase A). The Ancients'
 * gates can't be damaged; instead their built-in turrets DISABLE anyone who
 * attacks one: whoever hits a gate, or fires a weapon inside a gate's zone.
 * A disabled ship's engines and weapons are offline for
 * `DISABLE_DURATION_MS`; the timer restarts while the attack goes on. Hulls
 * are untouched. It covers players and NPC ships alike.
 *
 * This class owns the disable deadlines (keyed by player id for pilots, by
 * swarm id for NPC ships, plus the swarm slot so AI intents can be zeroed by
 * slot). The room applies the effect: input bits (shared `gateDisabledInput`),
 * fire, AI intents, and the own-ship snapshot's `disabledMs` (#16).
 *
 * Steady state (no gates, or nobody disabled) costs one size check.
 */
import { DISABLE_DURATION_MS } from '../../core/combat/disable.js';
import type { StructureRecord } from './StructureRegistry.js';

/** Firing within this distance of a gate's centre counts as attacking it. */
export const ALIEN_GATE_GUARD_RADIUS = 2500;

export interface AlienGateGuardHooks {
  /** The swarm slot of an NPC ship (undefined for a player or unknown id). */
  swarmSlotOf(id: string): number | undefined;
  /** An actor was just disabled (log, effects). `gate` is the gate that fired. */
  onDisabled?(actorId: string, gate: StructureRecord): void;
}

export class AlienGateGuard {
  private readonly gates: StructureRecord[] = [];
  private readonly disabledUntil = new Map<string, number>();
  /** Swarm slot → deadline, for the AI intent gate (posted by slot). */
  private readonly slotUntil = new Map<number, number>();

  constructor(private readonly h: AlienGateGuardHooks) {}

  /** Register a seeded gate (they never move or die). */
  addGate(rec: StructureRecord): void {
    this.gates.push(rec);
  }

  get gateCount(): number {
    return this.gates.length;
  }

  isGate(id: string): boolean {
    if (this.gates.length === 0) return false;
    for (const g of this.gates) if (g.id === id) return true;
    return false;
  }

  /** Someone hit a gate: disable them. */
  onGateAttacked(gateId: string, attackerId: string, nowMs: number): void {
    for (const g of this.gates) {
      if (g.id === gateId) {
        this.disable(attackerId, g, nowMs);
        return;
      }
    }
  }

  /** Someone fired at (x, y): disable them if that is inside a gate's zone. */
  onFired(shooterId: string, x: number, y: number, nowMs: number): void {
    if (this.gates.length === 0) return;
    const r2 = ALIEN_GATE_GUARD_RADIUS * ALIEN_GATE_GUARD_RADIUS;
    for (const g of this.gates) {
      const dx = x - g.x;
      const dy = y - g.y;
      if (dx * dx + dy * dy <= r2) {
        this.disable(shooterId, g, nowMs);
        return;
      }
    }
  }

  private disable(actorId: string, gate: StructureRecord, nowMs: number): void {
    // A structure (a turret) can't be disabled like a ship; its hits on the
    // gate simply do nothing.
    if (actorId.startsWith('pstruct-')) return;
    const until = nowMs + DISABLE_DURATION_MS;
    const was = this.disabledUntil.get(actorId) ?? 0;
    this.disabledUntil.set(actorId, until);
    const slot = this.h.swarmSlotOf(actorId);
    if (slot !== undefined) this.slotUntil.set(slot, until);
    if (was <= nowMs) this.h.onDisabled?.(actorId, gate);
  }

  isDisabled(id: string, nowMs: number): boolean {
    if (this.disabledUntil.size === 0) return false;
    return (this.disabledUntil.get(id) ?? 0) > nowMs;
  }

  isSlotDisabled(slot: number, nowMs: number): boolean {
    if (this.slotUntil.size === 0) return false;
    return (this.slotUntil.get(slot) ?? 0) > nowMs;
  }

  /** Remaining disabled time (ms), 0 when not disabled. */
  remainingMs(id: string, nowMs: number): number {
    if (this.disabledUntil.size === 0) return 0;
    return Math.max(0, (this.disabledUntil.get(id) ?? 0) - nowMs);
  }

  /** Forget a ship that left (its slot may be reused). */
  forget(id: string): void {
    this.disabledUntil.delete(id);
    const slot = this.h.swarmSlotOf(id);
    if (slot !== undefined) this.slotUntil.delete(slot);
  }

  /** Drop expired deadlines (call at ~1 Hz). */
  sweep(nowMs: number): void {
    for (const [id, until] of this.disabledUntil) if (until <= nowMs) this.disabledUntil.delete(id);
    for (const [slot, until] of this.slotUntil) if (until <= nowMs) this.slotUntil.delete(slot);
  }
}

/** Ops kill switch: `EQX_DISABLE_ALIEN_GATES=1` seeds no alien gates. */
export function isAlienGatesDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env['EQX_DISABLE_ALIEN_GATES'];
  return v === '1' || v === 'true';
}
