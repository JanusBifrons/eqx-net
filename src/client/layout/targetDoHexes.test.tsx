/**
 * Selection-HUD S8: the target do-hexes (own ships selected in Command plus a
 * tapped target that is not mine). Follow under the thumb, Move to, Attack,
 * More, Clear in the far corner; each sends an existing fleet order.
 */
import { describe, expect, it, vi } from 'vitest';
import { doHexLayout } from './doHexLayout';
import {
  fleetCanSalvage, followTarget, salvageDoHexes, salvageTarget, salvageTargetSelected,
  targetDoHexes, targetFollowable, targetHexCovers, targetSelected,
  type SalvageDoHexOptions, type TargetDoHexOptions,
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

describe('salvage target (S11): Salvage, Move to, More, Clear', () => {
  const sOpts = (over: Partial<SalvageDoHexOptions> = {}): SalvageDoHexOptions =>
    ({ canSalvage: true, salvage: vi.fn(), moveTo: vi.fn(), openMore: vi.fn(), clear: vi.fn(), ...over });

  it('Salvage under the thumb (warn), Move to, More, Clear in the far corner; no Follow, no Attack', () => {
    const hexes = salvageDoHexes(sOpts());
    expect(hexes.map((h) => h.word)).toEqual(['Salvage', 'Move to', 'More', 'Clear']);
    const cells = new Map(doHexLayout(hexes).cells.map((c) => [c.hex.key, c.cell]));
    expect(cells.get('salvage')).toBe(0);
    expect(cells.get('clear')).toBe(hexes.length - 1);
    expect(hexes[0]!.tone).toBe('warn');
    expect(hexes.some((h) => h.key === 'follow' || h.key === 'attack')).toBe(false);
  });

  it('no salvage tools: Salvage dimmed and blocked with the reason', () => {
    const h = salvageDoHexes(sOpts({ canSalvage: false }))[0]!;
    expect(h.dim).toBe(true);
    expect(h.disabled).toBe(true);
    expect(h.tooltip).toBe('No salvage tools on these ships');
    expect(salvageDoHexes(sOpts())[0]!.disabled).toBeFalsy();
  });

  it('salvageTargetSelected: ships plus a salvage focus only', () => {
    expect(salvageTargetSelected({ ids: ['a'], focusId: 'swarm-8', focusKind: 'salvage' })).toBe(true);
    expect(salvageTargetSelected({ ids: ['a'], focusId: 'swarm-3', focusKind: 'asteroid' })).toBe(false);
    expect(salvageTargetSelected({ ids: [], focusId: 'swarm-8', focusKind: 'salvage' })).toBe(false);
  });

  it('salvageTarget sends the fleet salvage order with the ids and the swarm id', () => {
    const cmds = { salvage: vi.fn() };
    expect(salvageTarget({ ids: ['a', 'b'], focusId: 'swarm-8', focusKind: 'salvage' }, cmds)).toBe(true);
    expect(cmds.salvage).toHaveBeenCalledWith(['a', 'b'], 'swarm-8');
    expect(salvageTarget({ ids: ['a'], focusId: 'swarm-3', focusKind: 'asteroid' }, cmds)).toBe(false);
    expect(cmds.salvage).toHaveBeenCalledOnce();
  });

  it('fleetCanSalvage: any selected AI-flown hull with a mining tool; the ship I fly never counts', () => {
    const mirror = {
      localPlayerId: 'me',
      ships: new Map<string, { kind: string }>([['me', { kind: 'barge' }], ['h1', { kind: 'destroyer' }], ['h2', { kind: 'barge' }]]),
    };
    expect(fleetCanSalvage(['h1', 'h2'], mirror)).toBe(true);
    expect(fleetCanSalvage(['h1'], mirror)).toBe(false);
    expect(fleetCanSalvage(['me', 'h1'], mirror), 'my own flown barge does not count').toBe(false);
    expect(fleetCanSalvage(['gone'], mirror)).toBe(false);
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
