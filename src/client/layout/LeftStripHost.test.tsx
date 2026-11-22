/**
 * UI plan U1-8: the left strip host. Shows the selection strip only while
 * something is selected; slides away while a right panel is open and comes
 * back when it closes; ⚙ opens the selection's panel; ✕ deselects through
 * the renderer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import type { PanelData } from '../components/selectionPanelData';

// The focus's panel data (its hull ring) and the game client (the personal
// Target's lock) are stubbed: the strip's layout is what is under test.
let panelData: PanelData | null = null;
vi.mock('../components/selectionPanelData', async (orig) => ({
  ...(await orig<typeof import('../components/selectionPanelData')>()),
  useSelectionPanelData: () => panelData,
}));
const lockSelected = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { localPlayerId: 'me', ships: new Map() }, lockSelected, cancelLock: vi.fn(), getRoom: () => null }),
}));

import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost, stripFocusIdentity, stripHealth, stripIdentity } from './LeftStripHost';
import { STANCE_COLOUR } from '../components/contactRows';
import { HUD } from '../hud/tokens';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const selectFleetShips = vi.fn();
const attackFocus = vi.fn();
const rendererRef = { current: { selectFleetShips, attackFocus } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /></LayoutProvider>);
}

function select(ids: string[], focusId: string | null = null, focusKind: 'ship' | 'structure' | 'drone' | 'asteroid' | null = null): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId, focusKind } }); });
}

beforeEach(() => {
  stubMedia();
  useUIStore.setState({
    rightPanel: null, travelling: true, pilotMode: 'spectator',
    buildMode: false, placementKind: null, fleetPick: null,
    selection: { ids: [], focusId: null, focusKind: null },
    activeGroupId: 'primary',
    fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
  });
  panelData = null;
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  selectFleetShips.mockReset(); attackFocus.mockReset(); lockSelected.mockReset();
});

/** The computed form jsdom gives a colour, so hex tokens compare to computed styles. */
function computedColor(c: string): string {
  const probe = document.createElement('div');
  probe.style.borderColor = c;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return v;
}

const stripButtons = (): string[] =>
  Array.from(screen.getByTestId('left-strip').querySelectorAll('[data-testid]'))
    .map((b) => b.getAttribute('data-testid') ?? '')
    .filter((t) => t === 'fc-target' || t === 'left-strip-lock' || t === 'left-strip-focus' || t === 'left-strip-identity');

/**
 * Tap rule T2 (UI plan D10): my ships selected + a focus that is not mine.
 * The strip shows the fleet section, a separator, the focus (its identity,
 * ringed by ITS hull) and ONE Lock that orders the ships to attack it. A rock
 * or pod keeps the personal Target; with no ships the strip is unchanged.
 */
