import { describe, expect, it } from 'vitest';
import { GALAXY_FEED_INTERVAL_MS, type SectorControl, type SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import { GalaxyFeed } from './galaxyFeed.js';
import type { GalaxyStatsProvider } from './galaxyStatsProvider.js';

const CONTROL: SectorControl = {
  holderShare: 80, challenger: 'robots', challengerShare: 12, trend: -1, threat: 1, flippedAtMs: null, locked: false,
};

function setup() {
  const clock = { now: 1_000_000 };
  let players = 1;
  const provider: GalaxyStatsProvider = {
    galaxySnapshot: (): SectorLiveState[] => [
      { key: 'a', players, enemies: 0, neutrals: 0, structures: 0, owner: { factionId: 'core', contested: false } },
      { key: 'b', players: 0, enemies: 0, neutrals: 0, structures: 0, owner: null },
    ],
    playerStructurePresence: () => [],
  };
  const feed = new GalaxyFeed({
    provider: () => provider,
    control: (k) => (k === 'a' ? CONTROL : null),
    nowMs: () => clock.now,
  });
  return { feed, clock, setPlayers: (n: number) => { players = n; } };
}

describe('GalaxyFeed — one memoised body per window', () => {
  it('adds control where a meter runs and omits it elsewhere', () => {
    const { feed } = setup();
    const body = JSON.parse(feed.json()) as { sectors: SectorLiveState[] };
    expect(body.sectors[0]!.control).toEqual(CONTROL);
    expect('control' in body.sectors[1]!).toBe(false);
  });

  it('serves the same string within the window, then rebuilds after it', () => {
    const { feed, clock, setPlayers } = setup();
    const first = feed.json();
    setPlayers(7);
    clock.now += GALAXY_FEED_INTERVAL_MS - 1;
    expect(feed.json()).toBe(first);
    expect(feed.buildCount()).toBe(1);
    clock.now += 1;
    const second = feed.json();
    expect(second).not.toBe(first);
    expect((JSON.parse(second) as { sectors: SectorLiveState[] }).sectors[0]!.players).toBe(7);
    expect(feed.buildCount()).toBe(2);
  });
});
