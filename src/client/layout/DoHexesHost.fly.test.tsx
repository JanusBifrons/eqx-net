/**
 * Selection-HUD S3b: the do-hexes in Fly (touch). Stance Lock Boost / More
 * Salvage Cargo, Boost under the thumb as a HOLD (lets go on unmount), Lock
 * from the selection builder (targetLock), Salvage lit only with a pod in
 * reach, Stance = every weapon group's fire mode, Cargo opens the hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PanelData } from '../components/selectionPanelData';

const client = {
  mirror: { localPlayerId: 'me' },
  lockSelected: vi.fn(), cancelLock: vi.fn(), setGroupMode: vi.fn(),
};
let panel: PanelData | null = null;
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => client }));
vi.mock('../components/selectionPanelData', () => ({ useSelectionPanelData: () => panel }));
vi.mock('../components/LootWindow', () => ({
  LootWindow: ({ open }: { open: boolean }) => (open ? <div data-testid="stub-loot" /> : null),
}));

import { useUIStore } from '../state/store';
import { LayoutProvider } from './LayoutProvider';
import { DoHexesHost, sharedFireMode } from './DoHexesHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const touch = { setBoostHeld: vi.fn() };
const group = (id: string, mode: 'auto' | 'manual', locks: { target: string; stage: number }[] = []) => ({
  id, name: id, mode, colour: 0, capacity: 1, locks,
});

function mount(t: typeof touch | null = touch): ReturnType<typeof render> {
  return render(<LayoutProvider><DoHexesHost touchInput={t} /></LayoutProvider>);
}

const cellOf = (testId: string): string | null =>
  screen.getByTestId(testId).closest('[data-cell]')?.getAttribute('data-cell') ?? null;
const attr = (testId: string, a: string): string | null => screen.getByTestId(testId).getAttribute(a);

/** HoldButton listens for pointer events (jsdom has no PointerEvent: a plain Event carrying pointerId). */
function pointer(el: HTMLElement, type: string): void {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { pointerId: number };
  e.pointerId = 1;
  act(() => { el.dispatchEvent(e); });
}

