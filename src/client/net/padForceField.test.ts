/**
 * Redesign T3 — the prediction world's pad push matches the server's
 * (`teleportMessages`, #15): a chamber carries its rotation as `doorAngle`
 * (push along the doorways only), the Ancients' gate none.
 */
import { describe, expect, it } from 'vitest';
import type { PadForceField } from '@core/physics/forceFields';
import { PAD_SPECS, TP_PHASE } from '../../shared-types/teleport.js';
import { writePadForceField } from './padForceField.js';

const scratch = (): PadForceField => ({ kind: 'pad', cx: 0, cy: 0, half: 0, active: false });

describe('writePadForceField', () => {
  it('a chamber pad pushes along its doorways: doorAngle = its rotation', () => {
    for (const kind of ['teleporter', 'teleporter_large', 'pocket_pad'] as const) {
      const f = writePadForceField(scratch(), kind, 10, 20, Math.PI / 2, TP_PHASE.CLOSING);
      expect(f).toMatchObject({ cx: 10, cy: 20, half: PAD_SPECS[kind].padRadius, active: true, doorAngle: Math.PI / 2 });
    }
  });

  it('the Ancients\' gate keeps the open square push (no doorAngle)', () => {
    const f = writePadForceField(scratch(), 'alien_gate', 0, 0, 1, TP_PHASE.CLOSING);
    expect(f.doorAngle).toBeUndefined();
    expect(f.active).toBe(true);
  });

  it('only CLOSING pushes; the scratch is rewritten in place', () => {
    const s = scratch();
    expect(writePadForceField(s, 'teleporter', 0, 0, 0, TP_PHASE.SEALED)).toBe(s);
    expect(s.active).toBe(false);
    expect(s.doorAngle).toBe(0);
    writePadForceField(s, 'alien_gate', 0, 0, 0, TP_PHASE.ARMED);
    expect(s.doorAngle).toBeUndefined();
  });
});
