/**
 * Capital fixes S6 — an AI-flown owned ship engages an ENEMY base's structures
 * (hostile to its OWNER) in range on every stance but Hold fire, Defensive
 * included; never its own or an ally's; drones keep the raid list.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from '../HostileDroneBehaviour.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { AiEntity, AiStructureView, AiWorldView } from '../../contracts/IAiBehaviour.js';

const KIND = getShipKind('fighter');
const OWNER = 'owner-1';
const ENEMY = 'enemy-1';
const ALLY = 'ally-1';

type Mut<T> = { -readonly [K in keyof T]: T[K] };

function self(): Mut<AiEntity> {
  return { id: 'own-1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
}

function struct(id: string, owner: string, y: number, ownerFoeOnly = true): AiStructureView {
  return { id, x: 0, y, priority: 1, owner, ownerFoeOnly };
}

/** The room's answer: only ENEMY's structures are hostile to OWNER. */
function view(structures: AiStructureView[]): Mut<AiWorldView> {
  const owners = new Map(structures.map((s) => [s.id, s.owner]));
  return {
    players: [], structures, tick: 0, dtSec: 1 / 60,
    hostileToPlayer: (id, pid) => pid === OWNER && owners.get(id) === ENEMY,
  };
}

function run(b: HostileDroneBehaviour, v: Mut<AiWorldView>, ticks = 10): void {
  const e = self();
  for (let t = 100; t < 100 + ticks; t++) {
    v.tick = t;
    b.tick(e, v);
  }
}

function owned(stance: 'aggressive' | 'defensive' | 'holdFire'): HostileDroneBehaviour {
  const b = new HostileDroneBehaviour(KIND, { side: 'players', ownerId: OWNER });
  b.setEngageOnSight(stance === 'aggressive');
  b.setHoldFire(stance === 'holdFire');
  return b;
}

describe('TargetPick — enemy bases on sight (capital fixes S6)', () => {
  it('Defensive: engages an enemy-owned structure in range', () => {
    const b = owned('defensive');
    run(b, view([struct('s1', ENEMY, 400)]));
    expect(b.getTargetId()).toBe('s1');
  });

  it('Aggressive: engages an enemy-owned structure in range', () => {
    const b = owned('aggressive');
    run(b, view([struct('s1', ENEMY, 400)]));
    expect(b.getTargetId()).toBe('s1');
  });

  it('Hold fire: never', () => {
    const b = owned('holdFire');
    run(b, view([struct('s1', ENEMY, 400)]));
    expect(b.getTargetId()).toBeNull();
  });

  it('out of range: not on sight', () => {
    const b = owned('defensive');
    run(b, view([struct('s1', ENEMY, 1e6)]));
    expect(b.getTargetId()).toBeNull();
  });

  it('own and allied structures are never targets, even with a ledger hit from my own', () => {
    for (const stance of ['aggressive', 'defensive'] as const) {
      const b = owned(stance);
      b.markHostile('mine', 100);
      run(b, view([struct('mine', OWNER, 300, false), struct('ally', ALLY, 400)]));
      expect(b.getTargetId(), stance).toBeNull();
    }
  });

  it('drones keep the raid list: an owner-foe entry is invisible, a raid one is fought on the ledger', () => {
    const d = new HostileDroneBehaviour(KIND);
    d.markHostile('base', 100);
    run(d, view([struct('base', ENEMY, 400)]));
    expect(d.getTargetId(), 'an owner-foe entry is not a drone target').toBeNull();
    const d2 = new HostileDroneBehaviour(KIND);
    d2.markHostile('raid', 100);
    run(d2, view([struct('raid', ENEMY, 400, false)]));
    expect(d2.getTargetId()).toBe('raid');
  });
});