beforeEach(() => {
  stubMedia();
  panel = null;
  useUIStore.setState({
    phase: 'game', travelling: true, rightPanel: null, pilotMode: 'pilot', isDead: false,
    buildMode: false, placementKind: null, fleetPick: null,
    selection: { ids: [], focusId: null, focusKind: null },
    fcGroups: [group('g1', 'auto'), group('g2', 'auto')], activeGroupId: 'g1',
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  touch.setBoostHeld.mockReset();
  client.lockSelected.mockReset();
  client.cancelLock.mockReset();
  client.setGroupMode.mockReset();
});

describe('Fly do-hexes (S3b)', () => {
  it('six hexes, each a word; rows "Stance Lock Boost / More Salvage Cargo", Boost under the thumb', () => {
    mount();
    expect(attr('do-hexes', 'data-set')).toBe('fly');
    const words: Record<string, string> = {
      'boost-face': 'Boost', lock: 'Lock', cargo: 'Cargo', stance: 'Stance', salvage: 'Salvage', more: 'More',
    };
    for (const [k, w] of Object.entries(words)) expect(screen.getByTestId(`do-hex-${k}-word`).textContent, k).toBe(w);
    expect(cellOf('do-hex-boost')).toBe('0');
    expect(cellOf('do-hex-lock')).toBe('1');
    expect(cellOf('do-hex-cargo')).toBe('2');
    expect(cellOf('do-hex-stance')).toBe('3');
    expect(cellOf('do-hex-salvage')).toBe('4');
    expect(cellOf('do-hex-more')).toBe('5');
    expect(screen.getByTestId('do-hexes').closest('[data-anchor="bottom-right"]')).not.toBeNull();
  });

  it('colour hints: red Lock, cyan Boost and More, amber Salvage, grey Stance and Cargo', () => {
    mount();
    expect(attr('do-hex-lock', 'data-tone')).toBe('danger');
    expect(attr('do-hex-boost-face', 'data-tone')).toBe('primary');
    expect(attr('do-hex-more', 'data-tone')).toBe('primary');
    expect(attr('do-hex-salvage', 'data-tone')).toBe('warn');
    expect(attr('do-hex-stance', 'data-tone')).toBe('neutral');
    expect(attr('do-hex-cargo', 'data-tone')).toBe('neutral');
  });

  it('none on desktop (no touch input), in Command, in Build, dead, or under a right panel', () => {
    const { unmount } = mount(null);
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    unmount();
    mount();
    expect(screen.getByTestId('do-hexes')).toBeTruthy();
    act(() => { useUIStore.setState({ pilotMode: 'spectator' }); });
    expect(screen.queryByTestId('do-hex-boost')).toBeNull();
    act(() => { useUIStore.setState({ pilotMode: 'pilot', buildMode: true }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    act(() => { useUIStore.setState({ buildMode: false, isDead: true }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    act(() => { useUIStore.setState({ isDead: false, rightPanel: 'contacts' }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
  });

  it('Boost is a hold: down holds, up lets go, lit while held', () => {
    mount();
    const boost = screen.getByTestId('do-hex-boost');
    pointer(boost, 'pointerdown');
    expect(touch.setBoostHeld).toHaveBeenLastCalledWith(true);
    expect(attr('do-hex-boost-face', 'data-lit')).toBe('true');
    expect(attr('do-hex-boost', 'data-state')).toBe('held');
    pointer(boost, 'pointerup');
    expect(touch.setBoostHeld).toHaveBeenLastCalledWith(false);
    expect(attr('do-hex-boost-face', 'data-lit')).toBe('false');
  });

  it('a held Boost lets go when a right panel hides the hexes', () => {
    mount();
    pointer(screen.getByTestId('do-hex-boost'), 'pointerdown');
    expect(touch.setBoostHeld).toHaveBeenLastCalledWith(true);
    act(() => { useUIStore.setState({ rightPanel: 'contacts' }); });
    expect(screen.queryByTestId('do-hex-boost')).toBeNull();
    expect(touch.setBoostHeld).toHaveBeenLastCalledWith(false);
  });

  it('Lock: dim with nothing tapped; with a ship tapped it locks, then shows the lock stage', () => {
    mount();
    expect(attr('do-hex-lock', 'data-dim')).toBe('true');
    expect(attr('do-hex-lock', 'data-state')).toBe('none');
    fireEvent.click(screen.getByTestId('do-hex-lock'));
    expect(client.lockSelected).not.toHaveBeenCalled();

    panel = { name: 'Fighter', hpPct: 100, shieldPct: null };
    act(() => { useUIStore.setState({ selection: { ids: [], focusId: 'enemy', focusKind: 'ship' } }); });
    expect(attr('do-hex-lock', 'data-dim')).toBe('false');
    expect(attr('do-hex-lock', 'data-state')).toBe('lock');
    fireEvent.click(screen.getByTestId('do-hex-lock'));
    expect(client.lockSelected).toHaveBeenCalledTimes(1);

    act(() => { useUIStore.setState({ fcGroups: [group('g1', 'auto', [{ target: 'p:enemy', stage: 2 }])] }); });
    expect(attr('do-hex-lock', 'data-state')).toBe('unlock');
    expect(attr('do-hex-lock', 'data-lit')).toBe('true');
    fireEvent.click(screen.getByTestId('do-hex-lock'));
    expect(client.cancelLock).toHaveBeenCalledWith('g1', 'p:enemy');
  });

  it('Salvage: dim with nothing in reach; lit with a tapped pod in reach, and opens it', () => {
    mount();
    expect(attr('do-hex-salvage', 'data-lit')).toBe('false');
    expect(attr('do-hex-salvage', 'data-dim')).toBe('true');
    fireEvent.click(screen.getByTestId('do-hex-salvage'));
    expect(screen.queryByTestId('stub-loot')).toBeNull();

    panel = { name: 'Cargo pod', hpPct: 0, shieldPct: null, noHull: true, entityId: 7, podOpen: true };
    act(() => { useUIStore.setState({ selection: { ids: [], focusId: 'swarm-7', focusKind: 'pod' } }); });
    expect(attr('do-hex-salvage', 'data-lit')).toBe('true');
    expect(attr('do-hex-salvage', 'data-state')).toBe('in-reach');
    fireEvent.click(screen.getByTestId('do-hex-salvage'));
    expect(screen.getByTestId('stub-loot')).toBeTruthy();
  });

  it('Cargo opens the hold; More opens Details with something tapped, else Contacts', () => {
    mount();
    fireEvent.click(screen.getByTestId('do-hex-cargo'));
    expect(useUIStore.getState().rightPanel).toBe('hold');
    act(() => { useUIStore.setState({ rightPanel: null }); });
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('contacts');
    act(() => { useUIStore.setState({ rightPanel: null, selection: { ids: [], focusId: 'enemy', focusKind: 'ship' } }); });
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });

  it('Stance swaps to Auto fire / Hold fire (current lit, Back far corner); a pick sets every group', () => {
    mount();
    expect(attr('do-hex-stance', 'data-state')).toBe('auto');
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    expect(attr('do-hexes', 'data-set')).toBe('stance');
    expect(screen.queryByTestId('do-hex-boost')).toBeNull();
    expect(attr('do-hex-fire-auto', 'data-lit')).toBe('true');
    expect(cellOf('do-hex-back')).toBe('2');
    fireEvent.click(screen.getByTestId('do-hex-fire-manual'));
    expect(client.setGroupMode).toHaveBeenCalledWith('g1', 'manual');
    expect(client.setGroupMode).toHaveBeenCalledWith('g2', 'manual');
    expect(attr('do-hexes', 'data-set')).toBe('fly');
  });

  it('Back returns without a change; no weapon groups = Stance dim', () => {
    mount();
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    fireEvent.click(screen.getByTestId('do-hex-back'));
    expect(client.setGroupMode).not.toHaveBeenCalled();
    expect(attr('do-hexes', 'data-set')).toBe('fly');
    act(() => { useUIStore.setState({ fcGroups: [] }); });
    expect(attr('do-hex-stance', 'data-dim')).toBe('true');
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    expect(attr('do-hexes', 'data-set')).toBe('fly');
  });

  it('sharedFireMode: one shared mode, else null', () => {
    expect(sharedFireMode([])).toBeNull();
    expect(sharedFireMode([{ mode: 'auto' }, { mode: 'auto' }])).toBe('auto');
    expect(sharedFireMode([{ mode: 'auto' }, { mode: 'manual' }])).toBeNull();
  });
});
