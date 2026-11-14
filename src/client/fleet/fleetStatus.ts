/**
 * Live status of the local player's own ships (RTS command layer, slice 14).
 *
 * WHY A MODULE SINGLETON (mirrors `net/selectionStats.ts`): the server will
 * stream per-ship status rows (mode, stance, activity, hull...) a few times a
 * second for every owned ship. Routing those through Zustand would re-render
 * React on every row. Instead the (future) status-stream handler calls
 * {@link applyFleetStatus}, which mutates THIS map and bumps a version
 * counter; the fleet panel POLLS the counter ({@link useFleetStatusVersion},
 * ~3 Hz) and re-reads rows only when it moved. Only the selected ids
 * (`fleetSelection`) live in Zustand (#2). No positions here either.
 */
import { useEffect, useState } from 'react';
import type { WingmanActivity, WingmanMode, WingmanStance } from '@core/ai/wingman/types';

export type FleetOrderKind = 'move' | 'attack' | 'stop';

export interface FleetStatusRow {
  mode: WingmanMode;
  stance: WingmanStance;
  activity: WingmanActivity;
  /** The entity the ship is chasing / attacking / escorting, else null. */
  targetId: string | null;
  /** Hull, 0..100. */
  hullPct: number;
  /** Morale 0..100 when the brain reports it. */
  morale?: number;
  /** Squad the ship belongs to, when in one. */
  squadId?: string;
  /** Direct order in progress, when any. */
  orderKind?: FleetOrderKind;
  /** Move-order destination (world units), with `orderKind === 'move'`. */
  orderX?: number;
  orderY?: number;
  /** Patrol route waypoints, while patrolling. */
  route?: readonly (readonly [number, number])[];
  /** The ship being escorted, while escorting. */
  escortId?: string;
  /** The latest morale roll while it matters (FallBack / Flee = retreating). */
  moraleOutcome?: 'fightOn' | 'fallBack' | 'flee';
}

/** A status row as delivered by the stream: the row plus its ship id. */
export interface FleetStatusUpdate extends FleetStatusRow {
  id: string;
}

const rows = new Map<string, FleetStatusRow>();
let version = 0;

/**
 * Apply status rows. `replace: true` treats `updates` as the full owned-fleet
 * list (rows for ids not present are dropped); otherwise rows are upserted.
 * Bumps the version once per call that changed anything.
 */
export function applyFleetStatus(updates: readonly FleetStatusUpdate[], opts?: { replace?: boolean }): void {
  let changed = false;
  if (opts?.replace) {
    for (const id of rows.keys()) {
      if (!updates.some((u) => u.id === id)) {
        rows.delete(id);
        changed = true;
      }
    }
  }
  for (const u of updates) {
    const prev = rows.get(u.id);
    if (prev && sameRow(prev, u)) continue;
    rows.set(u.id, {
      mode: u.mode,
      stance: u.stance,
      activity: u.activity,
      targetId: u.targetId,
      hullPct: u.hullPct,
      ...(u.morale !== undefined ? { morale: u.morale } : {}),
      ...(u.squadId !== undefined ? { squadId: u.squadId } : {}),
      ...(u.orderKind !== undefined ? { orderKind: u.orderKind } : {}),
      ...(u.orderX !== undefined ? { orderX: u.orderX } : {}),
      ...(u.orderY !== undefined ? { orderY: u.orderY } : {}),
      ...(u.route !== undefined ? { route: u.route } : {}),
      ...(u.escortId !== undefined ? { escortId: u.escortId } : {}),
      ...(u.moraleOutcome !== undefined ? { moraleOutcome: u.moraleOutcome } : {}),
    });
    changed = true;
  }
  if (changed) version++;
}

function sameRow(a: FleetStatusRow, b: FleetStatusRow): boolean {
  return (
    a.mode === b.mode &&
    a.stance === b.stance &&
    a.activity === b.activity &&
    a.targetId === b.targetId &&
    a.hullPct === b.hullPct &&
    a.morale === b.morale &&
    a.squadId === b.squadId &&
    a.orderKind === b.orderKind &&
    a.orderX === b.orderX &&
    a.orderY === b.orderY &&
    a.escortId === b.escortId &&
    a.moraleOutcome === b.moraleOutcome &&
    sameRoute(a.route, b.route)
  );
}

function sameRoute(
  a: readonly (readonly [number, number])[] | undefined,
  b: readonly (readonly [number, number])[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

export function getFleetStatus(id: string): FleetStatusRow | undefined {
  return rows.get(id);
}

export function getFleetStatusVersion(): number {
  return version;
}

/** Visit every row (no allocation). */
export function forEachFleetStatus(visit: (id: string, row: FleetStatusRow) => void): void {
  for (const [id, row] of rows) visit(id, row);
}

/** Drop every row (room change / tests). */
export function resetFleetStatus(): void {
  if (rows.size > 0) {
    rows.clear();
    version++;
  }
}

/** Poll cadence of {@link useFleetStatusVersion} (~3 Hz). */
export const FLEET_STATUS_POLL_MS = 300;

/**
 * The fleet status version, re-read every {@link FLEET_STATUS_POLL_MS} while
 * `active`. Commits a React update only when the version moved.
 */
export function useFleetStatusVersion(active = true): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    if (!active) return;
    setV(version);
    const handle = window.setInterval(() => setV(version), FLEET_STATUS_POLL_MS);
    return () => window.clearInterval(handle);
  }, [active]);
  return v;
}
