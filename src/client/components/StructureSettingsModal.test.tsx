/**
 * Lock for the building settings window: the cog in the inspector's owner
 * action row opens a tabbed window on the Power tab (read-only numbers from
 * the structure slice), on the loot window's frame (GameWindow), and a
 * building you do not own has no cog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { settingsTabsFor, StructureSettingsModal } from './StructureSettingsModal.js';
import { encodeRecipe } from '../../shared-types/production.js';
import { SetRecipeSchema } from '../../shared-types/messages.js';
import { LootWindow } from './LootWindow.js';

function seedTurret(owner: string, drawFull: boolean): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 35, connTo: [3], built: true, buildPct: 1, deconstructPct: 0, owner, ownerName: 'Nova', drawFull }]]),
      swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' } });
}

/** A sideways phone: coarse pointer, 844x390 (the HUD's phone check, useHudSize). */
function asSidewaysPhone(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('innerWidth', 844);
  vi.stubGlobal('innerHeight', 390);
}
/** The window's frame (MUI Paper) inside a GameWindow root. */
const frameOf = (root: HTMLElement): HTMLElement => root.querySelector('.MuiPaper-root') as HTMLElement;

describe('StructureSettingsModal', () => {
  beforeEach(() => {
    // The cog sits with the building-management actions: Build mode only.
    useUIStore.setState({ buildMode: true, selection: { ids: [], focusId: null, focusKind: null } });
    resetSelectionStats();
  });
  afterEach(() => { setGameClient(null); vi.unstubAllGlobals(); });

  it('cog opens the settings window on the Power tab', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('structure-settings')).toBeNull();
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getByTestId('structure-settings')).toBeInTheDocument();
    expect(screen.getByTestId('structure-settings-tab-power')).toHaveAttribute('aria-selected', 'true');
    // Same figures as the inspector's PWR line: an engaging turret draws 15 in full.
    const power = screen.getByTestId('structure-settings-power');
    expect(power).toHaveAttribute('data-self-power', '-15');
    expect(power).toHaveAttribute('data-load', 'full');
    expect(screen.getByTestId('settings-power-grid')).toHaveTextContent('+35');
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR -15');
    fireEvent.click(screen.getByTestId('structure-settings-close'));
    expect(screen.queryByTestId('structure-settings')).toBeNull();
  });

  it('the settings modal uses the loot modal frame', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    const settings = screen.getByTestId('structure-settings');
    expect(settings).toHaveAttribute('data-game-window', '1');
    // A real modal: a dimmed backdrop, not the old invisible one.
    const backdrop = settings.querySelector('.MuiBackdrop-root');
    expect(backdrop).not.toBeNull();
    expect(backdrop).not.toHaveClass('MuiBackdrop-invisible');
    expect(screen.getByTestId('structure-settings')).toHaveTextContent('Turret settings');
    // Close in the footer, like the loot window.
    fireEvent.click(screen.getByTestId('structure-settings-close-btn'));
    expect(screen.queryByTestId('structure-settings')).toBeNull();
    setGameClient(null); // the loot window asks the server; no room here
    render(<LootWindow open title="Cargo pod" entityId={4} onClose={() => {}} />);
    expect(screen.getByTestId('loot-window')).toHaveAttribute('data-game-window', '1');
  });

  it('an idle building reads Idle on the Power tab', () => {
    seedTurret('me-123', false);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getByTestId('structure-settings-power')).toHaveAttribute('data-load', 'idle');
    expect(screen.getByTestId('settings-power-draw')).toHaveTextContent('-3');
  });

  it('no cog on a building you do not own', () => {
    seedTurret('other-1', true);
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-settings')).toBeNull();
  });

  it('on a phone a window with one line of content is as tall as the screen', () => {
    asSidewaysPhone();
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    const win = screen.getByTestId('structure-settings');
    expect(win).toHaveAttribute('data-window-size', 'full');
    expect(getComputedStyle(frameOf(win)).height).toBe('calc(100% - 24px)');
    expect(getComputedStyle(frameOf(win)).width).toBe('calc(100% - 24px)');
  });

  // #1046 phone still: the cog drew ~1.5x its siblings (it missed phoneTiny).
  // jsdom skips @media and descendant rules in getComputedStyle, so read the
  // icon's emitted CSS: each size (xs, sm, under a phone root) must match.
  it('the cog icon is sized like its sibling action icons, phone and desktop', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    const sizes = (id: string): string[] => {
      const cls = [...screen.getByTestId(id).querySelector('svg')!.classList].find((c) => c.startsWith('css-'))!;
      const css = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n');
      return css.split('}').filter((r) => r.includes(cls) && r.includes('font-size')).map((r) => r.replace(cls, 'X').trim());
    };
    const sibling = sizes('structure-action-deconstruct');
    expect(sibling).toContain('[data-hud-phone] .X{font-size:16px;');
    expect(sizes('structure-action-settings')).toEqual(sibling);
  });

  it('every building kind has the Power tab first', () => {
    expect(settingsTabsFor('turret')[0]?.id).toBe('power');
    expect(settingsTabsFor('solar')[0]?.id).toBe('power');
  });
});

