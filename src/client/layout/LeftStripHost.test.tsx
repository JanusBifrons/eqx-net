/**
 * The left strip host (UI plan U1-8; selection HUD S5). In Command with own
 * ships selected the strip is the who-hex honeycomb (one hex per ship type,
 * tap keeps that type, "?" overflow opens the orders panel); Fly and Build show
 * no who-hexes. The selection's actions stay on a slim strip until the
 * do-hexes take them; ⚙ / ✕ and the identity icons are retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getShipKind, SHIP_KINDS } from '@shared-types/shipKinds';
import { useUIStore } from '../state/store';
import type { PanelData } from '../components/selectionPanelData';

// The focus's panel data and the game client (the ship kinds, the personal
// Target's lock) are stubbed: the strip's layout is what is under test.
let panelData: PanelData | null = null;
vi.mock('../components/selectionPanelData', async (orig) => ({
  ...(await orig<typeof import('../components/selectionPanelData')>()),
  useSelectionPanelData: () => panelData,
}));
const lockSelected = vi.fn();
const ships = new Map<string, { kind: string }>();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { localPlayerId: 'me', ships }, lockSelected, cancelLock: vi.fn(), getRoom: () => null }),
}));

import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost, stripIdentity } from './LeftStripHost';
import { WHO_HEX_MAX, whoHexBox, whoHexSlot, whoHexTestId } from './WhoHexes';
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

/** Put ships of the given kinds in the mirror: `{ a: 'fighter' }`. */
function fleet(kinds: Record<string, string>): void {
  for (const [id, kind] of Object.entries(kinds)) ships.set(id, { kind });
}

const KINDS = Object.keys(SHIP_KINDS);

