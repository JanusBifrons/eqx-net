/**
 * The Orders panel's draft and Apply (UI language plan A4 / U3-5), split out
 * of `OrdersPanel.tsx`. A pick in the panel is a draft until Apply; Apply
 * sends only what changed, through the EXISTING paths: `resolveFleetCommands`
 * (`setStance`, `setMode`) and the Command speed (`chooseSpeed`, which also
 * re-paces the selection's running moves via `fleetCommands().setSpeed`).
 * Patrol / Escort / Retreat start the map pick (`setFleetPick`) instead of
 * sending, as the strip's fly-out does. Pure over its inputs (unit-tested).
 */
import { HELM_SPEED_FRACTION } from '@core/helm/helm';
import type { FleetMode, FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { useUIStore } from '../state/store.js';
import { fleetCommands, type FleetCommands } from '../fleet/fleetCommands.js';
import { modeNeedsPick } from '../fleet/fleetPickView.js';

export type SpeedStep = 0 | 1 | 2 | 3;

/** The speed telegraph's steps, Stop to Full (ids are the step index). */
export const SPEED_LABELS = ['Stop', '⅓', '⅔', 'Full'] as const;

/** Set the Command speed and re-pace the selection's running moves
 *  (Stop halts them where they are; they keep the point). Command only:
 *  the caller gates on `helmOrdersAllowed`. */
export function chooseSpeed(step: SpeedStep): void {
  const s = useUIStore.getState();
  s.setCommandSpeed(step);
  const ids = s.selection.ids;
  if (ids.length > 0) fleetCommands().setSpeed(ids, HELM_SPEED_FRACTION[step] ?? 1);
}

/** Unapplied picks; an absent field is untouched. */
export interface OrdersDraft {
  mode?: FleetMode;
  stance?: FleetStance;
  speed?: SpeedStep;
}

/** What is in force now (`null` = mixed or not reported yet). */
export interface OrdersApplied {
  mode: FleetMode | null;
  stance: FleetStance | null;
  speed: SpeedStep;
}

/** The draft's fields that differ from what is applied (speed only when `speedShown`). */
export function changedOrders(draft: OrdersDraft, applied: OrdersApplied, speedShown: boolean): OrdersDraft {
  const out: OrdersDraft = {};
  if (draft.mode !== undefined && draft.mode !== applied.mode) out.mode = draft.mode;
  if (draft.stance !== undefined && draft.stance !== applied.stance) out.stance = draft.stance;
  if (speedShown && draft.speed !== undefined && draft.speed !== applied.speed) out.speed = draft.speed;
  return out;
}

export interface ApplyHost {
  commands: FleetCommands;
  setPick: (kind: 'patrol' | 'escort' | 'retreat') => void;
  setSpeed: (step: SpeedStep) => void;
}

/** Send the changed orders for `ids`: stance and speed first, then the order
 *  (a map pick for Patrol / Escort / Retreat, else `setMode`). */
export function applyOrders(ids: readonly string[], changed: OrdersDraft, host: ApplyHost): void {
  if (changed.stance !== undefined) host.commands.setStance(ids, changed.stance);
  if (changed.speed !== undefined) host.setSpeed(changed.speed);
  const m = changed.mode;
  if (m === undefined) return;
  if (modeNeedsPick(m)) host.setPick(m);
  else host.commands.setMode(ids, m);
}