describe('LeftStripHost: ships selected + a not-mine focus (T2)', () => {
  it('an attackable focus: fleet identity, focus identity, ONE Lock; no personal Target', () => {
    panelData = { name: 'Raider', hpPct: 20, shieldPct: null };
    mount();
    select(['a', 'b'], 'swarm-7', 'drone');
    expect(stripButtons()).toEqual(['left-strip-identity', 'left-strip-focus', 'left-strip-lock']);
    // The hull ring is the focus's, not the fleet's.
    expect(screen.getByTestId('left-strip-focus').getAttribute('data-health')).toBe('crit');
    expect(screen.getByTestId('left-strip-focus').getAttribute('aria-label')).toBe('Raider');
    expect(screen.getByTestId('left-strip-identity').getAttribute('data-health')).toBe('ok');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('2 ships selected');
  });

  it('the focus icon wears its stance colour (the contacts table\'s), and its kind glyph', () => {
    panelData = { name: 'Raider', hpPct: 100, shieldPct: null, stance: 'hostile' };
    mount();
    select(['a'], 'swarm-7', 'drone');
    const focus = screen.getByTestId('left-strip-focus');
    expect(focus.getAttribute('data-state')).toBe('hostile');
    expect(STANCE_COLOUR.hostile).toBe('#ff6b6b');
    expect(getComputedStyle(focus).color).toBe('rgb(255, 107, 107)');
    expect(focus.querySelector('svg')?.getAttribute('data-icon')).toBe('ship');
    // The fleet identity keeps its own (gold) look: only the focus is tinted.
    expect(screen.getByTestId('left-strip-identity').getAttribute('data-state')).toBeNull();
  });

  it('a hostile focus rings in the hostile colour, not the green selected ring', () => {
    panelData = { name: 'Raider', hpPct: 100, shieldPct: null, stance: 'hostile' };
    mount();
    select(['a'], 'swarm-7', 'drone');
    const ring = getComputedStyle(screen.getByTestId('left-strip-focus')).borderTopColor;
    expect(ring).toBe(computedColor(STANCE_COLOUR.hostile));
    expect(ring).not.toBe(computedColor(HUD.color.hullOk));
  });

  it('a neutral focus rings in the neutral colour', () => {
    panelData = { name: 'Depot', hpPct: 100, shieldPct: null, stance: 'neutral' };
    mount();
    select([], 'swarm-9', 'structure');
    expect(getComputedStyle(screen.getByTestId('left-strip-identity')).borderTopColor).toBe(computedColor(STANCE_COLOUR.neutral));
  });

  it('a friendly focus keeps the green (hull) ring', () => {
    panelData = { name: 'Ally', hpPct: 100, shieldPct: null, stance: 'friendly' };
    mount();
    select(['a'], 'ally-1', 'ship');
    expect(getComputedStyle(screen.getByTestId('left-strip-focus')).borderTopColor).toBe(computedColor(HUD.color.hullOk));
  });

  it('a focus-only pick tints the one identity: a neutral structure reads the normal ink (not amber), structure glyph', () => {
    panelData = { name: 'Depot', hpPct: 100, shieldPct: null, stance: 'neutral' };
    mount();
    select([], 'swarm-9', 'structure');
    const id = screen.getByTestId('left-strip-identity');
    expect(id.getAttribute('data-state')).toBe('neutral');
    expect(getComputedStyle(id).color).toBe('rgb(223, 232, 245)');
    expect(id.querySelector('svg')?.getAttribute('data-icon')).toBe('structure');
  });

  it('Lock orders the selected ships to attack the focus (the renderer, like right-click)', () => {
    mount();
    select(['a'], 'p2', 'ship');
    fireEvent.click(screen.getByTestId('left-strip-lock'));
    expect(attackFocus).toHaveBeenCalledOnce();
    expect(lockSelected).not.toHaveBeenCalled();
  });

  it('a rock with ships selected: the focus shows, with the personal Target (no fleet Lock)', () => {
    mount();
    select(['a'], 'swarm-4', 'asteroid');
    expect(stripButtons()).toEqual(['left-strip-identity', 'left-strip-focus', 'fc-target']);
  });

  it('no ships selected: unchanged (one identity, the personal Target)', () => {
    panelData = { name: 'Fighter', hpPct: 40, shieldPct: null };
    mount();
    select([], 'p2', 'ship');
    expect(stripButtons()).toEqual(['left-strip-identity', 'fc-target']);
    expect(screen.getByTestId('left-strip-identity').getAttribute('data-health')).toBe('warn');
  });

  it('the focus is one of my selected ships: no focus section, no Lock', () => {
    panelData = { name: 'My fighter', hpPct: 100, shieldPct: null, isOwn: true };
    mount();
    select(['a', 'b'], 'a', 'ship');
    expect(stripButtons()).toEqual(['left-strip-identity']);
  });
});

