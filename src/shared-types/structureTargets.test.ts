/**
 * B2 (plan soft-leaping-truffle v3) — a turret's target can be a player, sent
 * as an owner-table index. The server encodes and the client decodes with the
 * same two helpers (#15); this locks that they round-trip and never collide
 * with a swarm entity id or "no target".
 */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_TARGET_NONE, decodePlayerTurretTarget, encodePlayerTurretTarget } from './structureStateWire.js';
import { gateAdmits } from './gateAccess.js';

describe('player turret targets on the wire', () => {
  it('round-trips every owner index', () => {
    for (let i = 0; i < 300; i++) expect(decodePlayerTurretTarget(encodePlayerTurretTarget(i))).toBe(i);
  });
  it('never decodes a swarm entity id or "none" as a player', () => {
    expect(decodePlayerTurretTarget(STRUCTURE_TARGET_NONE)).toBe(-1);
    for (const id of [0, 1, 7, 65535]) expect(decodePlayerTurretTarget(id)).toBe(-1);
    expect(encodePlayerTurretTarget(0)).toBeLessThan(STRUCTURE_TARGET_NONE);
  });
});

describe('gateAdmits (B2: relations from relationOf)', () => {
  it("admits the owner's own NPC side on every setting", () => {
    for (const access of ['allies', 'owner', 'open'] as const) {
      expect(gateAdmits(access, 'friendly')).toBe(true);
      expect(gateAdmits(access, 'self')).toBe(true);
      expect(gateAdmits(access, 'hostile')).toBe(false);
    }
  });
});