/** A shipyard I own, building interceptors with `left` outputs to go
 *  (undefined = forever); returns the room.send spy. */
function seedShipyard(left: number | undefined): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[7, {
        powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123',
        recipe: encodeRecipe('build_interceptor'), prodCount: left,
      }]]),
      swarm: new Map([[7, { kind: 2, shipKind: 'shipyard', radius: 60, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  return send;
}

function openProduction(): void {
  render(<StructureSettingsModal open entityId={7} title="Shipyard" onClose={() => {}} />);
  fireEvent.click(screen.getByTestId('structure-settings-tab-production'));
}

describe('StructureSettingsModal Production tab (build count)', () => {
  afterEach(() => { setGameClient(null); });

  it('only buildings that make things get the Production tab', () => {
    expect(settingsTabsFor('shipyard').map((t) => t.id)).toEqual(['power', 'production']);
    expect(settingsTabsFor('refinery').map((t) => t.id)).toEqual(['power', 'production']);
    expect(settingsTabsFor('turret').map((t) => t.id)).toEqual(['power']);
    expect(settingsTabsFor('habitat_module').map((t) => t.id)).toEqual(['power']);
  });

  it('the Production tab shows the recipe and how many are left', () => {
    seedShipyard(2);
    openProduction();
    expect(screen.getByTestId('settings-production-recipe')).toHaveTextContent('Build Interceptor');
    expect(screen.getByTestId('settings-build-count')).toHaveTextContent('2 left');
  });

  it('plus sends a count of 2', () => {
    const send = seedShipyard(1);
    openProduction();
    fireEvent.click(screen.getByTestId('settings-build-plus'));
    const msg = { type: 'set_recipe', entityId: 7, recipe: 'build_interceptor', count: 2 };
    expect(send).toHaveBeenCalledWith('set_recipe', msg);
    expect(SetRecipeSchema.safeParse(msg).success).toBe(true);
  });

  it('minus never goes below 1', () => {
    const send = seedShipyard(1);
    openProduction();
    expect(screen.getByTestId('settings-build-minus')).toBeDisabled();
    fireEvent.click(screen.getByTestId('settings-build-minus'));
    expect(send).not.toHaveBeenCalled();
  });

  it('forever shows "Forever"; plus starts a count of 1; the forever button clears it', () => {
    const send = seedShipyard(undefined);
    openProduction();
    expect(screen.getByTestId('settings-build-count')).toHaveTextContent('Forever');
    expect(screen.getByTestId('settings-build-forever')).toBeDisabled();
    fireEvent.click(screen.getByTestId('settings-build-plus'));
    expect(send).toHaveBeenLastCalledWith('set_recipe', { type: 'set_recipe', entityId: 7, recipe: 'build_interceptor', count: 1 });
    setGameClient(null);
    const send2 = seedShipyard(0);
    render(<StructureSettingsModal open entityId={7} title="Shipyard" onClose={() => {}} />);
    fireEvent.click(screen.getAllByTestId('structure-settings-tab-production')[1]!);
    expect(screen.getAllByTestId('settings-build-count')[1]).toHaveTextContent('Done');
    fireEvent.click(screen.getAllByTestId('settings-build-forever')[1]!);
    const msg = { type: 'set_recipe', entityId: 7, recipe: 'build_interceptor' };
    expect(send2).toHaveBeenCalledWith('set_recipe', msg);
    expect(SetRecipeSchema.safeParse(msg).success).toBe(true);
  });
});
