/**
 * Lock for the building settings window: the Open button in the inspector
 * card's owner action row opens a tabbed side panel on the Power tab
 * (read-only numbers from the structure slice), docked beside the live map
 * (SidePanel, no backdrop), with a status block (owner, level, connections,
 * hold) above the tabs; a building you do not own has no Open button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { SETTINGS_PANEL_SIZE, settingsTabsFor, StructureSettingsModal } from './StructureSettingsModal.js';
import { rightPaperSx } from './SidePanel.js';
import { MAX_RECIPE_QUEUE, encodeRecipe } from '../../shared-types/production.js';
import { EditRecipeQueueSchema, SetRecipeSchema } from '../../shared-types/messages.js';

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


describe('StructureSettingsModal', () => {
  beforeEach(() => {
    // Open is building management: Build mode only.
    useUIStore.setState({ buildMode: true, selection: { ids: [], focusId: null, focusKind: null } });
    resetSelectionStats();
  });
  afterEach(() => { setGameClient(null); vi.unstubAllGlobals(); });

  it('Open opens the settings window on the Power tab', () => {
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
    // The status block above the tabs: what left the card.
    expect(screen.getByTestId('settings-status-owner')).toHaveTextContent('you');
    expect(screen.getByTestId('settings-status-level')).toHaveTextContent('1');
    expect(screen.queryByTestId('settings-status-conn')).toBeNull(); // not a connector
    fireEvent.click(screen.getByTestId('structure-settings-close'));
    expect(screen.queryByTestId('structure-settings')).toBeNull();
  });

  it('the settings panel docks beside the map: no backdrop, world stays live', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    const settings = screen.getByTestId('structure-settings');
    // A docked (persistent) drawer, not a modal: no backdrop, no game-window Dialog.
    expect(settings).toHaveClass('MuiDrawer-docked');
    expect(document.querySelector('.MuiBackdrop-root')).toBeNull();
    expect(settings).not.toHaveAttribute('data-game-window');
    expect(useUIStore.getState().structureSettingsOpen).toBe(true);
    expect(settings).toHaveTextContent('Turret settings');
    // Close in the footer, like the loot window.
    fireEvent.click(screen.getByTestId('structure-settings-close-btn'));
    expect(screen.queryByTestId('structure-settings')).toBeNull();
    expect(useUIStore.getState().structureSettingsOpen).toBe(false);
  });

  it('the settings panel closes when the selection changes or clears', () => {
    const onClose = vi.fn();
    seedTurret('me-123', true);
    render(<StructureSettingsModal open entityId={9} title="Turret" onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { useUIStore.setState({ selection: { ids: [], focusId: 'swarm-4', focusKind: 'structure' } }); });
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    seedTurret('me-123', true);
    render(<StructureSettingsModal open entityId={9} title="Turret" onClose={onClose} />);
    act(() => { useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } }); });
    expect(onClose).toHaveBeenCalled();
  });

  it('an idle building reads Idle on the Power tab', () => {
    seedTurret('me-123', false);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getByTestId('structure-settings-power')).toHaveAttribute('data-load', 'idle');
    expect(screen.getByTestId('settings-power-draw')).toHaveTextContent('-3');
  });

  it('no Open button on a building you do not own', () => {
    seedTurret('other-1', true);
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-settings')).toBeNull();
  });

  it('on a sideways phone the panel takes ~40% of the width, full height under the app bar', () => {
    // jsdom drops clamp() from computed styles, so lock the Paper sx itself.
    expect(rightPaperSx(SETTINGS_PANEL_SIZE, true)).toMatchObject({
      width: 'clamp(280px, 40vw, 360px)', top: 'var(--app-bar-h, 48px)', height: 'calc(100dvh - var(--app-bar-h, 48px))',
    });
    expect(rightPaperSx(SETTINGS_PANEL_SIZE, false)).toMatchObject({ width: 360 });
  });

  it('the card has one Open button; management moved to the Manage tab', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    const open = screen.getByTestId('structure-action-settings');
    expect(open.tagName).toBe('BUTTON');
    expect(open).toHaveTextContent('Open');
    expect(screen.queryByTestId('structure-action-deconstruct')).toBeNull();
    fireEvent.click(open);
    fireEvent.click(screen.getByTestId('structure-settings-tab-access'));
    expect(screen.getByTestId('structure-settings-manage')).toBeInTheDocument();
    expect(screen.getByTestId('structure-action-deconstruct')).toBeInTheDocument();
  });

  it('every building kind has the Power tab first', () => {
    expect(settingsTabsFor('turret')[0]?.id).toBe('power');
    expect(settingsTabsFor('solar')[0]?.id).toBe('power');
    // Labels read Build / Power / Manage; the ids keep their old names.
    expect(settingsTabsFor('shipyard').map((t) => t.label)).toEqual(['Power', 'Build', 'Manage']);
  });
});

/** A shipyard I own, building interceptors with `left` outputs to go
 *  (undefined = forever) and extra slice fields; returns the room.send spy. */