describe('stripFocusIdentity', () => {
  it('only for a focus that is not one of the selected ships, while ships are selected', () => {
    expect(stripFocusIdentity({ ids: [], focusId: 'p2', focusKind: 'ship' })).toBeNull();
    expect(stripFocusIdentity({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toBeNull();
    expect(stripFocusIdentity({ ids: ['a'], focusId: null, focusKind: null })).toBeNull();
    expect(stripFocusIdentity({ ids: ['a'], focusId: 'swarm-3', focusKind: 'structure' })).toMatchObject({ icon: 'structure', tooltip: 'Structure' });
  });
});

describe('LeftStripHost (U1-8)', () => {
  it('nothing selected: no strip', () => {
    mount();
    expect(screen.queryByTestId('left-strip')).toBeNull();
  });

  it('a ship group shows the identity with its count', () => {
    mount();
    select(['a', 'b', 'c']);
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('3 ships selected');
  });

  it('panel open: strip hidden; panel closed: strip back', () => {
    mount();
    select(['a']);
    act(() => { useUIStore.getState().setRightPanel('galaxy'); });
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
    act(() => { useUIStore.getState().setRightPanel(null); });
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('true');
  });

  it('⚙ opens the selection\'s panel (Fleet for own ships)', () => {
    mount();
    select(['a', 'b']);
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('orders');
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
  });

  it('✕ deselects through the renderer (it owns the selection)', () => {
    mount();
    select([], 's1', 'structure');
    fireEvent.click(screen.getByTestId('left-strip-close'));
    expect(selectFleetShips).toHaveBeenCalledWith([]);
  });

  it('a focus-only pick: ⚙ opens its Details panel (U3-2)', () => {
    mount();
    select([], 's1', 'structure');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('Structure');
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('details');
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
  });

  it("another player's ship: ⚙ opens Details, not Fleet", () => {
    mount();
    select([], 'p2', 'ship');
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });
});

describe('stripHealth', () => {
  it('rings the hull by the hull thresholds; ok when unknown or hull-less', () => {
    expect(stripHealth(null)).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 10, shieldPct: null, pending: true })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 0, shieldPct: null, noHull: true })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 80, shieldPct: null })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 40, shieldPct: null })).toBe('warn');
    expect(stripHealth({ name: 'x', hpPct: 20, shieldPct: null })).toBe('crit');
  });
});

describe('stripIdentity', () => {
  it('maps the selection to icon, count and panel', () => {
    expect(stripIdentity({ ids: [], focusId: null, focusKind: null })).toBeNull();
    expect(stripIdentity({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toMatchObject({ icon: 'fleet', count: 1, panel: 'orders' });
    expect(stripIdentity({ ids: [], focusId: 'd', focusKind: 'drone' })).toMatchObject({ icon: 'ship', count: 1, panel: 'details' });
  });

  it('never names the selection with an icon a strip button uses (one icon, one meaning)', () => {
    // Target, Cargo/Open pod, Pilot, Stop, cog, close: the buttons a strip can carry.
    const actions = new Set(['target', 'hold', 'pilot', 'stop', 'cog', 'close']);
    for (const kind of ['ship', 'lingering', 'drone', 'structure', 'asteroid', 'pod'] as const) {
      expect(actions.has(stripIdentity({ ids: [], focusId: 'x', focusKind: kind })!.icon)).toBe(false);
    }
  });
});

/**
 * Tap rule T4: the same strip in Fly. A tap focuses a ship or structure that
 * is not mine; with no ships selected its Lock is the pilot's own (the
 * personal Target, active weapon group), never the fleet order.
 */
describe('LeftStripHost in Fly (T4)', () => {
  for (const kind of ['structure', 'ship'] as const) {
    it(`a focused enemy ${kind}: its identity and the personal Lock, which locks with the active group`, () => {
      useUIStore.setState({ pilotMode: 'pilot' });
      mount();
      select([], kind === 'ship' ? 'p2' : 'swarm-7', kind);
      expect(stripButtons()).toEqual(['left-strip-identity', 'fc-target']);
      expect(screen.getByTestId('fc-target').getAttribute('data-state')).toBe('lock');
      fireEvent.click(screen.getByTestId('fc-target'));
      expect(lockSelected).toHaveBeenCalledOnce();
      expect(attackFocus).not.toHaveBeenCalled();
    });
  }
});