beforeEach(() => {
  stubMedia();
  ships.clear();
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

const hexIds = (): string[] =>
  Array.from(screen.getByTestId('who-hexes').querySelectorAll('[data-variant="hex"]'))
    .map((b) => b.getAttribute('data-testid') ?? '');

describe('who hexes (selection HUD S5)', () => {
  it('one hex per ship type, "×N" under the type icon, named by its type', () => {
    const [k1, k2] = KINDS as [string, string];
    fleet({ a: k1, b: k1, c: k2 });
    mount();
    select(['a', 'b', 'c']);
    const hexes = screen.getByTestId('who-hexes');
    expect(hexes.getAttribute('data-count')).toBe('3');
    expect(hexes.getAttribute('data-kinds')).toBe('2');
    const h1 = screen.getByTestId(whoHexTestId(k1));
    expect(screen.getByTestId(`${whoHexTestId(k1)}-word`).textContent).toBe('×2');
    expect(h1.getAttribute('aria-label')).toBe(`${getShipKind(k1).displayName} ×2`);
    expect(h1.querySelector('svg')?.getAttribute('data-icon')).toBe('ship');
    expect(screen.getByTestId(`${whoHexTestId(k2)}-word`).textContent).toBe('×1');
  });

  it('tapping a hex keeps only that type selected, through the renderer', () => {
    const [k1, k2] = KINDS as [string, string];
    fleet({ a: k1, b: k2, c: k1 });
    mount();
    select(['a', 'b', 'c']);
    fireEvent.click(screen.getByTestId(whoHexTestId(k1)));
    expect(selectFleetShips).toHaveBeenCalledWith(['a', 'c']);
  });

  it('the focused ship\'s type is lit', () => {
    const [k1, k2] = KINDS as [string, string];
    fleet({ a: k1, b: k2 });
    mount();
    select(['a', 'b'], 'b', 'ship');
    expect(screen.getByTestId(whoHexTestId(k2)).getAttribute('data-lit')).toBe('true');
    expect(screen.getByTestId(whoHexTestId(k1)).getAttribute('data-lit')).toBe('false');
  });

  it('a ship whose kind is not known yet groups under "Ship"', () => {
    mount();
    select(['x']);
    expect(screen.getByTestId('who-hex-unknown').getAttribute('aria-label')).toBe('Ship ×1');
  });

  it(`more than ${WHO_HEX_MAX} types: the last slot is "?" with "+N"; it opens the orders panel`, () => {
    const six = KINDS.slice(0, 6);
    expect(six).toHaveLength(6);
    const kinds: Record<string, string> = {};
    six.forEach((k, i) => { kinds[`s${i}`] = k; });
    fleet(kinds);
    mount();
    select(Object.keys(kinds));
    expect(hexIds()).toHaveLength(WHO_HEX_MAX);
    expect(hexIds().at(-1)).toBe('who-hex-more');
    // Two types of one ship each overflow.
    expect(screen.getByTestId('who-hex-more-word').textContent).toBe('+2');
    fireEvent.click(screen.getByTestId('who-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('orders');
    expect(selectFleetShips).not.toHaveBeenCalled();
  });

  it('exactly 5 types: five type hexes, no "?"', () => {
    const kinds: Record<string, string> = {};
    KINDS.slice(0, 5).forEach((k, i) => { kinds[`s${i}`] = k; });
    fleet(kinds);
    mount();
    select(Object.keys(kinds));
    expect(hexIds()).toHaveLength(5);
    expect(screen.queryByTestId('who-hex-more')).toBeNull();
  });

  it('slides away while a right panel is open, back when it closes', () => {
    mount();
    select(['a']);
    act(() => { useUIStore.getState().setRightPanel('galaxy'); });
    expect(screen.getByTestId('who-hexes').getAttribute('data-open')).toBe('false');
    act(() => { useUIStore.getState().setRightPanel(null); });
    expect(screen.getByTestId('who-hexes').getAttribute('data-open')).toBe('true');
  });

  it('Fly and Build: no who-hexes', () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    mount();
    select(['a']);
    expect(screen.queryByTestId('who-hexes')).toBeNull();
    act(() => { useUIStore.setState({ pilotMode: 'spectator', buildMode: true }); });
    expect(screen.queryByTestId('who-hexes')).toBeNull();
  });

  it('a focus-only pick in Command: no who-hexes', () => {
    mount();
    select([], 's1', 'structure');
    expect(screen.queryByTestId('who-hexes')).toBeNull();
  });
});

describe('the honeycomb layout', () => {
  it('two per row, odd rows shifted half a hex, rows nest at 3/4 of a hex', () => {
    const s0 = whoHexSlot(0);
    const s1 = whoHexSlot(1);
    const s2 = whoHexSlot(2);
    expect(s0).toEqual({ x: 0, y: 0 });
    expect(s1.y).toBe(0);
    expect(s1.x).toBeGreaterThanOrEqual(HUD.hex.w);
    expect(s2.x).toBe(Math.round(s1.x / 2));
    expect(s2.y).toBeGreaterThan(HUD.hex.h / 2);
    expect(s2.y).toBeLessThan(HUD.hex.h);
  });

  it('five hexes fit in three rows', () => {
    const box = whoHexBox(5);
    expect(box.h).toBe(whoHexSlot(4).y + HUD.hex.h);
    expect(box.h).toBeLessThan(3 * HUD.hex.h);
    expect(whoHexBox(0)).toEqual({ w: 0, h: 0 });
  });
});

describe('the action strip (until the do-hexes take the actions)', () => {
  const stripTestIds = (): string[] =>
    Array.from(screen.getByTestId('left-strip').querySelectorAll('[data-testid]')).map((b) => b.getAttribute('data-testid') ?? '');

  it('⚙, ✕ and the identity icons are gone', () => {
    mount();
    select(['a', 'b']);
    for (const t of ['left-strip-cog', 'left-strip-close', 'left-strip-identity', 'left-strip-focus']) {
      expect(screen.queryByTestId(t)).toBeNull();
    }
  });

  it('own ships in Command: the fleet section stays on the strip', () => {
    useUIStore.setState({ phase: 'game' });
    mount();
    select(['a', 'b']);
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('left-strip-order')).toBeInTheDocument();
  });

  it('ships + an attackable focus: ONE Lock orders the ships to attack it (T2)', () => {
    mount();
    select(['a'], 'p2', 'ship');
    expect(screen.queryByTestId('fc-target')).toBeNull();
    fireEvent.click(screen.getByTestId('left-strip-lock'));
    expect(attackFocus).toHaveBeenCalledOnce();
    expect(lockSelected).not.toHaveBeenCalled();
  });

  it('a focus-only pick: the personal Target and Details, which opens its Details panel', () => {
    panelData = { name: 'Depot', hpPct: 100, shieldPct: null };
    mount();
    select([], 's1', 'structure');
    expect(stripTestIds()).toEqual(expect.arrayContaining(['fc-target', 'left-strip-details']));
    expect(screen.getByTestId('left-strip-details').getAttribute('aria-label')).toBe('Depot: details');
    fireEvent.click(screen.getByTestId('left-strip-details'));
    expect(useUIStore.getState().rightPanel).toBe('details');
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
  });

  it('no Details while ships are selected (the orders panel is the rail\'s / "?")', () => {
    mount();
    select(['a'], 's1', 'structure');
    expect(screen.queryByTestId('left-strip-details')).toBeNull();
  });

  it('nothing selected: no strip, no hexes', () => {
    mount();
    expect(screen.queryByTestId('left-strip')).toBeNull();
    expect(screen.queryByTestId('who-hexes')).toBeNull();
  });
});

describe('stripIdentity', () => {
  it('maps the selection to icon, count and panel', () => {
    expect(stripIdentity({ ids: [], focusId: null, focusKind: null })).toBeNull();
    expect(stripIdentity({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toMatchObject({ icon: 'fleet', count: 1, panel: 'orders' });
    expect(stripIdentity({ ids: [], focusId: 'd', focusKind: 'drone' })).toMatchObject({ icon: 'ship', count: 1, panel: 'details' });
  });
});

/**
 * Tap rule T4: the same strip in Fly. A tap focuses a ship or structure that
 * is not mine; with no ships selected its Lock is the pilot's own (the
 * personal Target, active weapon group), never the fleet order.
 */
describe('LeftStripHost in Fly (T4)', () => {
  for (const kind of ['structure', 'ship'] as const) {
    it(`a focused enemy ${kind}: the personal Lock, which locks with the active group`, () => {
      useUIStore.setState({ pilotMode: 'pilot' });
      mount();
      select([], kind === 'ship' ? 'p2' : 'swarm-7', kind);
      expect(screen.getByTestId('fc-target').getAttribute('data-state')).toBe('lock');
      fireEvent.click(screen.getByTestId('fc-target'));
      expect(lockSelected).toHaveBeenCalledOnce();
      expect(attackFocus).not.toHaveBeenCalled();
    });
  }
});

describe('the strip hosts the building section (U3-6)', () => {
  it('your own switchable building in Build shows Power on the strip; not in Command', () => {
    panelData = { name: 'Turret', hpPct: 100, shieldPct: null, entityId: 9, isStructure: true, isOwn: true, powerSwitch: true };
    useUIStore.setState({ buildMode: true });
    mount();
    select([], 'swarm-9', 'structure');
    expect(screen.getByTestId('left-strip-power')).toBeInTheDocument();
    act(() => { useUIStore.setState({ buildMode: false }); });
    expect(screen.queryByTestId('left-strip-power')).toBeNull();
  });
});
