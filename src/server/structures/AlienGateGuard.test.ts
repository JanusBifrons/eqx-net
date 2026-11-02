import { describe, it, expect } from 'vitest';
import { ALIEN_GATE_GUARD_RADIUS, AlienGateGuard } from './AlienGateGuard.js';
import { DISABLE_DURATION_MS } from '../../core/combat/disable.js';
import type { StructureRecord } from './StructureRegistry.js';

const GATE = { id: 'pstruct-gate', kind: 'alien_gate', x: 3200, y: 0 } as unknown as StructureRecord;

function guard(): { g: AlienGateGuard; disabled: string[] } {
  const disabled: string[] = [];
  const g = new AlienGateGuard({
    swarmSlotOf: (id) => (id === 'drone-1' ? 7 : undefined),
    onDisabled: (id) => disabled.push(id),
  });
  g.addGate(GATE);
  return { g, disabled };
}

describe('AlienGateGuard (v4 A)', () => {
  it('disables whoever hits a gate, for the disable duration', () => {
    const { g, disabled } = guard();
    g.onGateAttacked(GATE.id, 'player-1', 1000);
    expect(g.isDisabled('player-1', 1000 + DISABLE_DURATION_MS - 1)).toBe(true);
    expect(g.isDisabled('player-1', 1000 + DISABLE_DURATION_MS)).toBe(false);
    expect(g.remainingMs('player-1', 1500)).toBe(DISABLE_DURATION_MS - 500);
    expect(disabled).toEqual(['player-1']);
  });

  it('keeps an attacker disabled while the attack goes on (one notice)', () => {
    const { g, disabled } = guard();
    g.onGateAttacked(GATE.id, 'player-1', 0);
    g.onGateAttacked(GATE.id, 'player-1', 8000);
    expect(g.isDisabled('player-1', 15_000)).toBe(true);
    expect(disabled).toEqual(['player-1']);
  });

  it('disables a shot fired inside the zone, not one outside', () => {
    const { g } = guard();
    g.onFired('near', GATE.x - ALIEN_GATE_GUARD_RADIUS + 10, 0, 0);
    g.onFired('far', GATE.x - ALIEN_GATE_GUARD_RADIUS - 10, 0, 0);
    expect(g.isDisabled('near', 1)).toBe(true);
    expect(g.isDisabled('far', 1)).toBe(false);
  });

  it('an NPC ship is also disabled by slot (its AI intents are zeroed)', () => {
    const { g } = guard();
    g.onGateAttacked(GATE.id, 'drone-1', 0);
    expect(g.isSlotDisabled(7, 1)).toBe(true);
    g.forget('drone-1');
    expect(g.isSlotDisabled(7, 1)).toBe(false); // a new ship in slot 7 starts clean
    expect(g.isDisabled('drone-1', 1)).toBe(false);
  });

  it('turrets are not disabled (their hits just do nothing)', () => {
    const { g } = guard();
    g.onGateAttacked(GATE.id, 'pstruct-turret', 0);
    expect(g.isDisabled('pstruct-turret', 1)).toBe(false);
  });

  it('only registered gates count', () => {
    const { g } = guard();
    expect(g.isGate(GATE.id)).toBe(true);
    expect(g.isGate('pstruct-other')).toBe(false);
  });

  it('sweeps expired deadlines', () => {
    const { g } = guard();
    g.onGateAttacked(GATE.id, 'drone-1', 0);
    g.sweep(DISABLE_DURATION_MS + 1);
    expect(g.remainingMs('drone-1', 0)).toBe(0);
    expect(g.isSlotDisabled(7, 0)).toBe(false);
  });
});
