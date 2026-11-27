/**
 * Owner 2026-11-27: the slim left icon strip does not exist in the phone game.
 * Every selection state that used to leave actions on it (Fly with a tapped
 * ship / pod / own parked hull; Command with own ships; a focus-only pick of
 * each focus kind; a target; Build with a managed and an unmanaged structure;
 * a route pick) draws NO `left-strip` on touch, and each of those actions is
 * reachable in the do-hexes: a hex, or behind the set's More
 * (`doHexLeftovers.tsx`). The who-hexes stay (they are hexes, not the strip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PanelData } from '../components/selectionPanelData';
import type { SelectionFocusKind } from '../state/storeTypes';

let panelData: PanelData | null = null;
vi.mock('../components/selectionPanelData', async (orig) => ({
  ...(await orig<typeof import('../components/selectionPanelData')>()),
  useSelectionPanelData: () => panelData,
}));
const lockSelected = vi.fn();
const ships = new Map<string, { kind: string }>();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'me', ships }, lockSelected, cancelLock: vi.fn(), setGroupMode: vi.fn(), getRoom: () => null,
  }),
}));
vi.mock('../components/LootWindow', () => ({
  LootWindow: ({ open }: { open: boolean }) => (open ? <div data-testid="stub-loot" /> : null),
}));
const sendPilotShip = vi.fn();
vi.mock('../ships/shipActionsClient', async (orig) => ({
  ...(await orig<typeof import('../ships/shipActionsClient')>()),
  sendPilotShip: (...a: unknown[]) => sendPilotShip(...a),
}));
vi.mock('../components/StructureManageActions', async (orig) => ({
  ...(await orig<typeof import('../components/StructureManageActions')>()),
  useManageData: (id: number | null) => (id === null ? null : { canUpgrade: true, level: 1, upgradeMinerals: 10 }),
}));

import { useUIStore } from '../state/store';
import { resetFleetStatus } from '../fleet/fleetStatus';
import { resetFleetCommands, setFleetCommands } from '../fleet/fleetCommands';
import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost } from './LeftStripHost';
import { DoHexesHost } from './DoHexesHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const rendererRef = { current: { selectFleetShips: vi.fn(), attackFocus: vi.fn() } };
const touchInput = { setBoostHeld: vi.fn() };

function mount(touch = true): void {
  render(
    <LayoutProvider>
      <LeftStripHost rendererRef={rendererRef} touch={touch} />
      <DoHexesHost touchInput={touch ? touchInput : null} rendererRef={rendererRef} />
    </LayoutProvider>,
  );
}

function select(ids: string[], focusId: string | null, focusKind: SelectionFocusKind | null): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId, focusKind } }); });
}

/** Is `testId` a do-hex now, or behind the set's More (opened, checked, closed again)? */
function reachable(testId: string): boolean {
  const inHexes = (): boolean => screen.getByTestId('do-hexes').querySelector(`[data-testid="${testId}"]`) !== null;
  if (inHexes()) return true;
  const more = screen.queryByTestId('do-hex-more');
  if (more === null || more.getAttribute('data-state') !== 'menu') return false;
  fireEvent.click(more);
  const found = inHexes();
  fireEvent.click(screen.getByTestId('do-hex-back'));
  return found;
}

function expectNoStrip(): void {
  expect(screen.queryByTestId('left-strip')).toBeNull();
  expect(document.querySelector('[data-anchor="left-strip"]')?.childElementCount ?? 0).toBe(0);
}

beforeEach(() => {
  stubMedia();
  ships.clear();
  resetFleetStatus();
  setFleetCommands({ setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), setSpeed: vi.fn(), salvage: vi.fn() });
  panelData = null;
  useUIStore.setState({
    phase: 'game', rightPanel: null, travelling: true, pilotMode: 'spectator', isDead: false,
    buildMode: false, placementKind: null, fleetPick: null,
    selection: { ids: [], focusId: null, focusKind: null },
    activeGroupId: 'primary',
    fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
  });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  resetFleetCommands(); lockSelected.mockReset(); sendPilotShip.mockReset();
});

