/**
 * Lock for "one place for building settings": the inspector's settings-type
 * buttons (recipe, blueprint slot, gate access) live in the cog window's tabs,
 * sending the same messages as before; the inspector's owner row keeps only
 * the cog and one-shot actions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { settingsTabsFor } from './StructureSettingsModal.js';
import { nextGateAccess } from './structureSettingsGate.js';
import { SetGateAccessSchema, SetRecipeSchema, LoadBlueprintSchema, UnloadBlueprintSchema } from '../../shared-types/messages.js';

/** The one-shot actions the inspector keeps beside the cog. */
const KEPT = new Set([
  'structure-action-settings', 'structure-action-deconstruct', 'structure-action-reconnect', 'structure-action-clear',
  'structure-action-repair-ship', 'structure-action-refine', 'structure-action-upgrade',
]);
const MOVED = ['structure-action-recipe', 'structure-action-gate-access', 'structure-action-load-blueprint', 'structure-action-unload-blueprint'];

/** Select my own built `kind` at entity 9 with extra slice fields; returns the room.send spy. */
function seed(kind: string, extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', ...extra }]]),
      swarm: new Map([[9, { kind: 2, shipKind: kind, radius: 60, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '9', name: 'Building', hp: 900, hpMax: 900 });
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' } });
  return send;
}

function openTab(tab: string): void {
  fireEvent.click(screen.getByTestId('structure-action-settings'));
  fireEvent.click(screen.getByTestId(`structure-settings-tab-${tab}`));
}

describe('building settings live in the cog window', () => {
  beforeEach(() => {
    // #1045 — building management (the cog) shows in Build mode only.
    useUIStore.setState({ buildMode: true, selection: { ids: [], focusId: null, focusKind: null } });
    resetSelectionStats();
  });
  afterEach(() => { setGameClient(null); });

  it.each([
    ['refinery', {}],
    ['fabricator', { bpRuns: 3, bpQuality: 2 }],
    ['shield_gate', {}],
  ])('the inspector shows only the cog and actions (%s)', (kind, extra) => {
    seed(kind, extra);
    render(<EntityStatsPanel />);
    const row = screen.getByTestId('entity-stats-actions');
    // MUI icons carry their own data-testid ("SettingsIcon"); count the buttons.
    const ids = [...row.querySelectorAll('button[data-testid]')].map((e) => e.getAttribute('data-testid')!);
    expect(ids[0]).toBe('structure-action-settings');
    for (const id of ids) expect(KEPT.has(id)).toBe(true);
    for (const id of MOVED) expect(within(row).queryByTestId(id)).toBeNull();
  });

  it('the recipe tab sends the same message as before', () => {
    const send = seed('refinery', { prodState: 1 });
    render(<EntityStatsPanel />);
    openTab('production');
    fireEvent.click(screen.getByTestId('structure-action-recipe'));
    // The old inspector button's message: next recipe (rock chunks -> ice), no count.
    const msg = { type: 'set_recipe', entityId: 9, recipe: 'refine_ice_fuel' };
    expect(send).toHaveBeenCalledWith('set_recipe', msg);
    expect(SetRecipeSchema.safeParse(msg).success).toBe(true);
  });

  it('a gate gets an Access tab that cycles who it opens for', () => {
    expect(settingsTabsFor('shield_gate').map((t) => t.id)).toEqual(['power', 'access']);
    expect(settingsTabsFor('shield_airlock').map((t) => t.id)).toEqual(['power', 'access']);
    const send = seed('shield_gate', { gateAccess: 1 });
    render(<EntityStatsPanel />);
    openTab('access');
    expect(screen.getByTestId('settings-gate-access')).toHaveTextContent('Owner only');
    fireEvent.click(screen.getByTestId('structure-action-gate-access'));
    const msg = { type: 'set_gate_access', entityId: 9, access: nextGateAccess('owner') };
    expect(send).toHaveBeenCalledWith('set_gate_access', msg);
    expect(SetGateAccessSchema.safeParse(msg).success).toBe(true);
  });

  it('the Production tab loads and unloads the blueprint', () => {
    const send = seed('fabricator', { bpRuns: 3, bpQuality: 2 });
    render(<EntityStatsPanel />);
    openTab('production');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('3 runs · quality 2');
    fireEvent.click(screen.getByTestId('structure-action-load-blueprint'));
    expect(send).toHaveBeenCalledWith('load_blueprint', { type: 'load_blueprint', entityId: 9 });
    expect(LoadBlueprintSchema.safeParse({ type: 'load_blueprint', entityId: 9 }).success).toBe(true);
    fireEvent.click(screen.getByTestId('structure-action-unload-blueprint'));
    expect(send).toHaveBeenCalledWith('unload_blueprint', { type: 'unload_blueprint', entityId: 9 });
    expect(UnloadBlueprintSchema.safeParse({ type: 'unload_blueprint', entityId: 9 }).success).toBe(true);
  });

  // Base-build film: a run is spent when a cycle STARTS, so a 2-run copy read
  // "1 run" right after Load while the yard went on to build two hulls.
  it('counts the build in progress in the runs left (tab and inspector)', () => {
    seed('fabricator', { bpRuns: 1, bpQuality: 1, prodState: 1, prodFrac: 0.2 });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-blueprint')).toHaveTextContent('BLUEPRINT 2 runs left (1 building) · quality 1');
    openTab('production');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('2 runs left (1 building) · quality 1');
  });

  it('an idle yard keeps the plain runs count', () => {
    seed('fabricator', { bpRuns: 2, bpQuality: 1, prodState: 2 });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-blueprint')).toHaveTextContent('BLUEPRINT 2 runs · quality 1');
    openTab('production');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('2 runs · quality 1');
  });

  // The server spends a copy's LAST run at cycle start and empties the slot;
  // while that last hull builds the line must not read as if the blueprint
  // vanished. The slot really is free, so Load stays and Unload/Swap do not.
  it('the last run building reads as building with a free slot (tab and inspector)', () => {
    seed('fabricator', { prodState: 1, prodFrac: 0.4 });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-blueprint')).toHaveTextContent('BLUEPRINT last run building · slot free');
    expect(screen.getByTestId('entity-stats-blueprint')).not.toHaveTextContent('NO BLUEPRINT LOADED');
    openTab('production');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('last run building · slot free');
    expect(screen.getByTestId('structure-action-load-blueprint')).toHaveTextContent('Load');
    expect(screen.queryByTestId('structure-action-unload-blueprint')).toBeNull();
  });

  it('an empty blueprint slot offers Load only', () => {
    seed('fabricator');
    render(<EntityStatsPanel />);
    openTab('production');
    expect(screen.getByTestId('settings-blueprint')).toHaveTextContent('None loaded');
    expect(screen.getByTestId('structure-action-load-blueprint')).toHaveTextContent('Load');
    expect(screen.queryByTestId('structure-action-unload-blueprint')).toBeNull();
  });
});
