/**
 * Selection-HUD S8: the target do-hexes (own ships selected in Command plus a
 * tapped target that is not mine). Follow under the thumb, Move to, Attack,
 * More, Clear in the far corner; each sends an existing fleet order.
 */
import { describe, expect, it, vi } from 'vitest';
import { doHexLayout } from './doHexLayout';
import {
  followTarget, targetDoHexes, targetFollowable, targetHexCovers, targetSelected, type TargetDoHexOptions,
} from './targetDoHexes';

function opts(over: Partial<TargetDoHexOptions> = {}): TargetDoHexOptions {
  return { attackable: true, followable: true, follow: vi.fn(), moveTo: vi.fn(), attack: vi.fn(), openMore: vi.fn(), clear: vi.fn(), ...over };
}

const byKey = (o: TargetDoHexOptions, key: string) => {
  const h = targetDoHexes(o).find((x) => x.key === key);
  if (h === undefined) throw new Error(`no ${key} hex`);
  return h;
};

describe('targetDoHexes', () => {
  it('Follow, Move to, Attack, More, Clear: Follow under the thumb, Clear in the far corner', () => {
    const hexes = targetDoHexes(opts());
    expect(hexes.map((h) => h.word)).toEqual(['Follow', 'Move to', 'Attack', 'More', 'Clear']);
    const cells = new Map(doHexLayout(hexes).cells.map((c) => [c.hex.key, c.cell]));
    expect(cells.get('follow')).toBe(0);
    expect(cells.get('clear')).toBe(hexes.length - 1);
  });

  it('each hex dispatches its order', () => {
    const o = opts();
    byKey(o, 'move-to').onPress();
    expect(o.moveTo).toHaveBeenCalledOnce();
    byKey(o, 'attack').onPress();
    expect(o.attack).toHaveBeenCalledOnce();
    byKey(o, 'more').onPress();
    expect(o.openMore).toHaveBeenCalledOnce();
  });

  it('Clear resets the target', () => {
    const o = opts();
    byKey(o, 'clear').onPress();
    expect(o.clear).toHaveBeenCalledOnce();
    expect(o.moveTo).not.toHaveBeenCalled();
    expect(o.attack).not.toHaveBeenCalled();
  });

  it('Follow on a ship (anyone\'s): live, and it sends the escort order with the target id', () => {
    const o = opts({ followable: true });
    const f = byKey(o, 'follow');
    expect(f.dim).toBeFalsy();
    expect(f.disabled).toBeFalsy();
    f.onPress();
    expect(o.follow).toHaveBeenCalledOnce();
    const cmds = { setMode: vi.fn() };
    expect(followTarget({ ids: ['a', 'b'], focusId: 'p2', focusKind: 'ship' }, cmds)).toBe(true);
    expect(cmds.setMode).toHaveBeenCalledWith(['a', 'b'], 'escort', { escortId: 'p2' });
  });

  it('Follow on a non-ship (rock, pod, structure): dimmed and blocked, nothing sent', () => {
    const f = byKey(opts({ followable: false }), 'follow');
    expect(f.dim).toBe(true);
    expect(f.disabled).toBe(true);
    const cmds = { setMode: vi.fn() };
    expect(followTarget({ ids: ['a'], focusId: 'swarm-3', focusKind: 'asteroid' }, cmds)).toBe(false);
    expect(cmds.setMode).not.toHaveBeenCalled();
  });

  it('targetFollowable: ships, AI-flown hulls and NPC (drone) ships; never rocks, pods, structures', () => {
    const sel = (focusKind: 'ship' | 'lingering' | 'drone' | 'asteroid' | 'pod' | 'structure') => ({ ids: ['a'], focusId: 'x', focusKind });
    for (const k of ['ship', 'lingering', 'drone'] as const) expect(targetFollowable(sel(k)), k).toBe(true);
    for (const k of ['asteroid', 'pod', 'structure'] as const) expect(targetFollowable(sel(k)), k).toBe(false);
    expect(targetFollowable({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toBe(false);
  });

  it('Attack is dimmed and blocked for something the fleet cannot attack (a rock, a pod)', () => {
    const o = opts({ attackable: false });
    const a = byKey(o, 'attack');
    expect(a.disabled).toBe(true);
    expect(byKey(opts(), 'attack').disabled).toBeFalsy();
  });
});

describe('targetSelected', () => {
  it('own ships plus a focus that is not one of them', () => {
    expect(targetSelected({ ids: ['a'], focusId: 'p2', focusKind: 'ship' })).toBe(true);
    expect(targetSelected({ ids: ['a'], focusId: 'swarm-3', focusKind: 'asteroid' })).toBe(true);
    expect(targetSelected({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toBe(false);
    expect(targetSelected({ ids: ['a'], focusId: null, focusKind: null })).toBe(false);
    expect(targetSelected({ ids: [], focusId: 'p2', focusKind: 'ship' })).toBe(false);
  });
});

describe('targetHexCovers', () => {
  it('the strip\'s fleet Lock (Attack) only while it is an attackable target', () => {
    const lock = { kind: 'button' as const, key: 'target', icon: 'target' as const, tooltip: '', onPress: () => {} };
    const pilot = { kind: 'button' as const, key: 'pilot', icon: 'pilot' as const, tooltip: '', onPress: () => {} };
    expect(targetHexCovers(lock, true)).toBe(true);
    expect(targetHexCovers(lock, false)).toBe(false);
    expect(targetHexCovers(pilot, true)).toBe(false);
  });
});
