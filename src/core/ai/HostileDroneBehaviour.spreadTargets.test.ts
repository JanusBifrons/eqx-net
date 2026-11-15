/**
 * Spread targets (owner decision 2026-11-14): each NPC prefers an enemy nobody
 * else of its side is already shooting, so an even fight breaks into duels;
 * when one side outnumbers the other, the surplus doubles up.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { TargetClaimBoard } from './tactics/targetClaims.js';
import { pickTarget } from './WeaponMountController.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const FIGHTER = getShipKind('fighter');
type P = AiWorldView['players'][number];
const player = (id: string, x: number, y: number): P => ({ id, x, y, vx: 0, vy: 0, health: 100, maxHealth: 100 });
const self = (id: string, x: number): AiEntity => ({ id, x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });

function pack(n: number, foes: string[]): HostileDroneBehaviour[] {
  const out: HostileDroneBehaviour[] = [];
  for (let i = 0; i < n; i++) {
    const b = new HostileDroneBehaviour(FIGHTER);
    for (const f of foes) b.markHostile(f, 0);
    out.push(b);
  }
  return out;
}

/** Tick every brain once, in order (as `AiController.tick` does). */
function tickAll(brains: HostileDroneBehaviour[], players: P[], tick: number, claims?: TargetClaimBoard): (string | null)[] {
  const v: AiWorldView = { players, tick, dtSec: 1 / 60, claims };
  return brains.map((b, i) => {
    b.tick(self(`d${i}`, i * 20), v);
    return b.getTargetId();
  });
}

describe('HostileDroneBehaviour — spread targets', () => {
  // Every foe is ahead; 'a' is nearest to all three attackers.
  const three = [player('a', 0, 300), player('b', 60, 380), player('c', -60, 460)];

  it('3 attackers vs 3 free targets ⇒ three different targets', () => {
    const brains = pack(3, ['a', 'b', 'c']);
    const ids = tickAll(brains, three, 10, new TargetClaimBoard());
    expect(new Set(ids).size).toBe(3);
  });

  it('control: without claims all three take the nearest', () => {
    const brains = pack(3, ['a', 'b', 'c']);
    expect(tickAll(brains, three, 10)).toEqual(['a', 'a', 'a']);
  });

  it('3 attackers vs 1 target ⇒ all on the one (gang-up when outnumbered)', () => {
    const brains = pack(3, ['a']);
    expect(tickAll(brains, [player('a', 0, 300)], 10, new TargetClaimBoard())).toEqual(['a', 'a', 'a']);
  });

  it('3 attackers vs 2 targets ⇒ both engaged, the surplus doubles up', () => {
    const brains = pack(3, ['a', 'b']);
    const ids = tickAll(brains, three.slice(0, 2), 10, new TargetClaimBoard());
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
  });

  it('hysteresis: no flip-flopping while ranges jitter', () => {
    const brains = pack(3, ['a', 'b', 'c']);
    const claims = new TargetClaimBoard();
    let prev = tickAll(brains, three, 10, claims);
    let switches = 0;
    for (let t = 11; t < 600; t++) {
      // Targets wobble ±40 u so their ranges keep crossing.
      const w = 40 * Math.sin(t / 7);
      const ids = tickAll(brains, [player('a', w, 300 + w), player('b', 60 - w, 380 - w), player('c', -60, 460 + w)], t, claims);
      for (let i = 0; i < 3; i++) if (ids[i] !== prev[i]) switches++;
      prev = ids;
    }
    expect(switches).toBe(0);
    expect(new Set(prev).size).toBe(3);
  });

  it('a target that dies frees its attacker, who joins a living one', () => {
    const brains = pack(3, ['a', 'b', 'c']);
    const claims = new TargetClaimBoard();
    const ids = tickAll(brains, three, 10, claims);
    const gone = ids[0]!;
    const rest = three.filter((p) => p.id !== gone);
    const after = tickAll(brains, rest, 11, claims);
    expect(after.every((id) => id !== gone && id !== null)).toBe(true);
  });

  it('is deterministic (same order, same picks)', () => {
    const a = tickAll(pack(3, ['a', 'b', 'c']), three, 10, new TargetClaimBoard());
    const b = tickAll(pack(3, ['a', 'b', 'c']), three, 10, new TargetClaimBoard());
    expect(a).toEqual(b);
  });
});

describe('TargetClaimBoard', () => {
  it('counts per side and moves a claim', () => {
    const c = new TargetClaimBoard();
    c.claim('x', 'drones', 't1');
    c.claim('y', 'drones', 't1');
    c.claim('z', 'robots', 't1');
    expect(c.count('drones', 't1')).toBe(2);
    expect(c.count('robots', 't1')).toBe(1);
    c.claim('x', 'drones', 't2');
    expect(c.count('drones', 't1')).toBe(1);
    expect(c.count('drones', 't2')).toBe(1);
    c.remove('y');
    expect(c.count('drones', 't1')).toBe(0);
    c.claim('x', 'drones', null);
    expect(c.count('drones', 't2')).toBe(0);
  });
});

describe('pickTarget — claimWeight', () => {
  const t = (id: string, y: number, claims: number) => ({ id, x: 0, y, vx: 0, vy: 0, hostile: true, claims });
  it('a held target loses to a free one within √(1+w) of its range', () => {
    const c = [t('held', 100, 1), t('free', 200, 0)];
    expect(pickTarget(0, 0, c, null, () => true, { claimWeight: 4 })?.id).toBe('free');
    expect(pickTarget(0, 0, c, null, () => true)?.id).toBe('held');
    expect(pickTarget(0, 0, [t('held', 100, 1), t('free', 300, 0)], null, () => true, { claimWeight: 4 })?.id).toBe('held');
  });
});
