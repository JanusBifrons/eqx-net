import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectorInfoDrawer, type SectorInfoDrawerProps } from './SectorInfoDrawer';
import type { SectorTooltipData } from './galaxyTooltip';

const TIP: SectorTooltipData = {
  name: 'Sol Prime',
  faction: 'Core',
  status: 'Neutral',
  features: ['asteroid'],
  players: 1,
  enemies: 2,
  neutrals: 0,
  structures: 3,
};

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

  it('renders the sector name + labelled breakdown', () => {
    renderDrawer();
    expect(screen.getByText('Sol Prime')).toBeInTheDocument();
    const breakdown = screen.getByTestId('sector-drawer-breakdown');
    expect(breakdown).toHaveTextContent('Players: 1');
    expect(breakdown).toHaveTextContent('Hostiles: 2');
    expect(breakdown).toHaveTextContent('Structures: 3');
  });

  it('recent activity: "No recent activity" when null, a breakdown when present', () => {
    const { unmount } = renderDrawer({ recentCombat: null });
    expect(screen.getByTestId('sector-drawer-recent')).toHaveTextContent('No recent activity');
    unmount();
    renderDrawer({ recentCombat: { shipsDestroyed: 2, structuresDestroyed: 1, lastEventMs: 1 } });
    expect(screen.getByTestId('sector-drawer-recent')).toHaveTextContent('2 ships · 1 structure destroyed');
  });

  it('ships in sector: cards (hull bar + position) + Spawn fire onSpawnExistingShip; None when empty', () => {
    const onSpawnExistingShip = vi.fn();
    const { unmount } = renderDrawer({ ships: [] });
    expect(screen.getByText('None')).toBeInTheDocument();
    unmount();
    renderDrawer({
      ships: [{ shipId: 'sh1', kind: 'fighter', isActive: true, health: 50, x: 12, y: -8 }],
      onSpawnExistingShip,
    });
    expect(screen.getByTestId('sector-drawer-ship-sh1')).toBeInTheDocument();
    expect(screen.getByTestId('sector-drawer-hull-sh1')).toBeInTheDocument();
    expect(screen.getByText('(12, -8)')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sector-drawer-spawn-sh1'));
    expect(onSpawnExistingShip).toHaveBeenCalledWith('sh1', 'sol-prime');
  });

  it('landing context shows "Join sector" → onJoin', () => {
    const onJoin = vi.fn();
    renderDrawer({ context: 'landing', onJoin });
    const join = screen.getByTestId('sector-drawer-join');
    expect(join).toHaveTextContent('Join sector');
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

  it('✕ fires onClose', () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.click(screen.getByTestId('sector-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
