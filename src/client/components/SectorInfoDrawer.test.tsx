import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectorInfoDrawer, type SectorInfoDrawerProps } from './SectorInfoDrawer';
import type { SectorTooltipData } from './galaxyTooltip';
import type { SectorControl, SectorHistorySample } from '../../shared-types/galaxySnapshot';

const CONTROL: SectorControl = {
  holderShare: 62, challenger: 'robots', challengerShare: 30, trend: 0, threat: 1, flippedAtMs: null, locked: false,
};

const TIP: SectorTooltipData = {
  name: 'Sol Prime',
  faction: 'Sol Dominion',
  status: 'Held',
  challenger: 'Robot Dominion',
  features: ['asteroid'],
  players: 1,
  enemies: 2,
  neutrals: 0,
  structures: 3,
  elite: null,
  capital: null,
  event: null,
  holderId: 'sol',
  challengerId: 'robots',
  control: CONTROL,
};

// The drawer fetches the sector's history itself; each test sets `history`.
let history: SectorHistorySample[] = [];
beforeEach(() => {
  history = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ key: 'sol-prime', samples: history }) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** `n` one-minute samples, the holder's share ramping `from` → `to`. */
function ramp(holder: string, from: number, to: number, n = 11): SectorHistorySample[] {
  return Array.from({ length: n }, (_, i) => ({ atMs: i * 60_000, holder, holderShare: from + ((to - from) * i) / (n - 1) }));
}

function renderDrawer(over: Partial<SectorInfoDrawerProps> = {}) {
  const props: SectorInfoDrawerProps = {
    open: true,
    sectorKey: 'sol-prime',
    tip: TIP,
    ships: [],
    recentCombat: null,
    context: 'landing',
    warpable: false,
    currentSectorKey: null,
    onClose: vi.fn(),
    onSpawnExistingShip: vi.fn(),
    onJoin: vi.fn(),
    onWarp: vi.fn(),
    ...over,
  };
  return { props, ...render(<SectorInfoDrawer {...props} />) };
}

