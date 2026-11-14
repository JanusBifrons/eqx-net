/**
 * Shared read model for the fleet panel (desktop) and strip (compact): the
 * selected ids from Zustand plus their live status rows (polled module
 * singleton) and names from the render mirror, recomputed only when the
 * selection or the status version changes.
 */
import { useMemo } from 'react';
import type { WingmanMode, WingmanStance } from '@core/ai/wingman/types';
import { useUIStore } from '../state/store.js';
import { getGameClient } from '../net/clientSingleton.js';
import { getFleetStatus, useFleetStatusVersion, type FleetStatusRow } from './fleetStatus.js';
import { describeActivity, fleetShipName, fleetTargetName, sharedValue } from './fleetView.js';
import { fleetCommands, type FleetCommands } from './fleetCommands.js';

export interface FleetShipView {
  id: string;
  name: string;
  hullPct: number | null;
  /** Shield 0..100, null until the server reports it. */
  shieldPct: number | null;
  activity: string;
}

export interface FleetSelectionView {
  /** True while the fleet UI should show (in game, command view, ≥ 1 selected). */
  active: boolean;
  ids: readonly string[];
  ships: readonly FleetShipView[];
  mode: WingmanMode | 'mixed' | null;
  stance: WingmanStance | 'mixed' | null;
  /** The squad every selected ship is in, 'mixed' when they differ, else null. */
  squadId: string | 'mixed' | null;
}

export function useFleetSelectionView(): FleetSelectionView {
  const ids = useUIStore((s) => s.fleetSelection);
  const inGame = useUIStore((s) => s.phase === 'game');
  const commandView = useUIStore((s) => s.pilotMode === 'spectator');
  const active = inGame && commandView && ids.length > 0;
  const version = useFleetStatusVersion(active);
  return useMemo(() => {
    const rows: (FleetStatusRow | undefined)[] = ids.map((id) => getFleetStatus(id));
    const mirror = getGameClient()?.mirror;
    const ships = ids.map((id, i) => {
      const row = rows[i];
      return {
        id,
        name: fleetShipName(mirror, id),
        hullPct: row ? Math.round(row.hullPct) : null,
        shieldPct: row?.shieldPct !== undefined ? Math.round(row.shieldPct) : null,
        activity: describeActivity(row, fleetTargetName(mirror, row?.targetId ?? null)),
      };
    });
    return {
      active,
      ids,
      ships,
      mode: sharedValue(rows.map((r) => r?.mode)),
      stance: sharedValue(rows.map((r) => r?.stance)),
      squadId: squadOf(rows),
    };
    // `version` is the poll signal: re-read the singleton when it moves.
  }, [ids, active, version]);
}

/** The squad all the rows share; 'mixed' if some are in a squad and not all the
 *  same one (or some are in none); null when no row is in a squad. */
function squadOf(rows: readonly (FleetStatusRow | undefined)[]): string | 'mixed' | null {
  const anyIn = rows.some((r) => r?.squadId !== undefined);
  if (!anyIn) return null;
  if (rows.some((r) => r?.squadId === undefined)) return 'mixed';
  return sharedValue(rows.map((r) => r?.squadId));
}

/** The command set in force, with optional per-component overrides (tests / hosts). */
export function resolveFleetCommands(overrides?: Partial<FleetCommands>): FleetCommands {
  return overrides ? { ...fleetCommands(), ...overrides } : fleetCommands();
}
