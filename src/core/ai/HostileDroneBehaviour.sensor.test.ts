/**
 * AI overhaul slice 3 — the body target pick is capped at the role's sensor
 * range for NEW picks, while a held target and a director-ordered (ledger)
 * contact beyond sensors are still engaged.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { pickTarget } from './WeaponMountController.js';

const FIGHTER = getShipKind('fighter');
const SELF: AiEntity = { id: 'd1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

type P = AiWorldView['players'][number];
function player(id: string, y: number, health = 100): P {
  return { id, x: 0, y, vx: 0, vy: 0, health, maxHealth: 100 };
}
function view(players: P[], tick: number): AiWorldView {
  return { players, tick, dtSec: 1 / 60 };
}

describe('HostileDroneBehaviour — sensor-capped target pick', () => {
  it('sensor range is the role multiple of fire range (at least the on-sight range)', () => {
    const b = new HostileDroneBehaviour(FIGHTER);
    expect(b.getSensorRange()).toBeGreaterThanOrEqual(b.getFireRange());
  });

  it('does not newly pick a hostile beyond sensor range when one is in range', () => {
    const b = new HostileDroneBehaviour(FIGHTER);
    const R = b.getSensorRange();
    // Uncapped, the wounded far contact would win on the health-weighted score.
    b.markHostile('near', 100);
    b.markHostile('far', 100);
    b.tick(SELF, view([player('far', 1.1 * R, 1), player('near', 0.9 * R)], 100));
    expect(b.getTargetId()).toBe('near');
  });

  it('still hunts an ordered contact beyond sensor range when nothing is in range', () => {
    const b = new HostileDroneBehaviour(FIGHTER);
    const R = b.getSensorRange();
    b.markHostile('ordered', 100);
    b.tick(SELF, view([player('ordered', 3 * R)], 100));
    expect(b.getTargetId()).toBe('ordered');
  });

  it('keeps a held target after it leaves sensor range', () => {
    const b = new HostileDroneBehaviour(FIGHTER);
    const R = b.getSensorRange();
    b.markHostile('held', 100);
    b.markHostile('other', 100);
    b.tick(SELF, view([player('held', 0.5 * R)], 100));
    expect(b.getTargetId()).toBe('held');
    // Held drifts to 3R; another (out-of-range) contact sits nearer at 2R.
    // Long past the dwell: the held one is still kept.
    b.tick(SELF, view([player('other', 2 * R), player('held', 3 * R)], 400));
    expect(b.getTargetId()).toBe('held');
  });
});

describe('pickTarget — prevMaxDistance', () => {
  const t = (id: string, x: number) => ({ id, x, y: 0, vx: 0, vy: 0, hostile: true });
  it('defaults to maxDistance (held target dropped past it)', () => {
    expect(pickTarget(0, 0, [t('a', 200)], 'a', () => true, { maxDistance: 100 })).toBeNull();
  });
  it('a larger prevMaxDistance keeps the held target but never picks it fresh', () => {
    const opts = { maxDistance: 100, prevMaxDistance: Infinity };
    expect(pickTarget(0, 0, [t('a', 200)], 'a', () => true, opts)?.id).toBe('a');
    expect(pickTarget(0, 0, [t('a', 200)], null, () => true, opts)).toBeNull();
  });
});
