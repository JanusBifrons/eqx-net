import { describe, it, expect } from 'vitest';
import type { SectorLiveState, SectorControl } from '../../shared-types/galaxySnapshot';
import { quickLaunchSector, QUICK_LAUNCH_KIND } from './quickLaunch';
import { HOT_THREAT } from '../render/galaxy/galaxyMapMotion';

function live(key: string, o: { threat?: SectorControl['threat']; combat?: boolean; players?: number; enemies?: number } = {}): SectorLiveState {
  return {
    key,
    players: o.players ?? 0,
    enemies: o.enemies ?? 0,
    neutrals: 0,
    structures: 0,
    owner: null,
    control: o.threat === undefined ? undefined : {
      holder: 'a', holderShare: 0.6, challenger: 'b', challengerShare: 0.4, trend: 0, threat: o.threat, flippedAtMs: null, locked: false,
    } as unknown as SectorControl,
    recentCombat: o.combat ? ({ kills: 1 } as unknown as SectorLiveState['recentCombat']) : null,
  } as SectorLiveState;
}

describe('quickLaunchSector', () => {
  it('is null before the first feed poll', () => {
    expect(quickLaunchSector([])).toBeNull();
  });

  it('picks a hot front (the map pulse rule) over a busier calm sector', () => {
    const stats = [live('sol-prime', { players: 9, enemies: 9 }), live('orion-belt', { threat: HOT_THREAT })];
    expect(quickLaunchSector(stats)).toBe('orion-belt');
  });

  it('among hot fronts, the higher threat, then recent fighting, then pilots, then hostiles', () => {
    expect(quickLaunchSector([live('sol-prime', { threat: 2, combat: true }), live('vega-reach', { threat: 3 })])).toBe('vega-reach');
    expect(quickLaunchSector([live('sol-prime', { threat: 2 }), live('vega-reach', { threat: 2, combat: true })])).toBe('vega-reach');
    expect(quickLaunchSector([live('sol-prime', { threat: 2, players: 1 }), live('vega-reach', { threat: 2, enemies: 4 })])).toBe('sol-prime');
    expect(quickLaunchSector([live('sol-prime', { threat: 2, players: 1 }), live('vega-reach', { threat: 2, players: 1, enemies: 4 })])).toBe('vega-reach');
  });

  it('a calm galaxy gives the sector with the most pilots, not the biggest swarm; ties keep feed order', () => {
    expect(quickLaunchSector([live('sol-prime'), live('vega-reach', { players: 2 })])).toBe('vega-reach');
    expect(quickLaunchSector([live('sol-prime', { players: 1 }), live('vega-reach', { enemies: 12 })])).toBe('sol-prime');
    expect(quickLaunchSector([live('sol-prime'), live('vega-reach')])).toBe('sol-prime');
  });

  it('skips keys that are not on the map', () => {
    expect(quickLaunchSector([live('no-such-sector', { threat: 3 }), live('sol-prime')])).toBe('sol-prime');
  });

  it('flies the free starter Fighter', () => {
    expect(QUICK_LAUNCH_KIND).toBe('fighter');
  });
});
