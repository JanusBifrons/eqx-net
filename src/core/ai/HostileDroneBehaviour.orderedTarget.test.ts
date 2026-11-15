/**
 * RTS Part B slice 8: the owner's ATTACK ORDER reaches the AI pilot brain
 * (players side) as `setOrderedTarget`.
 *
 * Owner rule: the ordered target gets PRIORITY inside the existing target
 * pick (spread targets, dwell and stickiness intact), never a hard override.
 * It goes on the retaliation ledger while ordered, so a Defensive ship fights
 * even a neutral, and it lifts the guard leash for that target only. Lifting
 * the order sends the ship back to its job (its post).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { TargetClaimBoard } from './tactics/targetClaims.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const OWNER = 'owner-1';
const R = shipTuning(KIND).guardRadiusMin;

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

function owned(): HostileDroneBehaviour {
  return new HostileDroneBehaviour(KIND, { side: 'players', ownerId: OWNER });
}
function body(id: string, x: number, y: number): Body {
  return { id, x, y, vx: 0, vy: 0, angle: 0, angvel: 0 };
}
function ship(id: string, x: number, y: number, allegiance: string): Mut<AiSwarmView> {
  return { id, x, y, vx: 0, vy: 0, allegiance, health: 100, maxHealth: 100 };
}

describe('HostileDroneBehaviour — attack order (RTS Part B slice 8)', () => {
  it('the ordered target wins over a nearer enemy; without the order the nearer one is picked', () => {
    const swarms = [ship('near', 0, 400, 'robots'), ship('far', 0, 1000, 'robots')];
    const view: AiWorldView = { players: [], swarms, tick: 10, dtSec: 1 / 60 };
    const plain = owned();
    plain.tick(body('o1', 0, 0), view);
    expect(plain.getTargetId()).toBe('near');

    const ordered = owned();
    ordered.setOrderedTarget('far', 10);
    ordered.tick(body('o1', 0, 0), view);
    expect(ordered.getTargetId()).toBe('far');
  });

  it('priority, not an override: an ordered target far beyond the margin loses to a point-blank enemy', () => {
    const view: AiWorldView = {
      players: [], swarms: [ship('near', 0, 200, 'robots'), ship('far', 0, 1500, 'robots')], tick: 10, dtSec: 1 / 60,
    };
    const b = owned();
    b.setOrderedTarget('far', 10);
    b.tick(body('o1', 0, 0), view);
    expect(b.getTargetId()).toBe('near');
  });

  it('several ships ordered on one target all take it; the surplus beyond the claim margin spreads to a free enemy', () => {
    const claims = new TargetClaimBoard();
    const view: AiWorldView = {
      players: [], swarms: [ship('a', 0, 600, 'robots'), ship('b', 40, 590, 'robots')], tick: 10, dtSec: 1 / 60, claims,
    };
    const brains = [owned(), owned(), owned(), owned()];
    for (const b of brains) b.setOrderedTarget('a', 10);
    const ids = brains.map((b, i) => { b.tick(body(`o${i}`, i * 10, 0), view); return b.getTargetId(); });
    // Three on the ordered target (two claims ×9 still under its ÷13), the
    // fourth (three claims) spreads to the free, slightly nearer enemy.
    expect(ids.slice(0, 3)).toEqual(['a', 'a', 'a']);
    expect(ids[3]).toBe('b');
  });

  it('a Defensive ship ordered onto a neutral drone attacks it, never forgets it while ordered, and lifting the order lets it go', () => {
    const b = owned();
    b.setEngageOnSight(false);
    const view: Mut<AiWorldView> = { players: [], swarms: [ship('d1', 0, 500, 'drones')], tick: 10, dtSec: 1 / 60 };
    const self = body('o1', 0, 0);
    b.tick(self, view);
    expect(b.getTargetId(), 'Defensive: a neutral drone is no target').toBeNull();
    b.setOrderedTarget('d1', 10);
    b.tick(self, view);
    expect(b.getTargetId()).toBe('d1');
    // Past the ledger's forget time (30 s) it is still the target.
    view.tick = 10 + 60 * 40;
    b.tick(self, view);
    expect(b.getTargetId()).toBe('d1');
    b.setOrderedTarget(null, view.tick);
    view.tick++;
    b.tick(self, view);
    expect(b.getTargetId(), 'order lifted: the neutral is no target again').toBeNull();
  });

  it('a target that hit the ship stays on its ledger after the order is lifted', () => {
    const b = owned();
    b.setEngageOnSight(false);
    const view: Mut<AiWorldView> = { players: [], swarms: [ship('d1', 0, 500, 'drones')], tick: 10, dtSec: 1 / 60 };
    b.setOrderedTarget('d1', 10);
    b.markHostile('d1', 20);
    b.setOrderedTarget(null, 30);
    view.tick = 31;
    b.tick(body('o1', 0, 0), view);
    expect(b.getTargetId()).toBe('d1');
  });

  it('the order lifts the guard leash for its target only, and the ship goes back to its post afterwards', () => {
    const b = owned();
    b.setGuardPost(0, 0, 0);
    b.setMoveTarget(0, 0);
    const far = R * 2.5;
    // A robot just outside the radius on the other side: still leashed.
    const view: Mut<AiWorldView> = {
      players: [], swarms: [ship('t', 0, far, 'robots'), ship('other', 0, -R * 1.5, 'robots')], tick: 10, dtSec: 1 / 60,
    };
    const self = body('o1', 0, 0);
    b.tick(self, view);
    expect(b.getTargetId(), 'leashed: nothing outside the radius').toBeNull();
    b.setOrderedTarget('t', 10);
    let left = 0;
    for (let t = 11; t < 11 + 60 * 8; t++) {
      view.tick = t;
      const intent = b.tick(self, view);
      expect(b.getTargetId()).toBe('t');
      stepKinematic(self, KIND, intent);
      left = Math.max(left, Math.hypot(self.x, self.y));
    }
    expect(left, 'flew out of its guard radius after the ordered target').toBeGreaterThan(R);
    // The target dies: the room lifts the order; the ship returns to its post.
    b.setOrderedTarget(null, view.tick);
    view.swarms = [];
    for (let t = view.tick + 1; t < view.tick + 60 * 30; t++) {
      const v = { ...view, tick: t };
      stepKinematic(self, KIND, b.tick(self, v));
    }
    expect(b.getTargetId()).toBeNull();
    expect(Math.hypot(self.x, self.y), 'back at its post').toBeLessThan(R);
  });

  it('a re-keyed ordered target keeps the sticky pick (no dwell restart)', () => {
    const b = owned();
    b.setEngageOnSight(false);
    const view: Mut<AiWorldView> = { players: [], swarms: [ship('pilot-b', 0, 500, 'drones')], tick: 10, dtSec: 1 / 60 };
    b.setOrderedTarget('pilot-b', 10);
    b.tick(body('o1', 0, 0), view);
    expect(b.getTargetId()).toBe('pilot-b');
    b.setOrderedTarget('hull-b', 11);
    expect(b.getTargetId()).toBe('hull-b');
    expect(b.getOrderedTarget()).toBe('hull-b');
  });

  it('never orders the ship onto its owner', () => {
    const b = owned();
    b.setOrderedTarget(OWNER, 10);
    expect(b.getOrderedTarget()).toBeNull();
  });
});