describe('SectorInfoDrawer', () => {
  it('shows the placeholder when no sector/tip is provided', () => {
    renderDrawer({ sectorKey: null, tip: null });
    expect(screen.getByText('Select a sector')).toBeInTheDocument();
    expect(screen.queryByTestId('sector-drawer-join')).not.toBeInTheDocument();
  });

  it('header: name, "Held by <holder> · Updated n s ago", or "Unclaimed"', () => {
    const { unmount } = renderDrawer({ updatedAtMs: Date.now() - 3000 });
    expect(screen.getByText('Sol Prime')).toBeInTheDocument();
    expect(screen.getByTestId('sector-drawer-meta')).toHaveTextContent(/^Held by Sol Dominion · Updated [34] s ago$/);
    unmount();
    renderDrawer({ tip: { ...TIP, status: 'Neutral', faction: 'Neutral ground, Core', holderId: null } });
    expect(screen.getByTestId('sector-drawer-meta')).toHaveTextContent(/^Unclaimed$/);
  });

  it('control bar: holder and challenger shares; the section is hidden with no control meter', () => {
    const { unmount } = renderDrawer();
    const bar = screen.getByTestId('sector-drawer-control-bar');
    expect(bar).toHaveAttribute('data-holder-share', '62');
    expect(bar).toHaveAttribute('data-challenger-share', '30');
    unmount();
    renderDrawer({ tip: { ...TIP, control: null } });
    expect(screen.queryByTestId('sector-drawer-control')).not.toBeInTheDocument();
    expect(screen.queryByText('Control')).not.toBeInTheDocument();
  });

  it('gaining line: the holder gaining over the last 10 samples', async () => {
    history = ramp('sol', 54, 62);
    renderDrawer();
    expect(await screen.findByTestId('sector-drawer-trend')).toHaveTextContent('Sol Dominion gaining · +8% in 10 min');
  });

  it('gaining line: the challenger gaining when the holder loses share', async () => {
    history = ramp('sol', 70, 62);
    renderDrawer();
    expect(await screen.findByTestId('sector-drawer-trend')).toHaveTextContent('Robot Dominion gaining · +8% in 10 min');
  });

  it('gaining line: "Steady" when flat for 10 min', async () => {
    history = ramp('sol', 62, 62);
    renderDrawer();
    expect(await screen.findByTestId('sector-drawer-trend')).toHaveTextContent(/^Steady$/);
  });

  it('under two history samples: a quiet "builds up" line, never a blank sparkline', async () => {
    history = [{ atMs: 0, holder: 'sol', holderShare: 60 }];
    renderDrawer();
    expect(await screen.findByText('History builds up over the next hour')).toBeInTheDocument();
    expect(screen.queryByTestId('sector-drawer-history-now')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sector-drawer-trend')).not.toBeInTheDocument();
  });

  it('a failed history fetch also shows the "builds up" line, not "Loading…" forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderDrawer();
    expect(await screen.findByText('History builds up over the next hour')).toBeInTheDocument();
  });

  it('a full hour draws the sparkline: 50% line, axis labels and the now dot', async () => {
    history = ramp('sol', 40, 62, 61);
    renderDrawer();
    expect(await screen.findByTestId('sector-drawer-history-now')).toBeInTheDocument();
    expect(screen.getByText('50% · CHANGES HANDS')).toBeInTheDocument();
    expect(screen.getByText('60 MIN AGO')).toBeInTheDocument();
    expect(screen.getByText('NOW')).toBeInTheDocument();
  });

  it('in the sector: the 2×2 grid of pilots, hostiles, structures, neutral drones', () => {
    renderDrawer();
    const grid = screen.getByTestId('sector-drawer-breakdown');
    expect(grid).toHaveTextContent('1pilots2hostiles3structures0neutral drones');
  });

  it('recent: losses with plurals when present, no loss line when quiet', () => {
    const { unmount } = renderDrawer({ recentCombat: null });
    expect(screen.getByTestId('sector-drawer-recent')).not.toHaveTextContent('destroyed');
    unmount();
    renderDrawer({ recentCombat: { shipsDestroyed: 2, structuresDestroyed: 1, lastEventMs: 1 } });
    const recent = screen.getByTestId('sector-drawer-recent');
    expect(recent).toHaveTextContent('ships destroyed');
    expect(recent).toHaveTextContent('structure destroyed');
    expect(recent).not.toHaveTextContent('structures destroyed');
    expect(recent).toHaveTextContent('last 5 min');
  });

  it('recent omits a zero-count loss line (only structures destroyed)', () => {
    renderDrawer({ recentCombat: { shipsDestroyed: 0, structuresDestroyed: 3, lastEventMs: 1 } });
    const recent = screen.getByTestId('sector-drawer-recent');
    expect(recent).toHaveTextContent('structures destroyed');
    expect(recent).not.toHaveTextContent('ship destroyed');
  });

  it('"Last changed hands" shows only when the feed has flippedAtMs', () => {
    const { unmount } = renderDrawer();
    expect(screen.queryByTestId('sector-drawer-flipped')).not.toBeInTheDocument();
    unmount();
    renderDrawer({ tip: { ...TIP, control: { ...CONTROL, flippedAtMs: Date.now() - 12 * 60_000 } } });
    expect(screen.getByTestId('sector-drawer-flipped')).toHaveTextContent('Last changed hands 12 min ago');
  });

  it('your ships: "None of your ships here", else a count + cards whose Spawn fires onSpawnExistingShip', () => {
    const onSpawnExistingShip = vi.fn();
    const { unmount } = renderDrawer({ ships: [] });
    expect(screen.getByTestId('sector-drawer-own-ships')).toHaveTextContent('None of your ships here');
    unmount();
    renderDrawer({
      ships: [{ shipId: 'sh1', kind: 'fighter', isActive: true, health: 50, x: 12, y: -8 }],
      onSpawnExistingShip,
    });
    expect(screen.getByTestId('sector-drawer-own-ships')).toHaveTextContent('1 of your ships here');
    expect(screen.getByTestId('sector-drawer-hull-sh1')).toBeInTheDocument();
    expect(screen.getByText('(12, -8)')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sector-drawer-spawn-sh1'));
    expect(onSpawnExistingShip).toHaveBeenCalledWith('sh1', 'sol-prime');
  });

  it('landing context shows "Join the fight" → onJoin', () => {
    const onJoin = vi.fn();
    renderDrawer({ context: 'landing', onJoin });
    const join = screen.getByTestId('sector-drawer-join');
    expect(join).toHaveTextContent('Join the fight');
    fireEvent.click(join);
    expect(onJoin).toHaveBeenCalledWith('sol-prime');
    expect(screen.queryByTestId('sector-drawer-warp')).not.toBeInTheDocument();
  });

  it('warp context + warpable shows "Warp here" → onWarp', () => {
    const onWarp = vi.fn();
    renderDrawer({ context: 'warp', warpable: true, onWarp });
    const warp = screen.getByTestId('sector-drawer-warp');
    expect(warp).toHaveTextContent('Warp here');
    fireEvent.click(warp);
    expect(onWarp).toHaveBeenCalledWith('sol-prime');
    expect(screen.queryByTestId('sector-drawer-join')).not.toBeInTheDocument();
  });

  it('warp context + NOT warpable shows a hint, no warp button', () => {
    renderDrawer({ context: 'warp', warpable: false, sectorKey: 'cygnus-arm', currentSectorKey: 'sol-prime' });
    expect(screen.queryByTestId('sector-drawer-warp')).not.toBeInTheDocument();
    expect(screen.getByText(/Not adjacent/)).toBeInTheDocument();
  });

  it('warp context at the CURRENT sector shows "You are here"', () => {
    renderDrawer({ context: 'warp', warpable: false, sectorKey: 'sol-prime', currentSectorKey: 'sol-prime' });
    expect(screen.getByText('You are here')).toBeInTheDocument();
  });

  it('"◀ Galaxy" backs out (fires onClose)', () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    const back = screen.getByTestId('sector-drawer-close');
    expect(back).toHaveTextContent('◀ Galaxy');
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
