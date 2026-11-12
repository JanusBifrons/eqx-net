/**
 * The local player's naval shells are not predicted: no ghost shell, no
 * damage number at fire time.
 *
 * Owner report (2026-11-12, long-guns clip, the player's second salvo):
 * "It instantly hit the other ship and still flew? And had graphical
 * glitches." Measured on the clip: the moment the salvo left, 2800 then 4200
 * appeared on the enemy, ~25 s before the shells arrived, and pixelated
 * blocks flickered at the turrets for ~0.6 s. Both were client prediction:
 * `predictShotOutcome` casts each barrel's line and shows the damage at once
 * (right for beams and short bolts), and a 500 ms ghost shell is drawn per
 * mount until the server's shells arrive. A naval shell flies for tens of
 * seconds and already reaches the client as a `shell_salvo` event, so
 * predicting it only shows a hit that hasn't happened and a shell that isn't
 * there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NAVAL_SHELL_WEAPON_IDS } from '../../src/core/combat/shellFlight.js';
import { localFirePredicts } from '../../src/client/combat/LocalBeam.js';

describe('localFirePredicts', () => {
  it('no naval shell is predicted; beams, bolts and missiles still are', () => {
    for (const id of NAVAL_SHELL_WEAPON_IDS) expect(localFirePredicts(id), id).toBe(false);
    for (const id of ['laser', 'hitscan', 'autocannon', 'heat-seeker', 'pulse-orb', 'charge-laser']) {
      expect(localFirePredicts(id), id).toBe(true);
    }
  });

  it('the fire path asks it for the ghost and for the instant hit', () => {
    const src = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    // The ghost decision and the predicted-hit call are both gated by it.
    expect(src).toMatch(/spawnGhost\s*=\s*[^;]*localFirePredicts\(/);
    expect(src).toMatch(/if \(localFirePredicts\(slotWeapon\)\) \{\s*predictShotOutcome\(/);
  });
});