describe('touch: no left strip, every leftover in the do-hexes', () => {
  it('Fly, own parked hull tapped: Pilot is behind More (the Fly set is full); it takes the helm', () => {
    panelData = { name: 'Hauler', hpPct: 100, shieldPct: null, entityId: 4, hasCargo: true, pilotShipId: 'h1' };
    useUIStore.setState({ pilotMode: 'pilot' });
    mount();
    select([], 'h1', 'lingering');
    expectNoStrip();
    expect(screen.getByTestId('do-hex-more').getAttribute('data-state')).toBe('menu');
    expect(reachable('ship-action-pilot')).toBe(true);
    expect(reachable('do-hex-cargo')).toBe(true);
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('more');
    fireEvent.click(screen.getByTestId('ship-action-pilot'));
    expect(sendPilotShip).toHaveBeenCalledWith('h1');
    // The pick closes the More sub-set; its first hex still opens Details.
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('fly');
    fireEvent.click(screen.getByTestId('do-hex-more'));
    fireEvent.click(screen.getByTestId('do-hex-more-panel'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });

  it('Fly, a tapped ship with cargo and a pod in reach: Lock / Cargo / Salvage hexes, no strip, More opens Details', () => {
    panelData = { name: 'Trader', hpPct: 100, shieldPct: null, cargoShip: 'p2' };
    useUIStore.setState({ pilotMode: 'pilot' });
    mount();
    select([], 'p2', 'ship');
    expectNoStrip();
    expect(screen.getByTestId('do-hex-cargo').getAttribute('data-state')).toBe('theirs');
    expect(screen.getByTestId('do-hex-lock').getAttribute('data-state')).toBe('lock');
    expect(screen.getByTestId('do-hex-more').getAttribute('data-state')).toBeNull();
    act(() => { panelData = { name: 'Pod', hpPct: 100, shieldPct: null, entityId: 7, podOpen: true }; });
    select([], 'pod-7', 'pod');
    expectNoStrip();
    expect(screen.getByTestId('do-hex-salvage').getAttribute('data-state')).toBe('in-reach');
  });

  it('Command, own ships with one of them focused: its Cargo and Pilot are behind More; More\'s first hex is Orders', () => {
    panelData = { name: 'Hauler', hpPct: 100, shieldPct: null, cargoShip: 'a', pilotShipId: 'a', isOwn: true };
    mount();
    select(['a', 'b'], 'a', 'lingering');
    expectNoStrip();
    expect(screen.getByTestId('who-hexes')).toBeInTheDocument();
    for (const t of ['cargo-open-toggle', 'ship-action-pilot', 'do-hex-move', 'do-hex-stop']) expect(reachable(t), t).toBe(true);
    fireEvent.click(screen.getByTestId('do-hex-more'));
    fireEvent.click(screen.getByTestId('do-hex-more-panel'));
    expect(useUIStore.getState().rightPanel).toBe('orders');
  });

  it('Command, own ships, nothing extra: More still opens Orders at once', () => {
    mount();
    select(['a', 'b'], null, null);
    expectNoStrip();
    expect(screen.getByTestId('do-hex-more').getAttribute('data-state')).toBeNull();
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('orders');
  });

  const FOCUS: ReadonlyArray<[SelectionFocusKind, PanelData, string[]]> = [
    ['ship', { name: 'Raider', hpPct: 100, shieldPct: null, cargoShip: 'p2' }, ['fc-target', 'cargo-open-toggle']],
    ['lingering', { name: 'Parked', hpPct: 100, shieldPct: null, pilotShipId: 'h1', cargoShip: 'h1', isOwn: true }, ['ship-action-pilot', 'cargo-open-toggle']],
    ['drone', { name: 'Drone', hpPct: 100, shieldPct: null, entityId: 3, hasCargo: true }, ['fc-target', 'cargo-open-toggle']],
    ['structure', { name: 'Depot', hpPct: 100, shieldPct: null, entityId: 5, hasCargo: true }, ['fc-target', 'cargo-open-toggle']],
    ['asteroid', { name: 'Rock', hpPct: 100, shieldPct: null }, []],
    ['pod', { name: 'Pod', hpPct: 100, shieldPct: null, entityId: 7, podOpen: true }, ['pod-open']],
    ['salvage', { name: 'Scrap', hpPct: 100, shieldPct: null }, []],
  ];
  for (const [kind, data, extras] of FOCUS) {
    it(`Command, a focus-only ${kind}: a small do-hex set (${[...extras, 'More'].join(', ')}); More opens its Details`, () => {
      panelData = data;
      mount();
      select([], 'f1', kind);
      expectNoStrip();
      expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('focus');
      for (const t of extras) expect(reachable(t), t).toBe(true);
      expect(screen.getByTestId('do-hex-more').getAttribute('aria-label')).toBe(`${data.name}: details`);
      fireEvent.click(screen.getByTestId('do-hex-more'));
      expect(useUIStore.getState().rightPanel).toBe('details');
    });
  }

  it('own ships + a tapped storage of someone else: the target set, its Cargo in a free cell', () => {
    panelData = { name: 'Depot', hpPct: 100, shieldPct: null, entityId: 5, hasCargo: true };
    mount();
    select(['a'], 's5', 'structure');
    expectNoStrip();
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('target');
    expect(screen.getByTestId('do-hexes').querySelector('[data-testid="cargo-open-toggle"]')).not.toBeNull();
    for (const t of ['do-hex-follow', 'do-hex-move-to', 'do-hex-attack', 'do-hex-more', 'do-hex-clear']) expect(reachable(t), t).toBe(true);
    fireEvent.click(screen.getByTestId('cargo-open-toggle'));
    expect(screen.getByTestId('stub-loot')).toBeInTheDocument();
  });

  it('own ships + a tapped rock: its personal Lock (not the fleet Attack) is a hex', () => {
    panelData = { name: 'Rock', hpPct: 100, shieldPct: null };
    mount();
    select(['a'], 'r1', 'asteroid');
    expectNoStrip();
    // The rock is not fleet-attackable; whatever the selection builder offers is reachable.
    expect(screen.getByTestId('do-hex-attack').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('do-hex-clear')).toBeInTheDocument();
  });

  it('Build, your own storage selected: Upgrade, Demolish, Power, Cargo, More', () => {
    panelData = { name: 'Silo', hpPct: 100, shieldPct: null, entityId: 9, isStructure: true, isOwn: true, powerSwitch: true, hasCargo: true };
    useUIStore.setState({ buildMode: true });
    mount();
    select([], 'swarm-9', 'structure');
    expectNoStrip();
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('build');
    for (const t of ['do-hex-upgrade', 'do-hex-demolish', 'do-hex-power', 'cargo-open-toggle', 'do-hex-more']) expect(reachable(t), t).toBe(true);
  });

  it('Build, a structure you may not manage: a small set with its Lock, Cargo and Details', () => {
    panelData = { name: 'Their depot', hpPct: 100, shieldPct: null, entityId: 5, isStructure: true, hasCargo: true };
    useUIStore.setState({ buildMode: true });
    mount();
    select([], 's5', 'structure');
    expectNoStrip();
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('focus');
    for (const t of ['fc-target', 'cargo-open-toggle', 'do-hex-more']) expect(reachable(t), t).toBe(true);
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });

  it('a route pick: its tools are do-hexes, no strip', () => {
    mount();
    select(['a'], null, null);
    act(() => { useUIStore.setState({ fleetPick: { kind: 'patrol', points: 2, doneSeq: 0, undoSeq: 0 } as never }); });
    expectNoStrip();
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('route');
    for (const t of ['do-hex-route-done', 'do-hex-route-cancel']) expect(reachable(t), t).toBe(true);
  });
});

describe('desktop keeps the strip (a later tranche)', () => {
  it('a focus-only pick: the strip with the personal Target and Details; no focus do-hexes', () => {
    panelData = { name: 'Depot', hpPct: 100, shieldPct: null };
    mount(false);
    select([], 's1', 'structure');
    expect(screen.getByTestId('left-strip')).toBeInTheDocument();
    expect(screen.getByTestId('left-strip-details')).toBeInTheDocument();
    expect(screen.queryByTestId('do-hexes')).toBeNull();
  });

  it('own ships with one focused: the fleet hexes keep their plain More; Cargo stays on the strip', () => {
    panelData = { name: 'Hauler', hpPct: 100, shieldPct: null, cargoShip: 'a', isOwn: true };
    mount(false);
    select(['a', 'b'], 'a', 'lingering');
    expect(screen.getByTestId('left-strip').querySelector('[data-testid="cargo-open-toggle"]')).not.toBeNull();
    expect(screen.getByTestId('do-hex-more').getAttribute('data-state')).toBeNull();
  });
});