function seedShipyard(left: number | undefined, extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[7, {
        powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123',
        recipe: encodeRecipe('build_interceptor'), prodCount: left, ...extra,
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

const tileBtn = (recipe: string): HTMLElement => screen.getByTestId(`build-tile-${recipe}`).querySelector('button')!;
const headBtn = (): HTMLElement => screen.getByTestId('build-queue-head').querySelector('button')!;
const itemBtn = (i: number): HTMLElement => screen.getByTestId(`build-queue-item-${i}`).querySelector('button')!;
const recipeMsg = (recipe: string, count?: number): Record<string, unknown> =>
  (count === undefined ? { type: 'set_recipe', entityId: 7, recipe } : { type: 'set_recipe', entityId: 7, recipe, count });
const queueMsg = (edit: Record<string, unknown>): Record<string, unknown> => ({ type: 'edit_recipe_queue', entityId: 7, ...edit });
/** Interceptor building, gunship then interceptor queued; both blueprints in stock. */
const MIXED = { prodQueue: ['build_gunship', 'build_interceptor'], bpProduct: 'build_interceptor', bpAvailable: ['build_gunship'] };

describe('StructureSettingsModal Build tab (hull picture tiles)', () => {
  afterEach(() => { setGameClient(null); vi.useRealTimers(); });

  it('only buildings that make things get the Production tab', () => {
    expect(settingsTabsFor('shipyard').map((t) => t.id)).toEqual(['power', 'production', 'access']);
    expect(settingsTabsFor('refinery').map((t) => t.id)).toEqual(['power', 'production', 'access']);
    expect(settingsTabsFor('turret').map((t) => t.id)).toEqual(['power', 'access']);
    expect(settingsTabsFor('habitat_module').map((t) => t.id)).toEqual(['power', 'access']);
  });

  it('a shipyard shows the queue head, one tile per hull with its bill, and no Change / count row', () => {
    seedShipyard(2, { prodFrac: 0.4 });
    openProduction();
    const head = screen.getByTestId('build-queue-head');
    expect(head).toHaveAttribute('data-left', '2');
    expect(within(head).getByTestId('hull-tile-badge')).toHaveTextContent('×2');
    expect(within(head).getByTestId('hull-tile-progress')).toHaveAttribute('data-frac', '0.40');
    for (const r of ['build_interceptor', 'build_gunship', 'build_heavy', 'build_missile_frigate']) {
      expect(screen.getByTestId(`build-tile-${r}`)).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('build-tile-build_interceptor')).getByTestId('cost-chip-minerals')).toHaveTextContent('400');
    expect(screen.queryByTestId('structure-action-recipe')).toBeNull();
    expect(screen.queryByTestId('settings-build-count')).toBeNull();
    expect(screen.queryByTestId('settings-build-plus')).toBeNull();
  });

  it('the strip shows the real mixed queue from the row: interceptor, gunship, interceptor', () => {
    seedShipyard(1, { ...MIXED, prodFrac: 0.5 });
    openProduction();
    const head = screen.getByTestId('build-queue-head');
    expect(screen.getByTestId('build-queue')).toHaveAttribute('data-len', '3');
    expect(head).toHaveAttribute('data-recipe', 'build_interceptor');
    expect(within(head).getByTestId('hull-tile-progress')).toHaveAttribute('data-frac', '0.50');
    expect(within(head).queryByTestId('hull-tile-badge')).toBeNull(); // one build
    expect(screen.getByTestId('build-queue-item-1')).toHaveAttribute('data-recipe', 'build_gunship');
    expect(screen.getByTestId('build-queue-item-1')).toHaveTextContent('Gunship');
    expect(screen.getByTestId('build-queue-item-2')).toHaveAttribute('data-recipe', 'build_interceptor');
    expect(screen.queryByTestId('build-queue-item-3')).toBeNull();
    expect(within(screen.getByTestId('build-queue-item-1')).queryByTestId('hull-tile-progress')).toBeNull();
  });

  it('tapping a tile adds that hull to the queue, any hull, no confirm', () => {
    const send = seedShipyard(1, MIXED);
    openProduction();
    fireEvent.click(tileBtn('build_heavy'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('edit_recipe_queue', queueMsg({ op: 'add', recipe: 'build_heavy' }));
    expect(EditRecipeQueueSchema.safeParse(queueMsg({ op: 'add', recipe: 'build_heavy' })).success).toBe(true);
  });

  it('holding a tile adds five, capped by MAX_RECIPE_QUEUE, and the release adds no extra one', () => {
    vi.useFakeTimers();
    const send = seedShipyard(1);
    openProduction();
    fireEvent.pointerDown(tileBtn('build_interceptor'));
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(tileBtn('build_interceptor'));
    fireEvent.click(tileBtn('build_interceptor'));
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith('edit_recipe_queue', queueMsg({ op: 'add', recipe: 'build_interceptor' }));
    cleanup();
    // Head + 5 queued = 6 of MAX_RECIPE_QUEUE (8): room for two more.
    const full = seedShipyard(1, { prodQueue: Array(MAX_RECIPE_QUEUE - 3).fill('build_gunship') });
    openProduction();
    fireEvent.pointerDown(tileBtn('build_gunship'));
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(tileBtn('build_gunship'));
    expect(full).toHaveBeenCalledTimes(2);
  });

  it('tapping queue item 1 removes index 1; the head removes index 0', () => {
    const send = seedShipyard(1, MIXED);
    openProduction();
    fireEvent.click(itemBtn(1));
    expect(send).toHaveBeenLastCalledWith('edit_recipe_queue', queueMsg({ op: 'remove', index: 1 }));
    expect(EditRecipeQueueSchema.safeParse(queueMsg({ op: 'remove', index: 1 })).success).toBe(true);
    fireEvent.click(headBtn());
    expect(send).toHaveBeenLastCalledWith('edit_recipe_queue', queueMsg({ op: 'remove', index: 0 }));
  });

  it('a lone head with a plain count: a tap is one fewer, never below 1', () => {
    const send = seedShipyard(3);
    openProduction();
    fireEvent.click(headBtn());
    expect(send).toHaveBeenCalledWith('set_recipe', recipeMsg('build_interceptor', 2));
    cleanup();
    const send1 = seedShipyard(1);
    openProduction();
    fireEvent.click(headBtn());
    expect(send1).not.toHaveBeenCalled();
  });

  it('the repeat toggle sends repeat on / off; a plain forever count turns off as one build', () => {
    const send = seedShipyard(1, MIXED);
    openProduction();
    expect(screen.getByTestId('build-queue-forever')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('build-queue-forever'));
    expect(send).toHaveBeenCalledWith('edit_recipe_queue', queueMsg({ op: 'repeat', on: true }));
    expect(EditRecipeQueueSchema.safeParse(queueMsg({ op: 'repeat', on: true })).success).toBe(true);
    cleanup();
    const sendOn = seedShipyard(1, { ...MIXED, prodQueueRepeat: true });
    openProduction();
    expect(screen.getByTestId('build-queue-forever')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('build-queue-forever'));
    expect(sendOn).toHaveBeenCalledWith('edit_recipe_queue', queueMsg({ op: 'repeat', on: false }));
    cleanup();
    const send2 = seedShipyard(undefined);
    openProduction();
    expect(within(screen.getByTestId('build-queue-head')).getByTestId('hull-tile-badge')).toHaveTextContent('∞');
    expect(screen.getByTestId('build-queue-forever')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('build-queue-forever'));
    expect(send2).toHaveBeenCalledWith('set_recipe', recipeMsg('build_interceptor', 1));
    expect(SetRecipeSchema.safeParse(recipeMsg('build_interceptor', 1)).success).toBe(true);
  });

  it('a tile is locked when its blueprint is in neither the slot nor storage; Load stays under the grid', () => {
    seedShipyard(1, { bpProduct: null });
    openProduction();
    const tile = screen.getByTestId('build-tile-build_interceptor');
    expect(tile).toHaveAttribute('data-locked', '1');
    expect(within(tile).getByTestId('hull-tile-lock')).toBeInTheDocument();
    expect(screen.getByTestId('build-tile-build_gunship')).toHaveAttribute('data-locked', '1');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('None loaded');
    expect(screen.getByTestId('structure-action-load-blueprint')).toHaveTextContent('Load');
    cleanup();
    // Interceptor in the slot, gunship in storage: both unlocked; heavy still locked.
    seedShipyard(1, { bpRuns: 3, bpQuality: 2, bpProduct: 'build_interceptor', bpAvailable: ['build_gunship'] });
    openProduction();
    expect(screen.getByTestId('build-tile-build_interceptor')).toHaveAttribute('data-locked', '0');
    expect(screen.getByTestId('build-tile-build_gunship')).toHaveAttribute('data-locked', '0');
    expect(within(screen.getByTestId('build-tile-build_gunship')).queryByTestId('hull-tile-lock')).toBeNull();
    expect(screen.getByTestId('build-tile-build_heavy')).toHaveAttribute('data-locked', '1');
  });
});
