/**
 * Capital S2b: a hull's kept lock is its pilot's order, so its AI pilot chases
 * the locked target past the on-sight range (lock range decides, not
 * `ON_SIGHT_ENGAGE_RANGE`) and on the Defensive stance. Hold fire is the only
 * exception; the target must still be live (in the view) and hostile.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { ON_SIGHT_ENGAGE_RANGE } from '../../shared-types/allegiances.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';

const KIND = getShipKind('fighter');
const OWNER = 'owner-1';

function owned(): HostileDroneBehaviour {
  return new HostileDroneBehaviour(KIND, { side: 'players', ownerId: OWNER });
}
function body(): AiEntity {
  return { id: 'o1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
}
function ship(id: string, y: number, allegiance = 'robots'): AiSwarmView {
  return { id, x: 0, y, vx: 0, vy: 0, allegiance, health: 100, maxHealth: 100 };
}
function view(swarms: AiSwarmView[]): AiWorldView {
  return { players: [], swarms, tick: 10, dtSec: 1 / 60 };
}

describe('HostileDroneBehaviour — kept lock reach (capital S2b)', () => {
  it('a kept lock at 2500 u (beyond on-sight range) is still picked', () => {
    expect(2500).toBeGreaterThan(ON_SIGHT_ENGAGE_RANGE);
    const v = view([ship('far', 2500)]);
    const plain = owned();
    plain.tick(body(), v);
    expect(plain.getTargetId()).toBeNull();

    const b = owned();
    b.setKeptLockTarget('far');
    b.tick(body(), v);
    expect(b.getTargetId()).toBe('far');
  });

  it('a kept lock on a far enemy base hostile to the owner is picked', () => {
    const v: AiWorldView = {
      players: [], tick: 10, dtSec: 1 / 60,
      structures: [{ id: 'base', x: 0, y: 2500, priority: 1, owner: 'foe' }],
      hostileToPlayer: (id, pid) => id === 'base' && pid === OWNER,
    };
    const b = owned();
    b.setKeptLockTarget('base');
    b.tick(body(), v);
    expect(b.getTargetId()).toBe('base');
  });

  it('on Defensive a kept lock on a hostile ship is picked', () => {
    const v = view([ship('foe', 800)]);
    const plain = owned();
    plain.setEngageOnSight(false);
    plain.tick(body(), v);
    expect(plain.getTargetId()).toBeNull();

    const b = owned();
    b.setEngageOnSight(false);
    b.setKeptLockTarget('foe');
    b.tick(body(), v);
    expect(b.getTargetId()).toBe('foe');
  });

  it('Hold fire: a kept lock is not picked', () => {
    const b = owned();
    b.setHoldFire(true);
    b.setKeptLockTarget('foe');
    b.tick(body(), view([ship('foe', 800)]));
    expect(b.getTargetId()).toBeNull();
  });

  it('a dead target (gone from the view) is not picked; the normal pick runs', () => {
    const b = owned();
    b.setKeptLockTarget('dead');
    b.tick(body(), view([ship('near', 400)]));
    expect(b.getTargetId()).toBe('near');
  });

  it('a kept lock on a far non-hostile is not picked', () => {
    const b = owned();
    b.setKeptLockTarget('d1');
    b.tick(body(), view([ship('d1', 2500, 'drones')]));
    expect(b.getTargetId()).toBeNull();
  });

  it('no kept lock leaves the normal pick unchanged', () => {
    const v = view([ship('near', 400), ship('mid', 1000), ship('far', 2500)]);
    const a = owned();
    a.tick(body(), v);
    const b = owned();
    b.setKeptLockTarget(null);
    b.tick(body(), v);
    expect(a.getTargetId()).toBe('near');
    expect(b.getTargetId()).toBe('near');
  });
});
