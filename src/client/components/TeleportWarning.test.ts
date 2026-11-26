import { describe, expect, it } from 'vitest';
import { TP_PHASE } from '../../shared-types/teleport';
import { warningText } from './TeleportWarning';

describe('warningText', () => {
  it('tells a pilot on a teleporter pad about the pad and its doors', () => {
    expect(warningText('teleporter', TP_PHASE.ARMED)).toMatch(/pad/);
    expect(warningText('teleporter', TP_PHASE.CLOSING)).toMatch(/Doors/);
  });

  it("never talks about a pad or doors at an Ancients' gate (it has a ring, not doors)", () => {
    // Film 2026-11-26: "Stay on the pad … Doors closing." showed at the Sol Prime gate.
    for (const phase of [TP_PHASE.ARMED, TP_PHASE.CLOSING, TP_PHASE.SEALED]) {
      const text = warningText('alien_gate', phase);
      expect(text).toBeDefined();
      expect(text).not.toMatch(/pad|door/i);
    }
    // Owner 2026-11-26: the inner ring (round the light pool) is the one that closes.
    expect(warningText('alien_gate', TP_PHASE.CLOSING)).toBe('Inner ring closing.');
  });

  it('says nothing when idle or opening', () => {
    expect(warningText('alien_gate', TP_PHASE.IDLE)).toBeUndefined();
    expect(warningText('teleporter', TP_PHASE.OPEN)).toBeUndefined();
  });
});
